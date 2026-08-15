import type {
  AnswerEvidence,
  AppliedDeduction,
  FinalAnswerJudgement,
  GradingResult,
  Rubric,
  RubricDecision,
  ScorePoint,
  TeacherCommentary
} from "../shared/types.js";
import sharp from "sharp";
import { calculateGrade, createFallbackTeacherCommentary, normalizeEvidenceReferences, TEACHER_COMMENTARY_VERSION } from "./gradingEngine.js";
import { callStructured, resolveReviewModelConfig } from "./modelClient.js";
import {
  evidenceJsonSchema,
  evidenceSchema,
  directVisionGradeJsonSchema,
  directVisionGradeSchema,
  finalAnswerJudgementsJsonSchema,
  finalAnswerJudgementsSchema,
  localNumericAnswerReviewJsonSchema,
  localNumericAnswerReviewSchema,
  processJudgementWithCommentaryJsonSchema,
  processJudgementWithCommentarySchema,
  unreadableLocalReviewJsonSchema,
  unreadableLocalReviewSchema,
  assertRubricIntegrity,
  rubricJsonSchema,
  rubricSchema,
  validateRubricTotals
} from "./schemas.js";
import type { GradingMode, ModelConfigInput } from "../shared/types.js";
import { DEFAULT_GRADING_MODE } from "../shared/types.js";
import {
  beginOperation,
  completeOperation,
  failOperation,
  isOperationCancelled,
  logProgress,
  throwIfOperationCancelled
} from "./systemLog.js";

interface GradingImage {
  mimeType: string;
  base64: string;
  label?: string;
}

const SCORE_POINT_EVIDENCE_PROTOCOL = `评分点证据协议：
- 等价判断只能用于学生卷面上实际写出的表达。可以判断明确写出的移项、约分、变量替换和单位换算是否等价，但禁止从具体数值、计算顺序、上下文或期望答案反推学生没有写出的字母公式、物理关系或中间步骤。
- 评分标准中的 commonResponses、alternativeMethods、acceptedEquivalents 是生成阶段预测的阅卷辅助示例，不是封闭答案白名单，也不得用于字符串匹配。列表外的作答只要数学和物理意义等价仍可满足评分点；列表内示例也必须在学生卷面上实际出现并满足当前评分点。
- formula（公式/原理）评分点：必须有卷面实际可见的字母参数、物理量符号或经学生明确定义的符号之间的关系作为证据。只有具体数字组成的算式，即使教师可以猜出数字分别代表哪些物理量，也不能单独证明公式评分点；未出现要求的符号关系时返回 not_present，明确写出了错误关系时返回 not_satisfied。
- substitution（代入）评分点：必须看见学生把已建立或同一行明确可见的正确关系代入数据，且代入对象、符号和数值对应正确。来源不明的数字拼接、建立在错误关系上的代入或本身错误的数字算式不得判 satisfied。
- result（结果）评分点：只根据学生实际写出的最终数值、表达式、单位和方向判断；结果错误不得反向证明此前公式或代入正确。
- text（说明）评分点：必须有学生实际写出的文字、条件或结论，不得根据后续计算推测其理解。
- 当最终答案为 incorrect、missing 或 uncertain 时尤其不得宽推步骤分：如果卷面只有具体数字算式且数值关系或结果错误，不能据此给 formula 或 substitution 评分点得分。每个 satisfied 的 evidenceQuote 必须逐字引用足以独立证明该评分点的卷面内容，reason 不得补写 evidenceQuote 中不存在的关键字母关系。`;

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
      prompt: `将以下高中物理题目和参考评分标准拆成原子评分规则。紧随题目文字之后的图片属于题目，标记为参考答案图片的内容只属于参考答案。必须读取图中的物理量标注、方向和几何关系，但不得自行补充图中不存在的信息。请把完整题干忠实转录到recognizedQuestionText；其中行内公式使用$...$，独立公式使用$$...$$，保留题号、小问、单位和图示引用。无法辨认的部分写作[无法辨认]并加入warnings，禁止猜测。每个finalAnswers对象必须表示一套完整可接受的最终答案；一道小问要求多个物理量时，把多个等式放在同一个expression中并分别使用$...$分隔。必须按证据对象准确设置评分点 type：要求写出字母关系或原理用 formula，要求把数据代入关系用 substitution，要求最终值、单位或方向用 result，要求文字解释用 text；不得把“列公式”和“代入计算”混为同一个类型。本系统规定：最终答案经教师模型确认正确时，该小问过程审验不得降低得分，因此所有小问的finalAnswerPolicy统一标记为full_credit；仍须完整保留过程评分点，用于最终答案错误、缺失或无法确认时计分，并用于审计和复核。文档未明确的信息写入warnings。

题目：
${input.questionText}

参考答案与评分标准：
${input.referenceText}`,
      images,
      schemaName: "physics_rubric",
      schema: rubricJsonSchema,
      validate: (value) => rubricSchema.parse(value),
      operationId
    });
    throwIfOperationCancelled(operationId);
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
        finalAnswerPolicy: "full_credit" as const,
        scorePoints: subquestion.scorePoints.map((point) => ({
          ...point,
          commonResponses: [],
          alternativeMethods: [],
          acceptedEquivalents: []
        }))
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

