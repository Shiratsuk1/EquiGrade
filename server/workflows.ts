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
  directVisionGradeJsonSchema,
  directVisionGradeSchema,
  finalAnswerJudgementsJsonSchema,
  finalAnswerJudgementsSchema,
  processJudgementWithCommentaryJsonSchema,
  processJudgementWithCommentarySchema,
  assertRubricIntegrity,
  rubricJsonSchema,
  rubricSchema,
  validateRubricTotals
} from "./schemas.js";
import type { GradingMode, ModelConfigInput } from "../shared/types.js";
import { DEFAULT_GRADING_MODE } from "../shared/types.js";
import { beginOperation, completeOperation, failOperation, logProgress } from "./systemLog.js";

interface GradingImage {
  mimeType: string;
  base64: string;
  label?: string;
}

interface StudentAnswerGradingInput {
  id: string;
  studentId: string;
  fileName: string;
  mimeType: string;
  imageBuffer: Buffer;
  rubric: Rubric;
  questionText?: string;
  referenceText?: string;
  questionImages?: GradingImage[];
  referenceImages?: GradingImage[];
  previousResultId?: string;
  regradedAt?: string;
  regradeReason?: string;
}

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
      prompt: `将以下高中物理题目和参考评分标准拆成原子评分规则。紧随题目文字之后的图片属于题目，标记为参考答案图片的内容只属于参考答案。必须读取图中的物理量标注、方向和几何关系，但不得自行补充图中不存在的信息。请把完整题干忠实转录到recognizedQuestionText；其中行内公式使用$...$，独立公式使用$$...$$，保留题号、小问、单位和图示引用。无法辨认的部分写作[无法辨认]并加入warnings，禁止猜测。每个finalAnswers对象必须表示一套完整可接受的最终答案；一道小问要求多个物理量时，把多个等式放在同一个expression中并分别使用$...$分隔。本系统规定：最终答案经教师模型确认正确时，该小问过程审验不得降低得分，因此所有小问的finalAnswerPolicy统一标记为full_credit；仍须完整保留过程评分点，用于最终答案错误、缺失或无法确认时计分，并用于审计和复核。文档未明确的信息写入warnings。\n\n题目：\n${input.questionText}\n\n参考答案与评分标准：\n${input.referenceText}`,
      images,
      schemaName: "physics_rubric",
      schema: rubricJsonSchema,
      validate: (value) => rubricSchema.parse(value),
      operationId
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

type TeacherCommentaryDraft = Omit<TeacherCommentary, "status" | "modelName" | "version">;

function finalizeTeacherCommentary(
  draft: TeacherCommentaryDraft | undefined,
  result: GradingResult,
  model: string
): TeacherCommentary {
  if (!draft) {
    const fallback = createFallbackTeacherCommentary(result);
    fallback.modelName = model;
    return fallback;
  }
  const canonical = createFallbackTeacherCommentary(result);
  return {
    ...draft,
    overallComment: draft.overallComment.trim() || canonical.overallComment,
    strengths: draft.strengths.length ? draft.strengths : canonical.strengths,
    basedOnDecisionIds: canonical.basedOnDecisionIds,
    lostPoints: canonical.lostPoints,
    auditConcerns: canonical.auditConcerns,
    reviewItems: canonical.reviewItems,
    status: "completed",
    modelName: model,
    version: TEACHER_COMMENTARY_VERSION
  };
}

