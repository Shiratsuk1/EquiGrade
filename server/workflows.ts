import type {
  AnswerEvidence,
  AppliedDeduction,
  FinalAnswerJudgement,
  GradingResult,
  Rubric,
  RubricDecision,
  TeacherCommentary
} from "../shared/types.js";
import { calculateGrade, createFallbackTeacherCommentary, normalizeEvidenceReferences, TEACHER_COMMENTARY_VERSION } from "./gradingEngine.js";
import { callStructured } from "./modelClient.js";
import {
  evidenceJsonSchema,
  evidenceSchema,
  finalAnswerJudgementsJsonSchema,
  finalAnswerJudgementsSchema,
  processJudgementJsonSchema,
  processJudgementSchema,
  assertRubricIntegrity,
  rubricJsonSchema,
  rubricSchema,
  teacherCommentaryJsonSchema,
  teacherCommentarySchema,
  validateRubricTotals
} from "./schemas.js";
import type { ModelConfigInput } from "../shared/types.js";
import { beginOperation, completeOperation, failOperation, logProgress } from "./systemLog.js";

export async function structureRubric(config: ModelConfigInput, input: {
  questionText: string;
  referenceText: string;
  questionImages: Express.Multer.File[];
  referenceImages: Express.Multer.File[];
}): Promise<Rubric> {
  const operationId = beginOperation("rubric", "开始生成结构化评分标准", "prepare_materials", {
    questionImages: input.questionImages.length,
    referenceImages: input.referenceImages.length,
    questionCharacters: input.questionText.length,
    referenceCharacters: input.referenceText.length
  });
  const images = [
    ...input.questionImages.map((file, index) => ({
      mimeType: file.mimetype,
      base64: file.buffer.toString("base64"),
      label: `[题目图片 ${index + 1}：${file.originalname}]`
    })),
    ...input.referenceImages.map((file, index) => ({
      mimeType: file.mimetype,
      base64: file.buffer.toString("base64"),
      label: `[参考答案图片 ${index + 1}：${file.originalname}]`
    }))
  ];
  try {
    const model = images.length ? config.visionModel : config.textModel;
    logProgress(operationId, "model", "rubric_model_call", "已发送材料，等待模型读取题目并结构化评分标准", {
      model,
      imageCount: images.length
    });
    const result = await callStructured<unknown>(config, {
      model,
      system: "你是评分标准结构化工具。只能忠实转录和转换输入文档，不得自行解题、补充得分点或改变分值。输出必须符合JSON结构。",
      prompt: `将以下高中物理题目和参考评分标准拆成原子评分规则。紧随题目文字之后的图片属于题目，标记为参考答案图片的内容只属于参考答案。必须读取图中的物理量标注、方向和几何关系，但不得自行补充图中不存在的信息。请把完整题干忠实转录到recognizedQuestionText；其中行内公式使用$...$，独立公式使用$$...$$，保留题号、小问、单位和图示引用。无法辨认的部分写作[无法辨认]并加入warnings，禁止猜测。每个finalAnswers对象必须表示一套完整可接受的最终答案；一道小问要求多个物理量时，把多个等式放在同一个expression中并分别使用$...$分隔。最终答案正确允许省略过程时标记full_credit；文档未明确的信息写入warnings。\n\n题目：\n${input.questionText}\n\n参考答案与评分标准：\n${input.referenceText}`,
      images,
      schemaName: "physics_rubric",
      schema: rubricJsonSchema
    });
    logProgress(operationId, "rubric", "rubric_validation", "模型响应已返回，正在校验字段和分值合计", {
      durationMs: result.durationMs,
      outputMode: result.outputMode
    });
    const parsedRubric = rubricSchema.parse(result.data);
    const rubric = validateRubricTotals({
      ...parsedRubric,
      status: "draft" as const,
      version: 1,
      subquestions: parsedRubric.subquestions.map((subquestion) => ({
        ...subquestion,
        finalAnswerPolicy: "full_credit" as const
      }))
    });
    completeOperation(operationId, "rubric", "rubric_ready", "结构化评分标准草稿已生成", {
      title: rubric.title,
      subquestions: rubric.subquestions.length,
      scorePoints: rubric.subquestions.reduce((sum, item) => sum + item.scorePoints.length, 0),
      warnings: rubric.warnings.length
    });
    return rubric;
  } catch (error) {
    failOperation(operationId, "rubric", "rubric_failed", error);
    throw error;
  }
}