function assertSameRubricScoringStructure(original: Rubric, candidate: Rubric): void {
  const reject = (detail: string): never => {
    throw new Error(`教师模型修改了受保护的评分结构（${detail}），本次修改已拒绝`);
  };
  if (candidate.totalScore !== original.totalScore) reject("总分");
  if (candidate.subquestions.length !== original.subquestions.length) reject("小问数量");

  original.subquestions.forEach((originalQuestion, questionIndex) => {
    const candidateQuestion = candidate.subquestions[questionIndex];
    if (!candidateQuestion || candidateQuestion.id !== originalQuestion.id) reject(`第 ${questionIndex + 1} 个小问的 ID 或顺序`);
    if (candidateQuestion.maxScore !== originalQuestion.maxScore) reject(`${originalQuestion.id} 的满分`);
    if (candidateQuestion.scorePoints.length !== originalQuestion.scorePoints.length) reject(`${originalQuestion.id} 的评分点数量`);
    originalQuestion.scorePoints.forEach((originalPoint, pointIndex) => {
      const candidatePoint = candidateQuestion.scorePoints[pointIndex];
      if (!candidatePoint || candidatePoint.id !== originalPoint.id) reject(`${originalQuestion.id} 第 ${pointIndex + 1} 个评分点的 ID 或顺序`);
      if (candidatePoint.score !== originalPoint.score) reject(`${originalPoint.id} 的分值`);
      if (candidatePoint.type !== originalPoint.type) reject(`${originalPoint.id} 的评分点类型`);
    });
    if (candidateQuestion.deductions.length !== originalQuestion.deductions.length) reject(`${originalQuestion.id} 的扣分规则数量`);
    originalQuestion.deductions.forEach((originalRule, ruleIndex) => {
      const candidateRule = candidateQuestion.deductions[ruleIndex];
      if (!candidateRule || candidateRule.id !== originalRule.id) reject(`${originalQuestion.id} 第 ${ruleIndex + 1} 条扣分规则的 ID 或顺序`);
      if (candidateRule.deduct !== originalRule.deduct || candidateRule.exclusiveGroup !== originalRule.exclusiveGroup) {
        reject(`${originalRule.id} 的扣分值或互斥组`);
      }
    });
  });
}

export async function refineRubric(config: ModelConfigInput, original: Rubric, instruction: string): Promise<Rubric> {
  const operationId = beginOperation("rubric", "开始根据教师提示完善评分标准", "refine_rubric", {
    title: original.title,
    instructionCharacters: instruction.length
  });
  try {
    assertRubricIntegrity(original);
    logProgress(operationId, "model", "rubric_refinement_model_call", "已发送当前评分标准和教师补充要求", {
      model: config.textModel
    });
    const response = await callStructured<unknown>(config, {
      model: config.textModel,
      system: `你是高中物理评分标准修订助手。只根据教师补充要求完善当前评分标准中的评分细节，并返回完整 JSON。

不得改变总分、小问数量和顺序、小问 ID 和满分、评分点数量和顺序、评分点 ID 和分值，也不得新增、删除或改变扣分规则及其扣分值。不得改变 version。所有小问的 finalAnswerPolicy 必须保持 full_credit。题目原文应保持不变，除非教师明确要求纠正转录错误。

可以完善标题、评分点说明、判分依据、最终答案表达、常见正确作答、替代解法、可接受等价形式和 warnings。commonResponses、alternativeMethods、acceptedEquivalents 只是教师模型理解答案的辅助示例，不是封闭答案白名单，也不能用于机械字符串匹配。列表外但数学或物理意义等价的作答仍可得分；列表内示例也必须真实出现在学生卷面，不能据此反推未写步骤。无法在不改变受保护结构的情况下落实的要求写入 warnings。`,
      prompt: `教师补充要求：
${instruction}

当前完整评分标准 JSON：
${JSON.stringify(original, null, 2)}`,
      schemaName: "physics_rubric_refinement",
      schema: rubricJsonSchema,
      validate: (value) => rubricSchema.parse(value),
      operationId
    });
    throwIfOperationCancelled(operationId);
    const candidate = rubricSchema.parse(response.data);
    assertSameRubricScoringStructure(original, candidate);
    const refined = validateRubricTotals({
      ...candidate,
      version: original.version,
      status: "draft" as const,
      subquestions: candidate.subquestions.map((subquestion) => ({
        ...subquestion,
        finalAnswerPolicy: "full_credit" as const
      }))
    });
    assertRubricIntegrity(refined);
    completeOperation(operationId, "rubric", "rubric_refined", "教师提示已应用，评分结构保持不变", {
      title: refined.title,
      warnings: refined.warnings.length
    });
    return refined;
  } catch (error) {
    failOperation(operationId, "rubric", "rubric_refinement_failed", error);
    throw error;
  }
}

type TeacherCommentaryDraft = Omit<TeacherCommentary, "status" | "modelName" | "version">;

type LocalReviewTarget = {
  subquestionId: string;
  pointId?: string;
  title: string;
  score: number;
  evidenceLineIds: string[];
  pointType?: ScorePoint["type"];
  description?: string;
  expected?: string;
};

async function createLocalReviewImage(imageBuffer: Buffer, targets: LocalReviewTarget[], evidence: AnswerEvidence, purpose: string): Promise<GradingImage | null> {
  const metadata = await sharp(imageBuffer).metadata();
  const imageWidth = metadata.width ?? 0;
  const imageHeight = metadata.height ?? 0;
  if (!imageWidth || !imageHeight) return null;

  const regions = targets.flatMap((target) => target.evidenceLineIds.flatMap((lineId) => {
    const region = evidence.lines.find((line) => line.id === lineId)?.region;
    return region ? [region] : [];
  }));
  if (!regions.length) return null;

  const minX = Math.min(...regions.map(([x]) => x));
  const minY = Math.min(...regions.map(([, y]) => y));
  const maxX = Math.max(...regions.map(([x, , width]) => x + width));
  const maxY = Math.max(...regions.map(([, y, , height]) => y + height));
  const padding = Math.max(24, Math.round(Math.max(maxX - minX, maxY - minY) * 0.18));
  const left = Math.max(0, Math.floor(minX - padding));
  const top = Math.max(0, Math.floor(minY - padding));
  const right = Math.min(imageWidth, Math.ceil(maxX + padding));
  const bottom = Math.min(imageHeight, Math.ceil(maxY + padding));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const maxReviewDimension = 2200;
  const scale = Math.min(maxReviewDimension / width, maxReviewDimension / height);
  const reviewBuffer = await sharp(imageBuffer)
    .extract({ left, top, width, height })
    .resize({
      width: Math.max(1, Math.round(width * Math.max(1, scale))),
      height: Math.max(1, Math.round(height * Math.max(1, scale))),
      fit: "fill"
    })
    .png()
    .toBuffer();
  return {
    mimeType: "image/png",
    base64: reviewBuffer.toString("base64"),
    label: `[${purpose}：原图区域 x=${left}, y=${top}, w=${width}, h=${height}]`
  };
}