async function gradeStudentAnswerDirect(
  config: ModelConfigInput,
  input: StudentAnswerGradingInput,
  operationId: string,
  image: GradingImage
): Promise<GradingResult> {
  const contextImages: GradingImage[] = [
    ...(input.questionImages ?? []),
    ...(input.referenceImages ?? []),
    { ...image, label: "[学生答卷原图]" }
  ];
  const questionIds = input.rubric.subquestions.map((item) => item.id);
  const pointKeys = new Set(input.rubric.subquestions.flatMap((subquestion) => subquestion.scorePoints.map((point) => `${subquestion.id}:${point.id}`)));
  const deductionKeys = new Set(input.rubric.subquestions.flatMap((subquestion) => subquestion.deductions.map((deduction) => `${subquestion.id}:${deduction.id}`)));
  logProgress(operationId, "model", "vision_direct_grade", "正在让教师模型直接查看题目、评分标准和学生答卷图片并完成逐点评分", {
    model: config.visionModel,
    gradingMode: "vision_direct",
    reasoningEffort: config.teacherReasoningEffort ?? "disabled",
    questionImages: input.questionImages?.length ?? 0,
    referenceImages: input.referenceImages?.length ?? 0,
    studentImages: 1
  });

  const response = await callStructured<unknown>(config, {
    model: config.visionModel,
    system: `你是高中物理教师阅卷模型，必须直接查看输入的题目图片、参考答案与评分标准图片、学生答卷原图，依据锁定评分标准给出结构化阅卷结果。锁定评分标准 JSON 是唯一的计分依据和分值来源；题图与参考答案图只能用于理解题干、图示和已锁定的上下文，不能改变评分点、分值、接受条件或扣分规则。你是最终答案判断的唯一权威，不得调用或假设任何外部 OCR 结果，也不得先自行解题再替换评分标准。

严格规则：
1. 逐页查看所有图片，题目图片、参考答案图片和学生答卷图片必须区分。只根据锁定评分标准评分，不得自行增加得分点、扣分点或接受标准中没有依据的等价形式。
2. 每个小问必须返回且只能返回一条 finalAnswerJudgement。最终答案为 correct 时，按评分标准的 full_credit 规则给该小问满分；过程仍必须逐点评审，但过程问题不能降低该小问得分。最终答案为 incorrect、missing 或 uncertain 时，严格按评分点和扣分规则计分。
3. 每个评分点必须返回且只能返回一条 decision。核心公式正确时判 satisfied，即使后续计算错误；计算错误只影响对应结果评分点。单位、方向、符号和重复错误必须按评分标准处理，不能重复扣分。
4. 无法辨认时返回 unreadable，不得猜测；没有出现相关作答时返回 not_present，不得把未作答统一写成 unreadable。unreadable 的最终复核由系统按实际影响分值和教师设置的阈值处理。
5. evidence 不是整页 OCR 转录，只返回支持判断所必需的最小卷面证据。每条证据必须是学生原图中确实存在的可定位片段，使用唯一 line id；能提供位置时 region 使用原图像素坐标 [x,y,width,height]。不要为了填充字段臆造文字或公式。
6. correct、incorrect、satisfied、not_satisfied 和 appliedDeductions 必须引用至少一条有效的 active 证据行；unreadable 应引用对应的 uncertain 证据行；missing 或 not_present 可以不引用。所有引用的 line id 必须出现在 evidence.lines 中。
7. 在同一次响应中生成 teacherCommentary。评语只能总结本次返回的 finalAnswerJudgements、decisions 和卷面证据，不得重新解题、修改分数或创造评分点。最终答案正确且触发满分的小问，过程问题只能列入 auditConcerns，不能列入 lostPoints。lostPoints 和 auditConcerns 必须引用本次返回的评分点 ID 与证据行号；overallComment 不写具体总分，由本地计分引擎补充展示。
8. 只输出符合 JSON Schema 的对象，不输出 Markdown、解释性前缀或隐藏推理过程。reason、evidenceQuote 和评语只写简短、可审计的判分依据。

数学公式可以使用 LaTeX，但必须遵守系统附加的安全公式块协议。`,
    prompt: `请直接根据图片完成整份物理答卷批改。不要输出完整 OCR，只输出用于审计的最小证据片段。

题目文字（可能为空，题图可补足图示；计分仍以锁定评分标准 JSON 为准）：
${input.questionText?.trim() || "题目内容见题目图片"}

参考答案和评分标准文字（可能为空，参考答案图仅作上下文核对；计分仍以锁定评分标准 JSON 为准）：
${input.referenceText?.trim() || "参考答案与评分标准见参考答案图片"}

锁定评分标准 JSON：
${JSON.stringify(input.rubric)}

必须覆盖的小问：${questionIds.join("、")}
必须覆盖的评分点：${[...pointKeys].join("、") || "无"}
允许使用的扣分规则：${[...deductionKeys].join("、") || "无"}`,
    images: contextImages,
    schemaName: "direct_vision_grading",
    schema: directVisionGradeJsonSchema,
    validate: (value) => directVisionGradeSchema.parse(value),
    reasoningEffort: config.teacherReasoningEffort,
    operationId
  });
  const parsed = directVisionGradeSchema.parse(response.data);
  const evidence: AnswerEvidence = normalizeEvidenceReferences(parsed.evidence);
  const seenSubquestions = new Set<string>();
  const finalAnswerJudgements: FinalAnswerJudgement[] = parsed.finalAnswerJudgements.filter((item) => {
    if (!questionIds.includes(item.subquestionId) || seenSubquestions.has(item.subquestionId)) return false;
    seenSubquestions.add(item.subquestionId);
    return true;
  });
  const seenPoints = new Set<string>();
  const decisions: RubricDecision[] = parsed.decisions.filter((item) => {
    const key = `${item.subquestionId}:${item.pointId}`;
    if (!pointKeys.has(key) || seenPoints.has(key)) return false;
    seenPoints.add(key);
    return true;
  });
  const seenDeductions = new Set<string>();
  const appliedDeductions: AppliedDeduction[] = parsed.appliedDeductions.filter((item) => {
    const key = `${item.subquestionId}:${item.ruleId}`;
    if (!deductionKeys.has(key) || seenDeductions.has(key)) return false;
    seenDeductions.add(key);
    return true;
  });
  const missingFinalAnswers = questionIds.filter((id) => !seenSubquestions.has(id));
  const missingPoints = [...pointKeys].filter((key) => !seenPoints.has(key));
  logProgress(operationId, "grading", "vision_direct_result_ready", "教师模型直批结果已返回，正在进入确定性计分和复核阈值聚合", {
    durationMs: response.durationMs,
    evidenceLines: evidence.lines.length,
    finalAnswers: finalAnswerJudgements.length,
    decisions: decisions.length,
    deductions: appliedDeductions.length,
    missingFinalAnswers,
    missingPoints
  }, missingFinalAnswers.length || missingPoints.length ? "warning" : "success");

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
    gradingMode: "vision_direct",
    evidenceValidationMode: "direct_visual",
    durationMs: response.durationMs,
    unreadableReviewThreshold: config.unreadableReviewThreshold,
    operationId,
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason
  });
  result.teacherCommentary = finalizeTeacherCommentary(parsed.teacherCommentary, result, config.visionModel);
  logProgress(operationId, "grading", "teacher_commentary_ready", "教师评语已随视觉直批结果一并生成并完成本地校验", {
    status: result.teacherCommentary.status,
    version: result.teacherCommentary.version,
    model: result.teacherCommentary.modelName,
    integratedModelCall: true
  }, "success");
  completeOperation(operationId, "grading", "grading_completed", `${input.studentId}直批完成：${result.score}/${result.maxScore}分`, {
    status: result.status,
    gradingMode: "vision_direct",
    reviewReasons: result.reviewReasons.length,
    commentaryStatus: result.teacherCommentary.status
  });
  return result;
}