async function generateTeacherCommentary(config: ModelConfigInput, result: GradingResult, operationId: string): Promise<{ commentary: TeacherCommentary; durationMs: number }> {
  const model = config.textModel || config.visionModel;
  const decisionIds = result.subquestions.flatMap((item) => item.decisions.map((decision) => item.id + ":" + decision.pointId));
  logProgress(operationId, "model", "teacher_commentary", "正在根据评分证据生成教师评语", {
    model,
    score: result.score,
    maxScore: result.maxScore
  });
  try {
    const response = await callStructured<unknown>(config, {
      model,
      system: "你是高中物理教师评语生成器。只能总结已提供的结构化评分结果和卷面证据，不得重新解题、创造评分点、修改任何分数或把证据不足描述为确定错误。最终答案正确的小问即使存在过程审验问题，也不得描述为失分；只能写成过程审验提醒或待复核项。所有失分点必须引用已有的小问ID、评分点ID和卷面行号。输出必须是JSON。",
      prompt: "请为这份高中物理答卷生成简洁、客观、可供教师直接查看的评语。" +
        "\n\n硬性要求：" +
        "\n1. overallComment总结已确认得分和待复核分值；如果maximumPossibleScore大于score，必须明确说明当前分数是下限而不是最终成绩，不得重新计算分数。" +
        "\n2. strengths只引用已满足的评分点或教师模型确认正确的最终答案。" +
        "\n3. lostPoints只列出实际 awardedScore 小于 maxScore 且明确未满足的评分点；最终答案正确的小问不得列为失分。" +
        "\n4. auditConcerns列出过程审验中的明确问题或证据不足项。最终答案正确时，这些只能是复核提醒，不能写成扣分。" +
        "\n5. reviewItems只总结已有的人工复核原因，不得新增风险。" +
        "\n6. basedOnDecisionIds只能使用已有的：" + decisionIds.join("、") + "。" +
        "\n\n结构化评分结果：\n" +
        JSON.stringify({ score: result.score, maximumPossibleScore: result.maximumPossibleScore, maxScore: result.maxScore, reviewReasons: result.reviewReasons, subquestions: result.subquestions, evidenceLines: result.evidence.lines }, null, 2),
      schemaName: "teacher_commentary",
      schema: teacherCommentaryJsonSchema
    });
    const parsed = teacherCommentarySchema.parse(response.data);
    const decisions = result.subquestions.flatMap((subquestion) =>
      subquestion.decisions.map((decision) => ({ subquestion, decision }))
    );
    const decisionById = new Map(decisions.map(({ subquestion, decision }) => [
      `${subquestion.id}:${decision.pointId}`,
      { subquestion, decision }
    ]));
    const validDecisionIds = new Set(decisionById.keys());
    const basedOnDecisionIds = parsed.basedOnDecisionIds.filter((id) => validDecisionIds.has(id));
    const lostPoints = parsed.lostPoints.flatMap((item) => {
      const matched = decisionById.get(`${item.subquestionId}:${item.pointId}`);
      if (!matched || matched.decision.status !== "not_satisfied" || matched.decision.awardedScore >= matched.decision.maxScore) {
        return [];
      }
      return [{
        subquestionId: matched.subquestion.id,
        pointId: matched.decision.pointId,
        scoreLost: Math.min(item.scoreLost, matched.decision.maxScore - matched.decision.awardedScore),
        reason: matched.decision.reason,
        evidenceLineIds: matched.decision.evidenceLineIds
      }];
    });
    const auditConcerns = parsed.auditConcerns.flatMap((item) => {
      const matched = decisionById.get(`${item.subquestionId}:${item.pointId ?? ""}`);
      if (!matched || (matched.decision.status !== "not_satisfied" && matched.decision.status !== "insufficient_evidence")) {
        return [];
      }
      return [{
        subquestionId: matched.subquestion.id,
        pointId: matched.decision.pointId,
        kind: matched.decision.status === "insufficient_evidence" ? "uncertain_evidence" as const : "confirmed_issue" as const,
        reason: matched.decision.reason,
        evidenceLineIds: matched.decision.evidenceLineIds
      }];
    });
    return {
      commentary: {
        ...parsed,
        basedOnDecisionIds,
        lostPoints,
        auditConcerns,
        reviewItems: result.reviewReasons,
        status: "completed",
        modelName: model,
        version: TEACHER_COMMENTARY_VERSION
      },
      durationMs: response.durationMs
    };
  } catch (error) {
    const fallback = createFallbackTeacherCommentary(result);
    fallback.modelName = model;
    logProgress(operationId, "grading", "teacher_commentary_fallback", "教师评语模型调用失败，已使用结构化降级评语：" + (error instanceof Error ? error.message : String(error)), {
      model,
      commentaryVersion: TEACHER_COMMENTARY_VERSION
    }, "warning");
    return { commentary: fallback, durationMs: 0 };
  }
}