async function reviewUnreadablePoints(
  config: ModelConfigInput,
  input: StudentAnswerGradingInput,
  operationId: string,
  imageBuffer: Buffer,
  image: GradingImage,
  evidence: AnswerEvidence,
  decisions: RubricDecision[],
  finalAnswerJudgements: FinalAnswerJudgement[]
): Promise<{ decisions: RubricDecision[]; finalAnswerJudgements: FinalAnswerJudgement[]; durationMs: number }> {
  // A clear status combined with requiresReview=true is contradictory: the
  // model claims it can decide the point while also asking a human to decide it.
  // Treat that response as unreadable until a targeted visual recheck resolves it.
  const normalizedDecisions = decisions.map((decision): RubricDecision => {
    const hasContradictoryReviewFlag = decision.requiresReview
      && decision.status !== "unreadable"
      && decision.status !== "insufficient_evidence";
    if (!hasContradictoryReviewFlag) return decision;
    const originalStatus = decision.status;
    return {
      ...decision,
      status: "unreadable",
      reason: `第一次模型同时返回明确状态 ${originalStatus} 和人工复核标记：${decision.reviewReason || decision.reason}`,
      requiresReview: true,
      reviewReason: decision.reviewReason || "第一次模型的评分状态与复核标记矛盾",
      decisionSource: "normalized_uncertain"
    };
  });
  const targets: LocalReviewTarget[] = normalizedDecisions.flatMap((decision) => {
    if (decision.status !== "unreadable" && decision.status !== "insufficient_evidence") return [];
    const point = input.rubric.subquestions
      .find((subquestion) => subquestion.id === decision.subquestionId)
      ?.scorePoints.find((candidate) => candidate.id === decision.pointId);
    return point ? [{
      subquestionId: decision.subquestionId,
      pointId: decision.pointId,
      title: point.title,
      score: point.score,
      evidenceLineIds: decision.evidenceLineIds,
      pointType: point.type,
      description: point.description,
      expected: point.expected
    }] : [];
  });
  const finalAnswerTargets: LocalReviewTarget[] = finalAnswerJudgements.flatMap((judgement) => {
    if (judgement.status !== "uncertain") return [];
    const subquestion = input.rubric.subquestions.find((item) => item.id === judgement.subquestionId);
    return subquestion ? [{ subquestionId: judgement.subquestionId, title: `${subquestion.title}最终答案`, score: subquestion.maxScore, evidenceLineIds: judgement.evidenceLineIds }] : [];
  });
  const allTargets = [...targets, ...finalAnswerTargets];
  if (!allTargets.length) return { decisions: normalizedDecisions, finalAnswerJudgements, durationMs: 0 };

  const configuredReviewModel = config.reviewModel?.trim();
  if (!configuredReviewModel) {
    logProgress(operationId, "grading", "unreadable_local_review_not_configured", "未配置独立局部审验模型，无法执行第二次视觉复查", {
      targetPoints: allTargets.map((target) => `${target.subquestionId}:${target.pointId ?? "final"}`)
    }, "warning");
    return { decisions: normalizedDecisions, finalAnswerJudgements, durationMs: 0 };
  }
  let reviewConfig: ModelConfigInput;
  try {
    reviewConfig = resolveReviewModelConfig(config);
  } catch (error) {
    logProgress(operationId, "grading", "unreadable_local_review_config_missing", "局部审验模型凭据不完整，无法执行视觉复查", {
      model: configuredReviewModel,
      error: error instanceof Error ? error.message : String(error),
      targetPoints: allTargets.map((target) => `${target.subquestionId}:${target.pointId ?? "final"}`)
    }, "warning");
    return { decisions: normalizedDecisions, finalAnswerJudgements, durationMs: 0 };
  }

  const reviewImages: GradingImage[] = [];
  const reviewableTargets: LocalReviewTarget[] = [];
  for (const target of allTargets) {
    try {
      const targetImage = await createLocalReviewImage(imageBuffer, [target], evidence, "unreadable局部复查");
      if (targetImage) {
        reviewImages.push({ ...targetImage, label: `[${target.subquestionId}:${target.pointId ?? "final"}] ${targetImage.label ?? "局部放大图"}` });
        reviewableTargets.push(target);
      }
    } catch (error) {
      logProgress(operationId, "grading", "unreadable_local_review_unavailable", "无法生成局部复查图，保留该项原始无法辨认结论", {
        error: error instanceof Error ? error.message : String(error),
        targetPoint: `${target.subquestionId}:${target.pointId ?? "final"}`
      }, "warning");
    }
  }
  if (!reviewableTargets.length) {
    logProgress(operationId, "grading", "unreadable_local_review_unavailable", "缺少可定位的卷面区域，无法执行局部复查，将按实际影响分值判断是否人工复核", {
      targetPoints: allTargets.map((target) => `${target.subquestionId}:${target.pointId ?? "final"}`),
      evidenceLineIds: allTargets.flatMap((target) => target.evidenceLineIds)
    }, "warning");
    return { decisions: normalizedDecisions, finalAnswerJudgements, durationMs: 0 };
  }

  logProgress(operationId, "model", "unreadable_local_review", "正在对无法辨认评分点执行局部视觉复查", {
    model: configuredReviewModel,
    targetPoints: reviewableTargets.map((target) => ({ subquestionId: target.subquestionId, pointId: target.pointId, title: target.title, score: target.score })),
    reviewImages: reviewImages.map((item) => item.label)
  });
  try {
    const reviewablePointTargets = reviewableTargets.filter((target) => target.pointId);
    const reviewableFinalAnswerTargets = reviewableTargets.filter((target) => !target.pointId);
    const response = await callStructured<unknown>(reviewConfig, {
      model: configuredReviewModel,
      system: `你是高中物理阅卷复查模型。你正在复查第一次阅卷标记为 unreadable，或同时给出明确状态和人工复核标记而产生矛盾的评分点。当前图片是从学生原卷对应坐标裁剪并放大的局部图，只能根据局部图中实际可见的学生笔迹自主决策，禁止根据题目推导结果补写学生答案，禁止把模糊数字猜成期望数字。

对每个目标评分点返回一条结论：
- satisfied：局部图清楚显示学生作答满足该评分点；
- not_satisfied：局部图清楚显示学生作答明确错误或不满足；
- not_present：确认该评分点没有有效作答；
- unreadable：经过局部放大后仍无法确认关键数字、符号、单位、方向或内容。

只有前三种明确结论可以结束该评分点的 unreadable 状态；unreadable 必须 requiresReview=true。不要因为第一次结果是 unreadable 就机械保持，也不要为了消除复核而强行选择其他状态。evidenceQuote 只能引用局部图中确实可见的内容。

如果目标中包含最终答案复查，还要在 finalAnswers 中返回一条结论：correct、incorrect、missing 或 uncertain。最终答案 uncertain 必须 requiresReview=true；只有明确结论才允许结束最终答案复核。

${SCORE_POINT_EVIDENCE_PROTOCOL}` ,
      prompt: `请逐一复查以下评分点。评分标准只用于说明该评分点要求，不得代替观察学生笔迹。

评分点：
${JSON.stringify(reviewablePointTargets.map((target) => ({ subquestionId: target.subquestionId, pointId: target.pointId, title: target.title, description: target.description, type: target.pointType, score: target.score, expected: target.expected })))}

第一次判断（仅说明为什么进入复查，不得盲从）：
${JSON.stringify(reviewablePointTargets.map((target) => {
  const decision = normalizedDecisions.find((item) => item.subquestionId === target.subquestionId && item.pointId === target.pointId);
  return { subquestionId: target.subquestionId, pointId: target.pointId, status: decision?.status ?? "unreadable", reason: decision?.reason ?? "第一次判断无法可靠辨认", reviewReason: decision?.reviewReason, evidenceLineIds: target.evidenceLineIds };
}))}

必须覆盖目标评分点：${reviewablePointTargets.map((target) => `${target.subquestionId}:${target.pointId}`).join("、") || "无"}
必须覆盖最终答案复查目标：${reviewableFinalAnswerTargets.map((target) => `${target.subquestionId}:final`).join("、") || "无"}`,
      images: [...reviewImages, { ...image, label: "[学生答卷原图（仅用于确认局部坐标与上下文）]" }],
      schemaName: "unreadable_local_review",
      schema: unreadableLocalReviewJsonSchema,
      validate: (value) => unreadableLocalReviewSchema.parse(value),
      reasoningEffort: config.reviewReasoningEffort ?? "low",
      operationId
    });
    throwIfOperationCancelled(operationId);
    const parsed = unreadableLocalReviewSchema.parse(response.data);
    const targetKeys = new Set(reviewableTargets.map((target) => `${target.subquestionId}:${target.pointId ?? "final"}`));
    const seen = new Set<string>();
    const reviewed = parsed.reviews.filter((item) => {
      const key = `${item.subquestionId}:${item.pointId}`;
      if (!targetKeys.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const reviewedByKey = new Map(reviewed.map((item) => [`${item.subquestionId}:${item.pointId}`, item]));
    const nextDecisions = normalizedDecisions.map((decision) => {
      const review = reviewedByKey.get(`${decision.subquestionId}:${decision.pointId}`);
      if (!review) return decision;
      const stillUnreadable = review.status === "unreadable";
      const validEvidenceLineIds = review.evidenceLineIds.filter((lineId) => decision.evidenceLineIds.includes(lineId));
      return {
        ...decision,
        status: review.status,
        evidenceLineIds: validEvidenceLineIds.length ? validEvidenceLineIds : decision.evidenceLineIds,
        evidenceQuote: review.evidenceQuote || decision.evidenceQuote,
        reason: review.reason,
        confidence: review.confidence,
        requiresReview: stillUnreadable,
        reviewReason: stillUnreadable ? review.reason : undefined,
        decisionSource: "unreadable_local_review" as const
      };
    });
    const finalAnswersBySubquestion = new Map(parsed.finalAnswers.map((item) => [item.subquestionId, item]));
    const nextFinalAnswerJudgements = finalAnswerJudgements.map((judgement) => {
      const review = finalAnswersBySubquestion.get(judgement.subquestionId);
      if (!review || !reviewableFinalAnswerTargets.some((target) => target.subquestionId === judgement.subquestionId)) return judgement;
      const validEvidenceLineIds = review.evidenceLineIds.filter((lineId) => judgement.evidenceLineIds.includes(lineId));
      return {
        ...judgement,
        status: review.status,
        evidenceLineIds: validEvidenceLineIds.length ? validEvidenceLineIds : judgement.evidenceLineIds,
        studentAnswer: review.studentAnswer,
        reason: review.reason,
        confidence: review.confidence,
        decisionSource: "unreadable_local_review" as const
      };
    });
    logProgress(operationId, "grading", "unreadable_local_review_ready", "局部视觉复查完成，已采用复查模型对目标评分点的自主结论", {
      targetPoints: reviewableTargets.map((target) => `${target.subquestionId}:${target.pointId ?? "final"}`),
      results: reviewed.map((item) => ({ subquestionId: item.subquestionId, pointId: item.pointId, status: item.status, confidence: item.confidence, requiresReview: item.status === "unreadable" })),
      finalAnswers: parsed.finalAnswers.map((item) => ({ subquestionId: item.subquestionId, status: item.status, confidence: item.confidence, requiresReview: item.requiresReview })),
      missingResults: [...targetKeys].filter((key) => !seen.has(key) && !parsed.finalAnswers.some((item) => `${item.subquestionId}:final` === key))
    }, reviewed.length === reviewablePointTargets.length && parsed.finalAnswers.length === reviewableFinalAnswerTargets.length ? "success" : "warning");
    return { decisions: nextDecisions, finalAnswerJudgements: nextFinalAnswerJudgements, durationMs: response.durationMs };
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    logProgress(operationId, "grading", "unreadable_local_review_failed", "局部视觉复查失败，保留无法辨认结论并按实际影响分值判断是否人工复核", {
      error: error instanceof Error ? error.message : String(error),
      targetPoints: allTargets.map((target) => `${target.subquestionId}:${target.pointId ?? "final"}`)
    }, "warning");
    return { decisions: normalizedDecisions, finalAnswerJudgements, durationMs: 0 };
  }
}

const superscriptDigits: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9"
};

function numericAnswerTokens(value: string): string[] {
  const normalized = value
    .replace(/\\mathrm\{([^}]*)\}/g, "$1")
    .replace(/\\times|\\cdot|×|·/g, "x")
    .replace(/([A-Za-z])_?\{?\d+\}?/g, "$1")
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, "")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (digits) => `^${[...digits].map((digit) => superscriptDigits[digit] ?? "").join("")}`)
    .replace(/,/g, ".");
  return (normalized.match(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*(?:x|\*)\s*10\s*\^?\s*[-+]?\d+)?/gi) ?? [])
    .map((token) => token.replace(/\s+/g, "").toLowerCase())
    .sort();
}