export async function gradeStudentAnswer(config: ModelConfigInput, input: StudentAnswerGradingInput): Promise<{ result: GradingResult; operationId: string }> {
  const gradingMode: GradingMode = config.gradingMode ?? DEFAULT_GRADING_MODE;
  const operationId = beginOperation("grading", `开始批改 ${input.studentId}`, gradingMode === "vision_direct" ? "vision_direct_grade" : "extract_answer", {
    studentId: input.studentId,
    fileName: input.fileName,
    rubricVersion: input.rubric.version,
    gradingMode
  });
  const image = { mimeType: input.mimeType, base64: input.imageBuffer.toString("base64") };
  try {
    assertRubricIntegrity(input.rubric);
    if (gradingMode === "vision_direct") {
      const result = await gradeStudentAnswerDirect(config, input, operationId, image);
      return { result, operationId };
    }
    logProgress(operationId, "model", "extract_answer", "正在调用多模态模型提取卷面证据", { model: config.visionModel });
    const extraction = await callStructured<unknown>(config, {
    model: config.visionModel,
    system: "你只负责忠实转录学生卷面，不得评分，不得根据正确解法补全、纠正或美化学生内容。模糊内容必须给出候选并降低置信度。划去内容必须标记。",
    prompt: `提取这份学生作答的所有有效行、公式、卷面位置、涂改状态和最终答案候选。评分标准中的小问ID如下：${input.rubric.subquestions.map((item) => item.id).join(", ")}。坐标使用原图像素坐标。表达式尽量使用可解析的普通代数形式，保留原始LaTeX。`,
    images: [{ ...image, label: "[学生作答图片]" }],
    schemaName: "answer_evidence",
    schema: evidenceJsonSchema,
    validate: (value) => evidenceSchema.parse(value),
    operationId
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
      reasoningEffort: config.teacherReasoningEffort ?? "disabled",
      subquestions: input.rubric.subquestions.map((item) => item.id)
    });
    const finalAnswerResponse = await callStructured<unknown>(config, {
      model: config.visionModel,
      system: `你是高中物理教师判分模型，只负责判断每个小问的最终答案是否正确。你的最终答案判断是本次评分的权威结论。

严格比较学生实际写出的最终答案与锁定评分标准中的允许答案。接受代数等价、根式等价、分数等价、单位换算、变量大小写或命名差异、多个结果顺序变化，以及学生明确说明的方向变化。最终答案包括大小、方向、单位和题目要求的全部结果。

不得因为中间过程缺失而否定已经清晰写出的正确最终答案。不得根据你自己求解题目得到的结果修改学生答案或参考答案。没有清晰、未划掉的最终答案时返回missing，evidenceLineIds应为空；只有在卷面上确实存在疑似最终答案、但字迹或含义无法可靠确认时才返回uncertain，并引用相关卷面行。已经划掉的数值、公式或结论不能作为最终答案。confidence表示你对当前状态判断的可靠程度，不表示结论方向。correct或incorrect必须引用至少一条实际、未划掉且可识别的卷面行。每个小问必须恰好返回一条finalAnswerJudgement。`,
      prompt: `请对锁定评分标准中的每个小问独立判定最终答案。你必须同时核对学生原图与卷面转录；转录只是辅助证据，原图可以纠正转录遗漏，但不得补写学生没有写出的内容。

锁定题目与评分标准：
${JSON.stringify(input.rubric)}

卷面转录与最终答案候选：
${JSON.stringify(evidence)}`,
      images: [{ ...image, label: "[学生作答原图]" }],
      schemaName: "final_answer_judgements",
      schema: finalAnswerJudgementsJsonSchema,
      validate: (value) => finalAnswerJudgementsSchema.parse(value),
      reasoningEffort: config.teacherReasoningEffort,
      operationId
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
    let teacherCommentaryDraft: TeacherCommentaryDraft | undefined;
    let processDurationMs = 0;
    let processAuditError: string | null = null;
    const processRubric: Rubric = input.rubric;
    logProgress(operationId, "model", "judge_rubric_points", "正在对所有小问的每个评分点执行过程审验", {
      model: config.visionModel,
      reasoningEffort: config.teacherReasoningEffort ?? "disabled",
      subquestions: processSubquestionIds,
      finalAnswerCorrectStillAudited: true
    });
    try {
      const processResponse = await callStructured<unknown>(config, {
        model: config.visionModel,
        system: `你是受约束的评分点过程审验器。严格依据给定评分标准和卷面证据判断每一个评分点，不得自行解题、补写学生没有写出的内容或创造规则。最终答案状态由上一步教师模型确定，你不得修改它。即使最终答案状态为correct，也必须逐点评审并返回审验结论。你不能决定最终得分。

每个评分点只能使用以下状态：
- satisfied：存在清晰、未划掉、可识别的有效卷面证据，且明确满足评分点；requiresReview=false。
- not_satisfied：存在清晰有效证据，但内容明确错误或不满足评分点；requiresReview=false。
- not_present：有效卷面中没有出现评分点要求的公式、关系、物理量或结论，或者只出现了已经划掉的内容；requiresReview=false。没有写出相关内容不能返回unreadable。
- unreadable：确实存在与评分点相关的作答痕迹，但字迹、涂改或公式结构无法可靠辨认；requiresReview=true并说明需核对的区域。该字段只表示复核候选，最终是否进入人工复核由确定性计分引擎按整卷影响分值和教师设置的阈值决定。

只有satisfied可以获得该评分点分数。not_satisfied、not_present和unreadable当前都不得给分。不得因为“可能写过”而返回satisfied。无法找到有效证据时优先返回not_present，不得把所有未出现的步骤统一标为unreadable。已划掉内容不能证明评分点完成。confidence表示你对状态判断的可靠程度，不是正确或错误标签。核心公式正确时应判为satisfied，即使后续计算错误；同一错误不得重复触发扣分。

在同一次响应中生成teacherCommentary。评语只能总结本次decisions、教师最终答案结论和卷面证据，不得重新解题、修改分数或创造评分点。最终答案正确且触发满分的小问，过程问题只能列入auditConcerns，不能列入lostPoints。所有引用必须使用已有的小问ID、评分点ID和证据行号；overallComment不写具体总分，由本地计分引擎负责。`,
        prompt: `必须判断锁定评分标准中的每一个评分点：${processSubquestionIds.join(", ")}。最终答案正确的小问也不能跳过。所有评分点必须使用同一证据标准，不能因为最终答案状态而改变客观审验结论。审验结果用于过程展示、审计和复核；如果最终答案状态为correct，任何过程问题都不能降低该小问最终得分。最终得分由确定性计分引擎处理，你只返回客观的逐点评审结果。

待判断评分标准：
${JSON.stringify(processRubric)}

教师模型最终答案结论（仅供分支和解释，不得修改）：
${JSON.stringify(finalAnswerJudgements)}

卷面转录：
${JSON.stringify(evidence)}`,
        images: [{ ...image, label: "[学生作答原图]" }],
        schemaName: "process_point_judgement_with_commentary",
        schema: processJudgementWithCommentaryJsonSchema,
        validate: (value) => processJudgementWithCommentarySchema.parse(value),
        reasoningEffort: config.teacherReasoningEffort,
        operationId
      });
      const parsedProcess = processJudgementWithCommentarySchema.parse(processResponse.data);
      decisions = parsedProcess.decisions.filter((item) => processSubquestionIds.includes(item.subquestionId));
      appliedDeductions = parsedProcess.appliedDeductions.filter((item) => processSubquestionIds.includes(item.subquestionId));
      teacherCommentaryDraft = parsedProcess.teacherCommentary;
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
      logProgress(operationId, "grading", "process_audit_failed", "过程审验模型调用失败，缺失评分点将按未完成计0分并进入人工复核", {
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
      gradingMode: "evidence_pipeline",
      evidenceValidationMode: "extracted_text",
      durationMs: extraction.durationMs + finalAnswerResponse.durationMs + processDurationMs,
      unreadableReviewThreshold: config.unreadableReviewThreshold,
      operationId,
      previousResultId: input.previousResultId,
      regradedAt: input.regradedAt,
      regradeReason: input.regradeReason
    });
    if (processAuditError) {
      result.reviewReasons = [...new Set([...result.reviewReasons, `过程审验模型调用失败：${processAuditError}`])];
      result.status = "needs_review";
    }
    result.teacherCommentary = finalizeTeacherCommentary(teacherCommentaryDraft, result, config.visionModel);
    logProgress(operationId, "grading", "teacher_commentary_ready", teacherCommentaryDraft
      ? "教师评语已随过程审验结果一并生成并完成本地校验"
      : "过程审验未返回教师评语，已使用本地结构化降级评语", {
      status: result.teacherCommentary.status,
      version: result.teacherCommentary.version,
      model: result.teacherCommentary.modelName,
      integratedModelCall: true,
      lostPoints: result.teacherCommentary.lostPoints.length,
      auditConcerns: result.teacherCommentary.auditConcerns.length
    }, teacherCommentaryDraft ? "success" : "warning");
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