export async function gradeStudentAnswer(config: ModelConfigInput, input: {
  id: string;
  studentId: string;
  fileName: string;
  mimeType: string;
  imageBuffer: Buffer;
  rubric: Rubric;
  previousResultId?: string;
  regradedAt?: string;
  regradeReason?: string;
}): Promise<{ result: GradingResult; operationId: string }> {
  const operationId = beginOperation("grading", `开始批改 ${input.studentId}`, "extract_answer", {
    studentId: input.studentId,
    fileName: input.fileName,
    rubricVersion: input.rubric.version
  });
  const image = { mimeType: input.mimeType, base64: input.imageBuffer.toString("base64") };
  try {
    assertRubricIntegrity(input.rubric);
    logProgress(operationId, "model", "extract_answer", "正在调用多模态模型提取卷面证据", { model: config.visionModel });
    const extraction = await callStructured<unknown>(config, {
    model: config.visionModel,
    system: "你只负责忠实转录学生卷面，不得评分，不得根据正确解法补全、纠正或美化学生内容。模糊内容必须给出候选并降低置信度。划去内容必须标记。",
    prompt: `提取这份学生作答的所有有效行、公式、卷面位置、涂改状态和最终答案候选。评分标准中的小问ID如下：${input.rubric.subquestions.map((item) => item.id).join(", ")}。坐标使用原图像素坐标。表达式尽量使用可解析的普通代数形式，保留原始LaTeX。`,
    images: [{ ...image, label: "[学生作答图片]" }],
    schemaName: "answer_evidence",
    schema: evidenceJsonSchema
    });
    const evidence: AnswerEvidence = normalizeEvidenceReferences(evidenceSchema.parse(extraction.data));
    logProgress(operationId, "grading", "evidence_ready", "卷面证据提取完成", {
      lines: evidence.lines.length,
      finalAnswers: evidence.finalAnswers.length,
      ambiguities: evidence.ambiguities.length,
      durationMs: extraction.durationMs
    });

    logProgress(operationId, "model", "verify_final_answers", "正在调用教师模型独立判定各小问最终答案", {
      model: config.visionModel,
      subquestions: input.rubric.subquestions.map((item) => item.id)
    });
    const finalAnswerResponse = await callStructured<unknown>(config, {
      model: config.visionModel,
      system: `你是高中物理教师判分模型，只负责判断每个小问的最终答案是否正确。你的最终答案判断是本次评分的权威结论。

严格比较学生实际写出的最终答案与锁定评分标准中的允许答案。接受代数等价、根式等价、分数等价、单位换算、变量大小写或命名差异、多个结果顺序变化，以及学生明确说明的方向变化。最终答案包括大小、方向、单位和题目要求的全部结果。

不得因为中间过程缺失或模糊而否定正确的最终答案。不得根据你自己求解题目得到的结果修改学生答案或参考答案。确定没有最终答案时返回missing；图像、转录或含义无法可靠确认时返回uncertain，不得把证据不足直接判为incorrect。confidence表示你对当前结论可靠程度的估计，不表示结论方向；置信度不足时应返回uncertain。correct或incorrect必须引用至少一条实际且未划掉的卷面行。每个小问必须恰好返回一条finalAnswerJudgement，并引用实际卷面行号。`,
      prompt: `请对锁定评分标准中的每个小问独立判定最终答案。你必须同时核对学生原图与卷面转录；转录只是辅助证据，原图可以纠正转录遗漏，但不得补写学生没有写出的内容。

锁定题目与评分标准：
${JSON.stringify(input.rubric)}

卷面转录与最终答案候选：
${JSON.stringify(evidence)}`,
      images: [{ ...image, label: "[学生作答原图]" }],
      schemaName: "final_answer_judgements",
      schema: finalAnswerJudgementsJsonSchema
    });
    const parsedFinalAnswers = finalAnswerJudgementsSchema.parse(finalAnswerResponse.data);
    const knownSubquestions = new Set(input.rubric.subquestions.map((item) => item.id));
    const seenSubquestions = new Set<string>();
    const finalAnswerJudgements: FinalAnswerJudgement[] = parsedFinalAnswers.finalAnswerJudgements.filter((item) => {
      if (!knownSubquestions.has(item.subquestionId) || seenSubquestions.has(item.subquestionId)) return false;
      seenSubquestions.add(item.subquestionId);
      return true;
    });
    const missingJudgementIds = input.rubric.subquestions
      .map((item) => item.id)
      .filter((id) => !seenSubquestions.has(id));
    logProgress(operationId, "grading", "final_answers_ready", "教师模型最终答案判定完成", {
      durationMs: finalAnswerResponse.durationMs,
      judgements: finalAnswerJudgements.map((item) => ({
        subquestionId: item.subquestionId,
        status: item.status,
        confidence: item.confidence,
        reason: item.reason
      })),
      missingJudgementIds
    }, missingJudgementIds.length ? "warning" : "success");

    const processSubquestionIds = input.rubric.subquestions.map((item) => item.id);
    let decisions: RubricDecision[] = [];
    let appliedDeductions: AppliedDeduction[] = [];
    let processDurationMs = 0;
    let processAuditError: string | null = null;
    const processRubric: Rubric = input.rubric;
    logProgress(operationId, "model", "judge_rubric_points", "正在对所有小问的每个评分点执行过程审验", {
      model: config.visionModel,
      subquestions: processSubquestionIds,
      finalAnswerCorrectStillAudited: true
    });
    try {
      const processResponse = await callStructured<unknown>(config, {
        model: config.visionModel,
        system: "你是受约束的评分点过程审验器。严格依据给定评分标准和卷面证据判断每一个评分点，不得自行解题或创造规则。最终答案状态由上一步教师模型权威确定，你不得修改它。即使最终答案状态为correct，也必须逐点评审并返回审验结论。你不能决定最终得分。明确满足且有清晰有效卷面证据时返回satisfied，明确未满足且有清晰有效卷面证据时返回not_satisfied，因字迹、涂改、置信度不足或证据不足无法确认返回insufficient_evidence并要求复核。confidence表示判断可靠程度，不是正确或错误标签。核心公式正确时应判为satisfied，即使后续计算错误；同一错误不得重复触发扣分。",
        prompt: `必须判断锁定评分标准中的每一个评分点：${processSubquestionIds.join(", ")}。最终答案正确的小问也不能跳过。审验结果只用于展示、复核和非正确最终答案的计分分支；如果最终答案为correct，任何过程问题都不能降低该小问最终得分。

待判断评分标准：
${JSON.stringify(processRubric)}

教师模型最终答案结论（仅供分支和解释，不得修改）：
${JSON.stringify(finalAnswerJudgements)}

卷面转录：
${JSON.stringify(evidence)}`,
        images: [{ ...image, label: "[学生作答原图]" }],
        schemaName: "process_point_judgement",
        schema: processJudgementJsonSchema
      });
      const parsedProcess = processJudgementSchema.parse(processResponse.data);
      decisions = parsedProcess.decisions.filter((item) => processSubquestionIds.includes(item.subquestionId));
      appliedDeductions = parsedProcess.appliedDeductions.filter((item) => processSubquestionIds.includes(item.subquestionId));
      processDurationMs = processResponse.durationMs;
      logProgress(operationId, "grading", "process_audit_ready", "所有小问的评分点过程审验完成，进入确定性计分", {
        subquestions: processSubquestionIds,
        decisions: decisions.length,
        deductions: appliedDeductions.length,
        durationMs: processResponse.durationMs,
        finalAnswerCorrectStillAudited: true
      });
    } catch (error) {
      processAuditError = error instanceof Error ? error.message : String(error);
      logProgress(operationId, "grading", "process_audit_failed", "过程审验模型调用失败，缺失评分点将进入人工复核且不因不确定证据扣分", {
        error: processAuditError,
        subquestions: processSubquestionIds
      }, "warning");
    }

    const result = calculateGrade({
      id: input.id,
      studentId: input.studentId,
      fileName: input.fileName,
      rubric: input.rubric,
      evidence,
      finalAnswerJudgements,
      decisions,
      appliedDeductions,
      modelName: config.visionModel,
      durationMs: extraction.durationMs + finalAnswerResponse.durationMs + processDurationMs,
      operationId,
      previousResultId: input.previousResultId,
      regradedAt: input.regradedAt,
      regradeReason: input.regradeReason
    });
    if (processAuditError) {
      result.reviewReasons = [...new Set([...result.reviewReasons, `过程审验模型调用失败：${processAuditError}`])];
      result.status = "needs_review";
    }
    const commentaryResult = await generateTeacherCommentary(config, result, operationId);
    result.teacherCommentary = commentaryResult.commentary;
    result.metrics.durationMs += commentaryResult.durationMs;
    logProgress(operationId, "grading", "teacher_commentary_ready", commentaryResult.commentary.status === "completed" ? "教师模型评语生成完成" : "已使用结构化降级评语", {
      status: commentaryResult.commentary.status,
      version: commentaryResult.commentary.version,
      model: commentaryResult.commentary.modelName,
      durationMs: commentaryResult.durationMs,
      lostPoints: commentaryResult.commentary.lostPoints.length,
      auditConcerns: commentaryResult.commentary.auditConcerns.length
    }, commentaryResult.commentary.status === "completed" ? "success" : "warning");
    completeOperation(operationId, "grading", "grading_completed", `${input.studentId}批改完成：${result.score}${(result.maximumPossibleScore ?? result.score) > result.score ? `-${result.maximumPossibleScore}` : ""}/${result.maxScore}分`, {
      status: result.status,
      reviewReasons: result.reviewReasons.length,
      commentaryStatus: result.teacherCommentary.status
    });
    return { result, operationId };
  } catch (error) {
    failOperation(operationId, "grading", "grading_failed", error, { studentId: input.studentId });
    throw error;
  }
}