function sameNumericTokens(left: string[], right: string[]): boolean {
  return left.length > 0 && left.length === right.length && left.every((token, index) => token === right[index]);
}

async function reviewNumericFinalAnswers(
  config: ModelConfigInput,
  input: StudentAnswerGradingInput,
  operationId: string,
  imageBuffer: Buffer,
  evidence: AnswerEvidence,
  finalAnswerJudgements: FinalAnswerJudgement[]
): Promise<{ finalAnswerJudgements: FinalAnswerJudgement[]; durationMs: number }> {
  const reviewModel = config.reviewModel?.trim();
  if (!reviewModel) return { finalAnswerJudgements, durationMs: 0 };

  const targets = finalAnswerJudgements.flatMap((judgement): Array<LocalReviewTarget & { teacherTokens: string[] }> => {
    if (judgement.status !== "correct" && judgement.status !== "incorrect") return [];
    const teacherTokens = numericAnswerTokens(judgement.studentAnswer);
    if (!teacherTokens.length) return [];
    const subquestion = input.rubric.subquestions.find((item) => item.id === judgement.subquestionId);
    return subquestion ? [{
      subquestionId: judgement.subquestionId,
      title: `${subquestion.title}数值答案`,
      score: subquestion.maxScore,
      evidenceLineIds: judgement.evidenceLineIds,
      teacherTokens
    }] : [];
  });
  if (!targets.length) return { finalAnswerJudgements, durationMs: 0 };

  const markUncertain = (judgements: FinalAnswerJudgement[], subquestionId: string, reason: string, confidence = 0) => judgements.map((judgement) => judgement.subquestionId === subquestionId ? {
    ...judgement,
    status: "uncertain" as const,
    reason,
    confidence,
    decisionSource: "local_numeric_review" as const
  } : judgement);

  let reviewConfig: ModelConfigInput;
  try {
    reviewConfig = resolveReviewModelConfig(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logProgress(operationId, "grading", "local_numeric_review_config_missing", "局部数值审验模型凭据不完整，相关小问已转人工复核", {
      model: reviewModel,
      error: message,
      targetSubquestions: targets.map((target) => target.subquestionId)
    }, "warning");
    return {
      finalAnswerJudgements: targets.reduce(
        (judgements, target) => markUncertain(judgements, target.subquestionId, `${message}。已阻止自动放行。`),
        finalAnswerJudgements
      ),
      durationMs: 0
    };
  }

  const reviewImages: GradingImage[] = [];
  const reviewableTargets: typeof targets = [];
  const unavailableIds = new Set<string>();
  for (const target of targets) {
    try {
      const targetImage = await createLocalReviewImage(imageBuffer, [target], evidence, "数值答案审验");
      if (!targetImage) {
        unavailableIds.add(target.subquestionId);
        continue;
      }
      reviewImages.push({ ...targetImage, label: `[${target.subquestionId}:final] ${targetImage.label}` });
      reviewableTargets.push(target);
    } catch (error) {
      unavailableIds.add(target.subquestionId);
      logProgress(operationId, "grading", "local_numeric_review_crop_failed", "无法生成数值答案局部审验图", {
        subquestionId: target.subquestionId,
        error: error instanceof Error ? error.message : String(error)
      }, "warning");
    }
  }

  let nextJudgements = finalAnswerJudgements;
  for (const subquestionId of unavailableIds) {
    nextJudgements = markUncertain(nextJudgements, subquestionId, "已启用局部数值审验，但当前最终答案缺少可定位的证据框，已阻止自动放行。请人工核对卷面。");
  }
  if (!reviewableTargets.length) return { finalAnswerJudgements: nextJudgements, durationMs: 0 };

  logProgress(operationId, "model", "local_numeric_answer_review", "正在使用审验模型独立读取数值答案局部图", {
    model: reviewModel,
    reasoningEffort: config.reviewReasoningEffort ?? "low",
    targetSubquestions: reviewableTargets.map((target) => target.subquestionId)
  });
  try {
    const response = await callStructured<unknown>(reviewConfig, {
      model: reviewModel,
      system: `你是答卷局部数值审验模型。每张图只包含某一小问最终答案附近的学生笔迹。你的唯一任务是独立、忠实地重读图中实际写出的数值答案，不得评分，不得查看或推测参考答案，也不得根据物理计算补写模糊字符。

对每个目标返回 observedAnswer 和按出现顺序列出的 numericTokens。numericTokens 只收录学生明确写出的数值，包括正负号、小数、分数和科学计数法；变量下标、题号和单位中的数字不属于答案数值。看不清任何关键数字时返回 unreadable，禁止猜测。`,
      prompt: `请独立读取所附局部图中的最终数值答案。

必须覆盖的小问：${reviewableTargets.map((target) => target.subquestionId).join("、")}
图片标签中的 subquestionId 是唯一映射依据。不要输出参考答案或判分结论。`,
      images: reviewImages,
      schemaName: "local_numeric_answer_review",
      schema: localNumericAnswerReviewJsonSchema,
      validate: (value) => localNumericAnswerReviewSchema.parse(value),
      reasoningEffort: config.reviewReasoningEffort ?? "low",
      operationId
    });
    throwIfOperationCancelled(operationId);
    const parsed = localNumericAnswerReviewSchema.parse(response.data);
    const reviews = new Map(parsed.reviews.map((review) => [review.subquestionId, review]));
    const results: Array<Record<string, unknown>> = [];
    for (const target of reviewableTargets) {
      const review = reviews.get(target.subquestionId);
      if (!review || review.status === "unreadable") {
        const reason = review?.reason || "审验模型没有返回该小问的局部读取结果";
        nextJudgements = markUncertain(nextJudgements, target.subquestionId, `局部数值审验无法确认：${reason}`, review?.confidence ?? 0);
        results.push({ subquestionId: target.subquestionId, status: "unreadable", reason });
        continue;
      }
      const reviewTokens = numericAnswerTokens(review.observedAnswer).length
        ? numericAnswerTokens(review.observedAnswer)
        : review.numericTokens.flatMap(numericAnswerTokens).sort();
      if (!sameNumericTokens(target.teacherTokens, reviewTokens)) {
        const teacherAnswer = finalAnswerJudgements.find((item) => item.subquestionId === target.subquestionId)?.studentAnswer ?? "";
        nextJudgements = markUncertain(nextJudgements, target.subquestionId,
          `教师模型与局部审验模型读取冲突：教师模型为“${teacherAnswer}”，审验模型为“${review.observedAnswer}”。已阻止自动放行，请人工核对证据框。`,
          review.confidence);
        results.push({ subquestionId: target.subquestionId, status: "conflict", teacherTokens: target.teacherTokens, reviewTokens, observedAnswer: review.observedAnswer });
        continue;
      }
      results.push({ subquestionId: target.subquestionId, status: "confirmed", numericTokens: reviewTokens, observedAnswer: review.observedAnswer });
    }
    logProgress(operationId, "grading", "local_numeric_answer_review_ready", "局部数值答案审验完成", {
      model: reviewModel,
      results
    }, results.some((item) => item.status !== "confirmed") ? "warning" : "success");
    return { finalAnswerJudgements: nextJudgements, durationMs: response.durationMs };
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    for (const target of reviewableTargets) {
      nextJudgements = markUncertain(nextJudgements, target.subquestionId, `局部数值审验调用失败：${message}。已阻止自动放行。`);
    }
    logProgress(operationId, "grading", "local_numeric_answer_review_failed", "局部数值审验失败，相关小问已转人工复核", {
      model: reviewModel,
      error: message,
      targetSubquestions: reviewableTargets.map((target) => target.subquestionId)
    }, "error");
    return { finalAnswerJudgements: nextJudgements, durationMs: 0 };
  }
}

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
    system: `你是高中物理教师阅卷模型，必须直接查看输入的题目图片、参考答案与评分标准图片、学生答卷原图，依据本次使用的评分标准版本给出结构化阅卷结果。当前评分标准 JSON 是唯一的评分点和分值来源；题图与参考答案图用于理解题干、图示和评分语义。你是最终答案和每个评分点是否得分的唯一判断者，不得调用或假设任何外部 OCR 结果，也不得把判断交给字符串、公式或数值匹配程序。

严格规则：
1. 逐页查看所有图片，题目图片、参考答案图片和学生答卷图片必须区分。只根据当前评分标准中的评分点和分值评分，不得自行增加得分点或扣分点。必须根据数学关系和物理意义判断等价表达，不得要求学生逐字复现 expected。
2. 每个小问必须返回且只能返回一条 finalAnswerJudgement。只要你将该小问最终答案判为 correct，本地计分引擎就会无条件将该小问计为满分，不受 finalAnswerPolicy、过程评分点、步骤缺失、无法辨认或扣分规则影响。过程仍必须逐点评审，但只用于审计，不能降低该小问得分。最终答案为 incorrect、missing 或 uncertain 时，才按评分点和扣分规则计分。
3. 每个评分点必须返回且只能返回一条 decision，并严格按评分点 type 使用下方评分点证据协议。学生明确写出的移项、约分、不同但等价的变量记号或单位换算可以判为等价，例如 p=p₀+mg/S 与 pS=p₀S+mg 等价；但不能从纯数字算式反推未写出的字母公式。核心公式实际写出且正确时判 satisfied，即使后续计算错误；计算错误只影响对应代入或结果评分点。单位、方向、符号和重复错误必须按评分标准处理，不能重复扣分。
4. 无法辨认时返回 unreadable，不得猜测；没有出现相关作答时返回 not_present，不得把未作答统一写成 unreadable。unreadable 的最终复核由系统按实际影响分值和教师设置的阈值处理。
5. evidence 不是整页 OCR 转录，只返回支持判断所必需的最小卷面证据。每条证据必须是学生原图中确实存在的可定位片段，使用唯一 line id；能提供位置时 region 使用原图像素坐标 [x,y,width,height]。不要为了填充字段臆造文字或公式。
6. correct、incorrect、satisfied、not_satisfied 和 appliedDeductions 必须引用至少一条有效的 active 证据行；unreadable 应引用对应的 uncertain 证据行；missing 或 not_present 可以不引用。所有引用的 line id 必须出现在 evidence.lines 中。
7. 在同一次响应中生成 teacherCommentary。评语只能总结本次返回的 finalAnswerJudgements、decisions 和卷面证据，不得重新解题、修改分数或创造评分点。最终答案正确且触发满分的小问，过程问题只能列入 auditConcerns，不能列入 lostPoints。lostPoints 和 auditConcerns 必须引用本次返回的评分点 ID 与证据行号；overallComment 不写具体总分，由本地计分引擎补充展示。
8. 只输出符合 JSON Schema 的对象，不输出 Markdown、解释性前缀或隐藏推理过程。reason、evidenceQuote 和评语只写简短、可审计的判分依据。

${SCORE_POINT_EVIDENCE_PROTOCOL}

数学公式可以使用 LaTeX，但必须遵守系统附加的安全公式块协议。`,
    prompt: `请直接根据图片完成整份物理答卷批改。不要输出完整 OCR，只输出用于审计的最小证据片段。

题目文字（可能为空，题图可补足图示；计分仍以当前评分标准 JSON 为准）：
${input.questionText?.trim() || "题目内容见题目图片"}

参考答案和评分标准文字（可能为空，参考答案图仅作上下文核对；计分仍以当前评分标准 JSON 为准）：
${input.referenceText?.trim() || "参考答案与评分标准见参考答案图片"}

本次使用的评分标准 JSON：
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
  throwIfOperationCancelled(operationId);
  const parsed = directVisionGradeSchema.parse(response.data);
  const evidence: AnswerEvidence = normalizeEvidenceReferences(parsed.evidence);
  const seenSubquestions = new Set<string>();
  const finalAnswerJudgements: FinalAnswerJudgement[] = parsed.finalAnswerJudgements.flatMap((item) => {
    if (!questionIds.includes(item.subquestionId) || seenSubquestions.has(item.subquestionId)) return [];
    seenSubquestions.add(item.subquestionId);
    return [{ ...item, decisionSource: "teacher_model" as const }];
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
  logProgress(operationId, "grading", "vision_direct_result_ready", "教师模型直批结果已返回，正在按模型决定汇总分数和复核状态", {
    durationMs: response.durationMs,
    evidenceLines: evidence.lines.length,
    finalAnswers: finalAnswerJudgements.length,
    decisions: decisions.length,
    deductions: appliedDeductions.length,
    missingFinalAnswers,
    missingPoints
  }, missingFinalAnswers.length || missingPoints.length ? "warning" : "success");

  const localReview = await reviewUnreadablePoints(config, input, operationId, input.imageBuffer, image, evidence, decisions, finalAnswerJudgements);
  const numericReview = await reviewNumericFinalAnswers(
    config,
    input,
    operationId,
    input.imageBuffer,
    evidence,
    localReview.finalAnswerJudgements
  );
  const result = calculateGrade({
    id: input.id,
    studentId: input.studentId,
    fileName: input.fileName,
    rubric: input.rubric,
    evidence,
    finalAnswerJudgements: numericReview.finalAnswerJudgements,
    decisions: localReview.decisions,
    appliedDeductions,
    modelName: config.visionModel,
    gradingMode: "vision_direct",
    evidenceValidationMode: "direct_visual",
    durationMs: response.durationMs + localReview.durationMs + numericReview.durationMs,
    unreadableReviewThreshold: config.unreadableReviewThreshold,
    operationId,
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason
  });
  result.teacherCommentary = finalizeTeacherCommentary(parsed.teacherCommentary, result, config.visionModel);
  throwIfOperationCancelled(operationId);
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
    throwIfOperationCancelled(operationId);
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

根据物理意义比较学生实际写出的最终答案与本次使用的评分标准。接受代数等价、根式等价、分数等价、合理的测量与舍入误差、单位换算、变量大小写或命名差异、多个结果顺序变化，以及学生明确说明的方向变化。不得使用或模拟字符串、公式模板、固定数值容差白名单等机械匹配。最终答案包括大小、方向、单位和题目要求的全部结果。

不得因为中间过程缺失而否定已经清晰写出的正确最终答案。不得根据你自己求解题目得到的结果修改学生答案或参考答案。没有清晰、未划掉的最终答案时返回missing，evidenceLineIds应为空；只有在卷面上确实存在疑似最终答案、但字迹或含义无法可靠确认时才返回uncertain，并引用相关卷面行。已经划掉的数值、公式或结论不能作为最终答案。confidence表示你对当前状态判断的可靠程度，不表示结论方向。correct或incorrect必须引用至少一条实际、未划掉且可识别的卷面行。每个小问必须恰好返回一条finalAnswerJudgement。`,
      prompt: `请对本次使用的评分标准中的每个小问独立判定最终答案。你必须同时核对学生原图与卷面转录；转录只是辅助证据，原图可以纠正转录遗漏，但不得补写学生没有写出的内容。

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
    throwIfOperationCancelled(operationId);
    const parsedFinalAnswers = finalAnswerJudgementsSchema.parse(finalAnswerResponse.data);
    const knownSubquestions = new Set(input.rubric.subquestions.map((item) => item.id));
    const seenSubquestions = new Set<string>();
    const finalAnswerJudgements: FinalAnswerJudgement[] = parsedFinalAnswers.finalAnswerJudgements.flatMap((item) => {
      if (!knownSubquestions.has(item.subquestionId) || seenSubquestions.has(item.subquestionId)) return [];
      seenSubquestions.add(item.subquestionId);
      return [{ ...item, decisionSource: "teacher_model" as const }];
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
        system: `你是高中物理评分点判分模型。严格依据给定评分标准和卷面证据判断每一个评分点，不得补写学生没有写出的内容或创造评分点。最终答案状态由上一步教师模型确定，你不得修改它。即使最终答案状态为correct，也必须逐点评审并返回审验结论。你的 satisfied、not_satisfied、not_present、unreadable 决定将直接用于计分，本地程序只按锁定分值加总。

每个评分点只能使用以下状态：
- satisfied：存在清晰、未划掉、可识别的有效卷面证据，且明确满足评分点；requiresReview=false。
- not_satisfied：存在清晰有效证据，但内容明确错误或不满足评分点；requiresReview=false。
- not_present：有效卷面中没有出现评分点要求的公式、关系、物理量或结论，或者只出现了已经划掉的内容；requiresReview=false。没有写出相关内容不能返回unreadable。
- unreadable：确实存在与评分点相关的作答痕迹，但字迹、涂改或公式结构无法可靠辨认；requiresReview=true并说明需核对的区域。该字段只表示复核候选，最终是否进入人工复核由本地汇总程序按整卷影响分值和教师设置的阈值决定。

只有satisfied可以获得该评分点分数。not_satisfied、not_present和unreadable当前都不得给分。你必须自行判断学生实际写出表达的数学和物理等价关系，不得使用逐字匹配思路，也不得把 expected 当作只能逐字复现的模板。明确写出的移项、约分或变量替换可以正常得分，例如 p=p₀+mg/S 与 pS=p₀S+mg 等价；但不得根据具体数字反推学生“可能写过”某个字母公式。无法找到有效证据时优先返回not_present，不得把所有未出现的步骤统一标为unreadable。已划掉内容不能证明评分点完成。confidence表示你对状态判断的可靠程度，不是正确或错误标签。核心公式实际写出且正确时应判为satisfied，即使后续计算错误；同一错误不得重复触发扣分。

${SCORE_POINT_EVIDENCE_PROTOCOL}

在同一次响应中生成teacherCommentary。评语只能总结本次decisions、教师最终答案结论和卷面证据，不得重新解题、修改分数或创造评分点。最终答案正确且触发满分的小问，过程问题只能列入auditConcerns，不能列入lostPoints。所有引用必须使用已有的小问ID、评分点ID和证据行号；overallComment不写具体总分，由本地计分引擎负责。`,
        prompt: `必须判断本次评分标准中的每一个评分点：${processSubquestionIds.join(", ")}。最终答案正确的小问也不能跳过。所有评分点必须使用同一证据标准，不能因为最终答案状态而改变客观审验结论。审验结果用于过程展示、审计和复核；如果最终答案状态为correct，任何过程问题都不能降低该小问最终得分。本地程序只按照你的逐点决定和当前版本分值汇总总分，你只返回客观的逐点评审结果。

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
      logProgress(operationId, "grading", "process_audit_ready", "所有小问的评分点判分完成，正在按模型决定汇总分数", {
        subquestions: processSubquestionIds,
        decisions: decisions.length,
        deductions: appliedDeductions.length,
        durationMs: processResponse.durationMs,
        finalAnswerCorrectStillAudited: true
      });
    } catch (error) {
      if (isOperationCancelled(error)) throw error;
      processAuditError = error instanceof Error ? error.message : String(error);
      logProgress(operationId, "grading", "process_audit_failed", "过程审验模型调用失败，缺失评分点将按未完成计0分并进入人工复核", {
        error: processAuditError,
        subquestions: processSubquestionIds
      }, "warning");
    }

    const localReview = await reviewUnreadablePoints(config, input, operationId, input.imageBuffer, image, evidence, decisions, finalAnswerJudgements);
    const numericReview = await reviewNumericFinalAnswers(
      config,
      input,
      operationId,
      input.imageBuffer,
      evidence,
      localReview.finalAnswerJudgements
    );
    const result = calculateGrade({
      id: input.id,
      studentId: input.studentId,
      fileName: input.fileName,
      rubric: input.rubric,
      evidence,
      finalAnswerJudgements: numericReview.finalAnswerJudgements,
      decisions: localReview.decisions,
      appliedDeductions,
      modelName: config.visionModel,
      gradingMode: "evidence_pipeline",
      evidenceValidationMode: "extracted_text",
      durationMs: extraction.durationMs + finalAnswerResponse.durationMs + processDurationMs + localReview.durationMs + numericReview.durationMs,
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
    throwIfOperationCancelled(operationId);
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
