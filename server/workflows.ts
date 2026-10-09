import type {
  AnswerLine,
  AnswerEvidence,
  AppliedDeduction,
  FinalAnswerJudgement,
  GradingResult,
  OcrTranscription,
  OcrTranscriptionLine,
  PaddleOcrAudit,
  Rubric,
  RubricDecision,
  ScorePoint,
  StudentAnswerReconstruction,
  TeacherCommentary
} from "../shared/types.js";
import sharp from "sharp";
import { calculateGrade, createFallbackTeacherCommentary, normalizeEvidenceReferences, REVIEW_CONFIDENCE_THRESHOLD, TEACHER_COMMENTARY_VERSION } from "./gradingEngine.js";
import { callStructured } from "./modelClient.js";
import { resolveModelRoute } from "./modelRouting.js";
import {
  evidenceJsonSchema,
  evidenceSchema,
  compactDirectVisionGradeJsonSchema,
  compactDirectVisionGradeSchema,
  directVisionGradeCoreSchema,
  finalAnswerJudgementsJsonSchema,
  finalAnswerJudgementsSchema,
  localNumericAnswerReviewJsonSchema,
  localNumericAnswerReviewSchema,
  processJudgementWithCommentaryJsonSchema,
  processJudgementWithCommentarySchema,
  smallQuestionDisputeArbitrationJsonSchema,
  smallQuestionDisputeArbitrationSchema,
  smallQuestionGradeJsonSchema,
  smallQuestionGradeSchema,
  studentAnswerReconstructionJsonSchema,
  studentAnswerReconstructionSchema,
  unreadableLocalReviewJsonSchema,
  unreadableLocalReviewSchema,
  assertRubricIntegrity,
  rubricJsonSchema,
  rubricSchema,
  validateRubricTotals
} from "./schemas.js";
import type { GradingMode, ModelConfigInput } from "../shared/types.js";
import { DEFAULT_GRADING_MODE, DEFAULT_QUESTION_TYPE } from "../shared/types.js";
import {
  COMPACT_SCORE_POINT_EVIDENCE_PROTOCOL,
  getBuiltInSystemPrompt,
  SCORE_POINT_EVIDENCE_PROTOCOL,
  STUDENT_IMAGE_INPUT_GUIDANCE
} from "../shared/modelPrompts.js";
import { runPaddleOcr } from "./paddleOcr.js";
import { comparePhysicsAnswer, PHYSICS_SIGN_POLICY_GUIDANCE } from "./physicsAnswerEquivalence.js";
import { normalizeDirectVisualReviewPlan, runDirectVisualReview, type DirectVisualReviewPayloadItem } from "./directVisualReview.js";
import { gradeLargeQuestionStaged } from "./largeQuestionGrading.js";
import { gradeLargeQuestionResponsesAgent } from "./responsesAgentGrading.js";
import { preprocessStudentAnswerImage, type StudentAnswerImagePreparation } from "./imagePreprocess.js";
import { normalizeFinalAnswerJudgement } from "./finalAnswerNormalization.js";
import { combineFinalAnswerExpression } from "../shared/finalAnswer.js";
import type { GradingArtifactSource } from "./gradingArtifactStore.js";
import {
  beginOperation,
  completeOperation,
  failOperation,
  getOperationSignal,
  isOperationCancelled,
  logProgress,
  releaseOperationModelCalls,
  throwIfOperationCancelled
} from "./systemLog.js";

interface GradingImage {
  mimeType: string;
  base64: string;
  label?: string;
}

interface PreparedStudentAnswer {
  preparation: StudentAnswerImagePreparation;
  studentImage: GradingImage;
  modelImages: GradingImage[];
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
  /** Controlled large-question replay input; live grading leaves this unset. */
  ocrAudit?: PaddleOcrAudit;
  previousResultId?: string;
  regradedAt?: string;
  regradeReason?: string;
}

function validateDirectVisionGradeCompleteness(
  value: unknown,
  questionIds: readonly string[],
  pointKeys: ReadonlySet<string>,
  options: { allowIncomplete?: boolean } = {}
) {
  const parsed = directVisionGradeCoreSchema.parse(value);
  const returnedQuestionIds = new Set(parsed.finalAnswerJudgements.map((item) => item.subquestionId));
  const returnedPointKeys = new Set(parsed.decisions.map((item) => `${item.subquestionId}:${item.pointId}`));
  const missingFinalAnswers = questionIds.filter((id) => !returnedQuestionIds.has(id));
  const missingPoints = [...pointKeys].filter((key) => !returnedPointKeys.has(key));
  const unknownFinalAnswers = [...returnedQuestionIds].filter((id) => !questionIds.includes(id));
  const unknownPoints = [...returnedPointKeys].filter((key) => !pointKeys.has(key));
  const duplicateFinalAnswers = parsed.finalAnswerJudgements.length !== returnedQuestionIds.size;
  const duplicatePoints = parsed.decisions.length !== returnedPointKeys.size;
  if (!options.allowIncomplete && (missingFinalAnswers.length || missingPoints.length || unknownFinalAnswers.length || unknownPoints.length || duplicateFinalAnswers || duplicatePoints)) {
    const details: string[] = [];
    if (missingFinalAnswers.length) details.push(`缺少小问最终答案判定：${missingFinalAnswers.join("、")}`);
    if (missingPoints.length) details.push(`缺少评分点判断：${missingPoints.join("、")}`);
    if (unknownFinalAnswers.length) details.push(`返回了未知小问：${unknownFinalAnswers.join("、")}`);
    if (unknownPoints.length) details.push(`返回了未知评分点：${unknownPoints.join("、")}`);
    if (duplicateFinalAnswers) details.push("重复返回小问最终答案判定");
    if (duplicatePoints) details.push("重复返回评分点判断");
    throw new Error(`教师模型直批结果不完整：${details.join("；")}`);
  }
  return parsed;
}

function hasCompactDirectGradingContent(parsed: ReturnType<typeof compactDirectVisionGradeSchema.parse>): boolean {
  return parsed.evidence.lines.length > 0
    || parsed.evidence.finalAnswers.length > 0
    || (parsed.transcription?.lines.length ?? 0) > 0
    || parsed.finalAnswerJudgements.length > 0
    || parsed.pointJudgements.satisfied.length > 0
    || parsed.pointJudgements.notSatisfied.length > 0
    || parsed.pointJudgements.notPresent.length > 0
    || parsed.pointJudgements.unreadable.length > 0
    || parsed.appliedDeductions.length > 0
    || parsed.review_required
    || parsed.review_items.length > 0;
}

function normalizeDuplicateDirectDecisions(
  decisions: Array<Record<string, unknown>>
): { decisions: Array<Record<string, unknown>>; duplicatePointKeys: string[] } {
  const byPointKey = new Map<string, Record<string, unknown>>();
  const duplicatePointKeys = new Set<string>();
  for (const decision of decisions) {
    const key = `${String(decision.subquestionId)}:${String(decision.pointId)}`;
    const existing = byPointKey.get(key);
    if (!existing) {
      byPointKey.set(key, decision);
      continue;
    }
    duplicatePointKeys.add(key);
    const existingEvidence = Array.isArray(existing.evidenceLineIds) ? existing.evidenceLineIds : [];
    const currentEvidence = Array.isArray(decision.evidenceLineIds) ? decision.evidenceLineIds : [];
    const evidenceDecision = currentEvidence.length > 0 ? decision : existingEvidence.length > 0 ? existing : undefined;
    if (!evidenceDecision) {
      byPointKey.set(key, {
        ...existing,
        requiresReview: true,
        reviewReason: "教师模型重复返回该评分点且没有可用证据，需人工复核",
        reason: `${String(existing.reason ?? "")}; 教师模型重复返回该评分点，已标记复核。`
      });
      continue;
    }
    byPointKey.set(key, {
      ...evidenceDecision,
      status: "unreadable",
      awardedScore: undefined,
      requiresReview: true,
      reviewReason: "教师模型重复返回该评分点且结论不一致，已取消自动计分并标记复核",
      reason: `${String(evidenceDecision.reason ?? "")}; 教师模型重复返回该评分点且结论不一致，已取消自动计分并标记复核。`
    });
  }
  return { decisions: [...byPointKey.values()], duplicatePointKeys: [...duplicatePointKeys] };
}

function expandCompactDirectVisionGrade(
  value: unknown,
  rubric: Rubric,
  questionIds: readonly string[],
  pointKeys: ReadonlySet<string>
) {
  const parsed = compactDirectVisionGradeSchema.parse(value);
  const linesById = new Map(parsed.evidence.lines.map((line) => [line.id, line]));
  const assertEvidence = (
    label: string,
    lineIds: string[],
    allowedStatuses: ReadonlySet<string>,
    requireText = true
  ) => {
    if (lineIds.length === 0) throw new Error(`${label}必须引用至少一条有效证据行`);
    const invalid = lineIds.filter((lineId) => {
      const line = linesById.get(lineId);
      return !line
        || !allowedStatuses.has(line.status)
      || (requireText && !(line.text.trim() || line.latex?.trim()));
    });
    if (invalid.length) throw new Error(`${label}引用了无效证据行：${invalid.join("、")}`);
  };
  const finalAnswerJudgements = parsed.finalAnswerJudgements.map((item) => {
    const hasUncertainEvidence = item.evidenceLineIds.some((lineId) => linesById.get(lineId)?.status === "uncertain");
    if (item.status === "correct" && hasUncertainEvidence) {
      return {
        ...item,
        status: "uncertain" as const,
        confidence: Math.min(item.confidence, 0.49),
        reason: `${item.reason}；引用的卷面证据存在不确定区域，已转入局部复核。`
      };
    }
    const normalized = normalizeFinalAnswerJudgement(item);
    return normalized.judgement;
  });
  finalAnswerJudgements.forEach((item) => {
    if (item.status === "correct") {
      assertEvidence(`${item.subquestionId}最终答案判定`, item.evidenceLineIds, new Set(["active"]));
    } else if (item.status === "incorrect") {
      // An incorrect read may cite an uncertain line when that uncertainty is
      // exactly why the local visual review must be requested. It must not be
      // accepted as a final score without the review path below.
      assertEvidence(`${item.subquestionId}最终答案判定`, item.evidenceLineIds, new Set(["active", "uncertain"]));
    } else if (item.status === "uncertain") {
      assertEvidence(`${item.subquestionId}最终答案判定`, item.evidenceLineIds, new Set(["active", "uncertain"]), false);
    }
  });
  const evidenceQuote = (lineIds: string[]) => lineIds
    .map((lineId) => linesById.get(lineId))
    .filter((line): line is NonNullable<typeof line> => Boolean(line))
    .map((line) => line.text.trim() || line.latex?.trim() || "")
    .filter(Boolean)
    .join("；");
  const knownPointKeys = new Set<string>(pointKeys);
  const pointMap = new Map<string, { subquestionId: string; pointId: string }>(rubric.subquestions.flatMap((subquestion) => subquestion.scorePoints.map((point) => [
    `${subquestion.id}:${point.id}`,
    { subquestionId: subquestion.id, pointId: point.id }
  ] as const)));
  const pointScoreMap = new Map<string, number>(rubric.subquestions.flatMap((subquestion) => subquestion.scorePoints.map((point) => [
    `${subquestion.id}:${point.id}`,
    point.score
  ] as const)));
  const decisions: Array<Record<string, unknown>> = [];
  const add = (status: "satisfied" | "not_satisfied" | "unreadable", item: { pointKey: string; evidenceLineIds: string[]; reason: string; confidence: number; awardedScore?: number }) => {
    const hasUncertainEvidence = item.evidenceLineIds.some((lineId) => linesById.get(lineId)?.status === "uncertain");
    const normalizedStatus = status !== "unreadable" && hasUncertainEvidence ? "unreadable" as const : status;
    const normalizedReason = normalizedStatus === "unreadable" && status !== "unreadable"
      ? `${item.reason}；引用的卷面证据存在不确定区域，已转入复核。`
      : item.reason;
    assertEvidence(
      `${item.pointKey}评分点 ${normalizedStatus}`,
      item.evidenceLineIds,
      normalizedStatus === "unreadable" ? new Set(["active", "uncertain"]) : new Set(["active"]),
      normalizedStatus !== "unreadable"
    );
    const ids = pointMap.get(item.pointKey);
    const maxScore = pointScoreMap.get(item.pointKey);
    const normalizedAwardedScore = normalizedStatus === "unreadable" && status !== "unreadable"
      ? undefined
      : item.awardedScore;
    if (normalizedAwardedScore !== undefined) {
      if (!Number.isFinite(normalizedAwardedScore) || normalizedAwardedScore < 0 || maxScore === undefined || normalizedAwardedScore > maxScore) {
        throw new Error(`${item.pointKey}评分点 awardedScore 超出该评分点分值范围`);
      }
      if (normalizedStatus === "unreadable") {
        throw new Error(`${item.pointKey}无法辨认评分点不能同时返回 awardedScore`);
      }
      if (normalizedStatus === "satisfied" && normalizedAwardedScore < maxScore) {
        throw new Error(`${item.pointKey}部分得分必须使用 not_satisfied 状态`);
      }
    }
    if (!ids || !knownPointKeys.has(item.pointKey)) {
       decisions.push({ subquestionId: "__unknown__", pointId: item.pointKey, status: normalizedStatus, evidenceLineIds: item.evidenceLineIds, evidenceQuote: evidenceQuote(item.evidenceLineIds), reason: normalizedReason, confidence: item.confidence, requiresReview: normalizedStatus === "unreadable", ...(normalizedStatus === "unreadable" || normalizedAwardedScore === undefined ? {} : { awardedScore: normalizedAwardedScore }), ...(normalizedStatus === "unreadable" ? { reviewReason: normalizedReason, decisionSource: "normalized_uncertain" } : {}) });
      return;
    }
    decisions.push({
      subquestionId: ids.subquestionId,
      pointId: ids.pointId,
      status: normalizedStatus,
      evidenceLineIds: item.evidenceLineIds,
      evidenceQuote: evidenceQuote(item.evidenceLineIds),
      reason: normalizedReason,
      confidence: item.confidence,
      requiresReview: normalizedStatus === "unreadable",
       ...(normalizedStatus === "unreadable" || normalizedAwardedScore === undefined ? {} : { awardedScore: normalizedAwardedScore }),
      ...(normalizedStatus === "unreadable" ? { reviewReason: normalizedReason, decisionSource: "normalized_uncertain" } : {})
    });
  };
  parsed.pointJudgements.satisfied.forEach((item) => add("satisfied", item));
  parsed.pointJudgements.notSatisfied.forEach((item) => add("not_satisfied", item));
  parsed.pointJudgements.unreadable.forEach((item) => add("unreadable", item));
  parsed.pointJudgements.notPresent.forEach((pointKey) => {
    const ids = pointMap.get(pointKey);
    decisions.push({
      subquestionId: ids?.subquestionId ?? "__unknown__",
      pointId: ids?.pointId ?? pointKey,
      status: "not_present",
      evidenceLineIds: [],
      evidenceQuote: "",
      reason: "未见评分点要求的有效卷面证据",
      confidence: 1,
      requiresReview: false
    });
  });
  const normalizedDecisions = normalizeDuplicateDirectDecisions(decisions);
  const returnedQuestionIds = new Set(finalAnswerJudgements.map((item) => item.subquestionId));
  const returnedPointKeys = new Set(normalizedDecisions.decisions.map((item) => `${String(item.subquestionId)}:${String(item.pointId)}`));
  const hasCompletenessIssue = questionIds.some((id) => !returnedQuestionIds.has(id))
    || [...pointKeys].some((key) => !returnedPointKeys.has(key))
    || [...returnedQuestionIds].some((id) => !questionIds.includes(id))
    || [...returnedPointKeys].some((key) => !pointKeys.has(key))
    || finalAnswerJudgements.length !== returnedQuestionIds.size
    || decisions.length !== normalizedDecisions.decisions.length;
  if (!hasCompactDirectGradingContent(parsed)) {
    return validateDirectVisionGradeCompleteness({
      evidence: parsed.evidence,
      transcription: parsed.transcription,
      finalAnswerJudgements,
      decisions: normalizedDecisions.decisions,
      appliedDeductions: parsed.appliedDeductions,
      review_required: parsed.review_required,
      review_items: parsed.review_items
    }, questionIds, pointKeys);
  }
  return validateDirectVisionGradeCompleteness({
    evidence: parsed.evidence,
    transcription: parsed.transcription,
    finalAnswerJudgements,
    decisions: normalizedDecisions.decisions,
    appliedDeductions: parsed.appliedDeductions,
    review_required: parsed.review_required || hasCompletenessIssue,
    review_items: parsed.review_items
  }, questionIds, pointKeys, { allowIncomplete: true });
}

function createDirectGradingRubricProjection(rubric: Rubric) {
  return {
    title: rubric.title,
    recognizedQuestionText: rubric.recognizedQuestionText,
    totalScore: rubric.totalScore,
    subquestions: rubric.subquestions.map((subquestion) => ({
      id: subquestion.id,
      title: subquestion.title,
      maxScore: subquestion.maxScore,
      finalAnswerPolicy: subquestion.finalAnswerPolicy,
      finalAnswers: subquestion.finalAnswers,
      scorePoints: subquestion.scorePoints,
      deductions: subquestion.deductions
    }))
  };
}

function dedupeGradingImages(images: GradingImage[]): GradingImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = `${image.mimeType}:${image.base64}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ocrBlockRegion(block: NonNullable<PaddleOcrAudit["layoutBlocks"]>[number]): [number, number, number, number] {
  const [x1, y1, x2, y2] = block.coordinate;
  return [x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1)];
}

/**
 * Keep the complete OCR-block transcription separate from scoring evidence.
 * The teacher supplies corrected text/status; the program supplies the
 * trusted block coordinates and metadata instead of accepting model pixels.
 */
function normalizeOcrTranscription(value: unknown, ocr: PaddleOcrAudit): OcrTranscription | undefined {
  if (!Array.isArray(ocr.layoutBlocks)) return undefined;
  const blocks = ocr.layoutBlocks;
  const blocksById = new Map(blocks.map((block) => [block.blockId, block]));
  const rawLines = value && typeof value === "object" && !Array.isArray(value)
    && Array.isArray((value as { lines?: unknown }).lines)
    ? (value as { lines: unknown[] }).lines
    : [];
  const seenBlockIds = new Set<string>();
  const lines: OcrTranscriptionLine[] = rawLines.flatMap((candidate): OcrTranscriptionLine[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const raw = candidate as {
      block_id?: unknown;
      text?: unknown;
      latex?: unknown;
      status?: unknown;
      confidence?: unknown;
      alternatives?: unknown;
    };
    const blockId = typeof raw.block_id === "string" ? raw.block_id.trim() : "";
    const block = blocksById.get(blockId);
    if (!block || seenBlockIds.has(blockId)) return [];
    seenBlockIds.add(blockId);
    const status = raw.status === "active" || raw.status === "crossed_out" || raw.status === "uncertain"
      ? raw.status
      : "uncertain";
    const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0;
    const text = typeof raw.text === "string" ? raw.text : "";
    const latex = typeof raw.latex === "string" ? raw.latex : undefined;
    const alternatives = Array.isArray(raw.alternatives)
      ? raw.alternatives.filter((item): item is string => typeof item === "string")
      : [];
    return [{
      id: `OCR-${block.blockId}`,
      text,
      ...(latex === undefined ? {} : { latex }),
      region: ocrBlockRegion(block),
      status,
      confidence,
      alternatives,
      blockId: block.blockId,
      blockLabel: block.label,
      ocrScore: block.score
    }];
  });
  const missingBlockIds = blocks
    .map((block) => block.blockId)
    .filter((blockId) => !seenBlockIds.has(blockId));
  return {
    lines,
    blockCount: blocks.length,
    verifiedBlockCount: lines.length,
    missingBlockIds
  };
}

async function prepareStudentAnswerForModels(
  input: StudentAnswerGradingInput,
  operationId: string
): Promise<PreparedStudentAnswer> {
  logProgress(operationId, "grading", "student_image_preprocess_started", "正在对学生答卷图执行本地清晰度增强", {
    inputBytes: input.imageBuffer.length,
    inputMimeType: input.mimeType,
    mode: process.env.HENGZHUN_STUDENT_IMAGE_PREPROCESSING?.trim() || "enhanced"
  });
  const preparation = await preprocessStudentAnswerImage({
    imageBuffer: input.imageBuffer,
    mimeType: input.mimeType
  });
  const studentImage: GradingImage = {
    mimeType: preparation.mimeType,
    base64: preparation.buffer.toString("base64"),
    label: preparation.audit.applied
      ? "[学生答卷图（本地预处理结果）]"
      : "[学生答卷图（预处理回退结果）]"
  };
  const modelImages = [studentImage];
  logProgress(operationId, "grading", "student_image_preprocess_completed", preparation.audit.applied
    ? "学生答卷图本地增强完成，后续 OCR 和视觉模型只使用预处理结果图"
    : "学生答卷图本地增强未生效，后续 OCR 和视觉模型只使用回退结果图", {
    applied: preparation.audit.applied,
    mode: preparation.audit.mode,
    outputBytes: preparation.audit.outputBytes,
    outputMimeType: preparation.audit.outputMimeType,
    width: preparation.audit.width,
    height: preparation.audit.height,
    geometryPreserved: preparation.audit.geometryPreserved,
    operations: preparation.audit.operations,
    fallbackReason: preparation.audit.fallbackReason,
    modelImages: modelImages.length
  }, preparation.audit.applied ? "success" : "warning");
  return { preparation, studentImage, modelImages };
}

function createGradingArtifactSource(input: StudentAnswerGradingInput, preparedStudentAnswer: PreparedStudentAnswer): GradingArtifactSource {
  return {
    preprocessedStudentAnswer: {
      buffer: preparedStudentAnswer.preparation.buffer,
      mimeType: preparedStudentAnswer.preparation.mimeType,
      fileName: input.fileName
    },
    questionImages: [...(input.questionImages ?? [])],
    referenceImages: [...(input.referenceImages ?? [])],
    questionText: input.questionText,
    referenceText: input.referenceText,
    rubric: input.rubric
  };
}

export async function structureRubric(config: ModelConfigInput, input: {
  questionText: string;
  referenceText: string;
  questionImages: Express.Multer.File[];
  referenceImages: Express.Multer.File[];
  questionType?: Rubric["questionType"];
}): Promise<Rubric> {
  const questionType = input.questionType ?? DEFAULT_QUESTION_TYPE;
  const operationId = beginOperation("rubric", "开始生成结构化评分标准", "prepare_materials", {
    questionType,
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
    const route = resolveModelRoute(config, images.length ? "rubric_structure_vision" : "rubric_structure_text");
    const model = route.model;
    logProgress(operationId, "model", "rubric_model_call", "已发送材料，等待模型读取题目并结构化评分标准", {
      model,
      routeKey: route.routeKey,
      questionType,
      imageCount: images.length
    });
    const result = await callStructured<unknown>(route.config, {
      model,
      routeKey: route.routeKey,
      system: getBuiltInSystemPrompt(route.routeKey, questionType),
      prompt: `将以下高中物理题目和参考评分标准拆成原子评分规则。紧随题目文字之后的图片属于题目，标记为参考答案图片的内容只属于参考答案。必须读取图中的物理量标注、方向和几何关系，但不得自行补充图中不存在的信息。请把完整题干忠实转录到recognizedQuestionText；其中行内公式使用$...$，独立公式使用$$...$$，保留题号、小问、单位和图示引用。无法辨认的部分写作[无法辨认]并加入warnings，禁止猜测。每个finalAnswers对象必须表示一套完整可接受的最终答案；一道小问要求多个物理量时，把多个等式放在同一个expression中并分别使用$...$分隔。每个 finalAnswers 必须设置 signPolicy：无法从题目或评分标准确认时使用 unspecified，不得猜测；需要时忠实填写 positiveDirection、subject 和 signConvention。必须按证据对象准确设置评分点 type：要求写出字母关系或原理用 formula，要求把数据代入关系用 substitution，要求最终值、单位或方向用 result，要求文字解释用 text；不得把“列公式”和“代入计算”混为同一个类型。本系统规定：最终答案经教师模型确认正确时，该小问过程审验不得降低得分，因此所有小问的finalAnswerPolicy统一标记为full_credit；仍须完整保留过程评分点，用于最终答案错误、缺失或无法确认时计分，并用于审计和复核。文档未明确的信息写入warnings。

题目：
${input.questionText}

参考答案与评分标准：
${input.referenceText}`,
      images,
      schemaName: "physics_rubric",
      schema: rubricJsonSchema,
      validate: (value) => rubricSchema.parse(value),
      reasoningEffort: route.reasoningEffort,
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
      questionType,
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
      questionType: rubric.questionType,
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
  if (candidate.questionType !== original.questionType) reject("题型；题型保存后不可修改");
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
    questionType: original.questionType,
    instructionCharacters: instruction.length
  });
  try {
    assertRubricIntegrity(original);
    const route = resolveModelRoute(config, "rubric_refinement");
    logProgress(operationId, "model", "rubric_refinement_model_call", "已发送当前评分标准和教师补充要求", {
      model: route.model,
      routeKey: route.routeKey
    });
    const response = await callStructured<unknown>(route.config, {
      model: route.model,
      routeKey: route.routeKey,
      system: getBuiltInSystemPrompt(route.routeKey, original.questionType),
      prompt: `教师补充要求：
${instruction}

当前完整评分标准 JSON：
${JSON.stringify(original, null, 2)}`,
      schemaName: "physics_rubric_refinement",
      schema: rubricJsonSchema,
      validate: (value) => rubricSchema.parse(value),
      reasoningEffort: route.reasoningEffort,
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
      questionType: refined.questionType,
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
    label: `[${purpose}：预处理答卷图区域 x=${left}, y=${top}, w=${width}, h=${height}]`
  };
}

function reviewBlockForEvidenceLine(
  ocr: PaddleOcrAudit,
  line: AnswerLine,
  sourceWidth: number,
  sourceHeight: number
): string | undefined {
  const blocks = (ocr.layoutBlocks ?? []).filter((block) => {
    const [x1, y1, x2, y2] = block.coordinate;
    return Boolean(block.blockId.trim()) && [x1, y1, x2, y2].every(Number.isFinite) && x2 > x1 && y2 > y1;
  });
  if (!blocks.length) return undefined;
  const directBlockId = line.id.match(/^line-(block-[^:]+)$/)?.[1];
  if (directBlockId && blocks.some((block) => block.blockId === directBlockId)) return directBlockId;
  if (!line.region || !sourceWidth || !sourceHeight || !ocr.imageWidth || !ocr.imageHeight) {
    return blocks[0]?.blockId;
  }
  const [x, y, width, height] = line.region;
  const scaleX = ocr.imageWidth / sourceWidth;
  const scaleY = ocr.imageHeight / sourceHeight;
  const targetLeft = x * scaleX;
  const targetTop = y * scaleY;
  const targetRight = (x + width) * scaleX;
  const targetBottom = (y + height) * scaleY;
  const targetArea = Math.max(1, (targetRight - targetLeft) * (targetBottom - targetTop));
  const scored = blocks.map((block) => {
    const [rawX1, rawY1, rawX2, rawY2] = block.coordinate;
    const left = Math.min(rawX1, rawX2);
    const top = Math.min(rawY1, rawY2);
    const right = Math.max(rawX1, rawX2);
    const bottom = Math.max(rawY1, rawY2);
    const intersectionWidth = Math.max(0, Math.min(targetRight, right) - Math.max(targetLeft, left));
    const intersectionHeight = Math.max(0, Math.min(targetBottom, bottom) - Math.max(targetTop, top));
    const intersection = intersectionWidth * intersectionHeight;
    const blockArea = Math.max(1, (right - left) * (bottom - top));
    const union = targetArea + blockArea - intersection;
    const targetCoverage = intersection / targetArea;
    const iou = intersection / Math.max(1, union);
    const targetCenterX = (targetLeft + targetRight) / 2;
    const targetCenterY = (targetTop + targetBottom) / 2;
    const blockCenterX = (left + right) / 2;
    const blockCenterY = (top + bottom) / 2;
    const centerDistance = Math.hypot(targetCenterX - blockCenterX, targetCenterY - blockCenterY);
    return { block, score: targetCoverage * 0.55 + iou * 0.45, centerDistance };
  });
  scored.sort((left, right) => right.score - left.score || left.centerDistance - right.centerDistance);
  return scored[0]?.block.blockId;
}

function finalAnswerTexts(subquestion: Rubric["subquestions"][number]): string[] {
  return subquestion.finalAnswers
    .map((answer) => combineFinalAnswerExpression(answer.expression, answer.unit))
    .filter(Boolean);
}

function finalAnswerText(subquestion: Rubric["subquestions"][number]): string {
  return finalAnswerTexts(subquestion).join(" 或 ");
}

function normalizeFinalAnswerValue(value: string): string {
  let normalized = value.trim().toLowerCase()
    .replace(/\\left|\\right/g, "")
    .replace(/\\(?:d?frac)\s*\{\\sqrt\s*\{([^{}]*)\}\}\s*(?:\{([^{}]*)\}|([a-z0-9.+−-]+))/g, (_, numerator: string, bracedDenominator: string | undefined, plainDenominator: string | undefined) => `sqrt(${numerator})/(${bracedDenominator ?? plainDenominator ?? ""})`)
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, "sqrt($1)")
    .replace(/\\(?:d?frac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\(?:mathrm|text|textrm)\s*\{([^{}]*)\}/g, "$1")
    .replace(/√\s*\{([^{}]*)\}/g, "sqrt($1)")
    .replace(/√\s*\(([^()]*)\)/g, "sqrt($1)")
    .replace(/√\s*([a-z0-9.+−-]+)/g, "sqrt($1)");
  const equalIndex = normalized.lastIndexOf("=");
  if (equalIndex >= 0) normalized = normalized.slice(equalIndex + 1);
  return normalized
    .replace(/\b(?:m\s*\/\s*s|m\s*s\^[-−]?1)\b/g, "")
    .replace(/[{}\s()]/g, "")
    .replace(/\\/g, "");
}

function finalAnswerValuesMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeFinalAnswerValue(left);
  const normalizedRight = normalizeFinalAnswerValue(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function answerMatchesAnyFinalAnswer(value: string, subquestion: Rubric["subquestions"][number]): boolean {
  return finalAnswerTexts(subquestion).some((expected) => finalAnswerValuesMatch(value, expected))
    || comparePhysicsAnswer(value, subquestion.finalAnswers).status === "equivalent";
}

function automaticFinalAnswerReviewItems(
  ocr: PaddleOcrAudit,
  rubric: Rubric,
  finalAnswerJudgements: FinalAnswerJudgement[],
  evidence: AnswerEvidence,
  ocrTranscription: OcrTranscription | undefined,
  sourceWidth: number,
  sourceHeight: number
): DirectVisualReviewPayloadItem[] {
  const evidenceById = new Map(evidence.lines.map((line) => [line.id, line]));
  return rubric.subquestions.flatMap((subquestion): DirectVisualReviewPayloadItem[] => {
    const judgement = finalAnswerJudgements.find((item) => item.subquestionId === subquestion.id);
    if (!judgement) return [];
    const expectedAnswers = finalAnswerTexts(subquestion);
    const expected = finalAnswerText(subquestion);
    if (!expectedAnswers.length) return [];
    const teacherAnswer = judgement.studentAnswer.trim();
    const lowConfidence = judgement.confidence < REVIEW_CONFIDENCE_THRESHOLD;
    const isIncorrectOrUncertain = judgement.status === "incorrect" || judgement.status === "uncertain";
    const evidenceLine = judgement.evidenceLineIds
      .map((lineId) => evidenceById.get(lineId))
      .find((line): line is AnswerLine => Boolean(line && line.status !== "crossed_out" && line.region));
    if (!evidenceLine) return [];
    const blockId = reviewBlockForEvidenceLine(ocr, evidenceLine, sourceWidth, sourceHeight);
    if (!blockId) return [];
    const currentOcrLine = ocrTranscription?.lines.find((line) => line.blockId === blockId && line.status !== "crossed_out");
    const ocrLineWithMatchingAnswer = ocrTranscription?.lines.find((line) => {
      if (line.status === "crossed_out") return false;
      return finalAnswerValuesMatch(line.latex ?? "", teacherAnswer)
        || finalAnswerValuesMatch(line.text, teacherAnswer)
        || finalAnswerValuesMatch(line.latex ?? "", judgement.studentAnswer);
    });
    const ocrLine = ocrLineWithMatchingAnswer ?? currentOcrLine;
    const reviewBlockId = ocrLineWithMatchingAnswer?.blockId ?? blockId;
    if (reviewBlockId !== blockId && !(ocr.layoutBlocks ?? []).some((block) => block.blockId === reviewBlockId)) return [];
    const evidenceAlternativeMatchesExpected = evidenceLine.alternatives?.some((candidate) => answerMatchesAnyFinalAnswer(candidate, subquestion)) ?? false;
    const ocrAlternativeMatchesExpected = evidenceAlternativeMatchesExpected
      || (ocrLine?.alternatives?.some((candidate) => answerMatchesAnyFinalAnswer(candidate, subquestion)) ?? false);
    const teacherMatchesExpected = answerMatchesAnyFinalAnswer(teacherAnswer, subquestion);
    const conflictingOcrAlternative = ocrAlternativeMatchesExpected && !teacherMatchesExpected;
    const uncertainVisualEvidence = evidenceLine.status === "uncertain" || ocrLine?.status === "uncertain";
    const reviewBlock = (ocr.layoutBlocks ?? []).find((block) => block.blockId === reviewBlockId);
    const lowConfidenceOcrBlock = (reviewBlock?.score ?? 1) < REVIEW_CONFIDENCE_THRESHOLD;
    const needsVisualReview = isIncorrectOrUncertain && (lowConfidence || conflictingOcrAlternative || uncertainVisualEvidence || lowConfidenceOcrBlock);
    if (!needsVisualReview) return [];
    const recognized = teacherAnswer || "uncertain";
    const reviewRecognized = recognized;
    const candidates = [...new Set([reviewRecognized, ...expectedAnswers])];
    return [{
      review_id: `auto-final-answer-${subquestion.id}`,
       block_id: reviewBlockId,
      criterion_id: `${subquestion.id}:final`,
      target: `${subquestion.title}的最终数值答案`,
      recognized: reviewRecognized,
      candidates,
      reason: conflictingOcrAlternative
        ? "教师最终答案判定与同一 OCR 区块保留的标准答案候选冲突，必须独立核对预处理答卷图"
        : uncertainVisualEvidence
          ? "最终答案对应的卷面证据或 OCR 区块被标记为无法确定，必须独立核对预处理答卷图"
        : lowConfidenceOcrBlock
          ? "最终答案对应的 PaddleOCR 区块置信度低，必须独立核对预处理答卷图"
        : "教师模型对最终答案的判定置信度低且结果为错误或不确定，必须独立核对预处理答卷图",
      score_effect: candidates.map((candidate) => ({
        candidate,
        score: answerMatchesAnyFinalAnswer(candidate, subquestion) ? subquestion.maxScore : 0
      }))
    }];
  });
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

  const configuredReviewModel = config.modelRoutes?.legacy_unreadable_review?.model?.trim() || config.reviewModel?.trim();
  let reviewRoute: ReturnType<typeof resolveModelRoute>;
  try {
    reviewRoute = resolveModelRoute(config, "legacy_unreadable_review");
  } catch (error) {
    logProgress(operationId, "grading", "unreadable_local_review_config_missing", "局部审验模型凭据不完整，无法执行视觉复查", {
      ...(configuredReviewModel ? { model: configuredReviewModel } : {}),
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
    model: reviewRoute.model,
    routeKey: reviewRoute.routeKey,
    targetPoints: reviewableTargets.map((target) => ({ subquestionId: target.subquestionId, pointId: target.pointId, title: target.title, score: target.score })),
    reviewImages: reviewImages.map((item) => item.label)
  });
  try {
    const reviewablePointTargets = reviewableTargets.filter((target) => target.pointId);
    const reviewableFinalAnswerTargets = reviewableTargets.filter((target) => !target.pointId);
    const response = await callStructured<unknown>(reviewRoute.config, {
      model: reviewRoute.model,
      routeKey: reviewRoute.routeKey,
      system: `你是高中物理阅卷复查模型。你正在复查第一次阅卷标记为 unreadable，或同时给出明确状态和人工复核标记而产生矛盾的评分点。当前图片是从预处理答卷图对应坐标裁剪并放大的局部图，只能根据局部图中实际可见的学生笔迹自主决策，禁止根据题目推导结果补写学生答案，禁止把模糊数字猜成期望数字。

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
      images: [...reviewImages, { ...image, label: "[学生答卷图（预处理后，仅用于确认局部坐标与上下文）]" }],
      schemaName: "unreadable_local_review",
      schema: unreadableLocalReviewJsonSchema,
      validate: (value) => unreadableLocalReviewSchema.parse(value),
      reasoningEffort: reviewRoute.reasoningEffort ?? "low",
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
  const reviewModel = config.modelRoutes?.legacy_numeric_review?.model?.trim() || config.reviewModel?.trim();
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

  let reviewRoute: ReturnType<typeof resolveModelRoute>;
  try {
    reviewRoute = resolveModelRoute(config, "legacy_numeric_review");
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
    model: reviewRoute.model,
    routeKey: reviewRoute.routeKey,
    reasoningEffort: reviewRoute.reasoningEffort ?? "low",
    targetSubquestions: reviewableTargets.map((target) => target.subquestionId)
  });
  try {
    const response = await callStructured<unknown>(reviewRoute.config, {
      model: reviewRoute.model,
      routeKey: reviewRoute.routeKey,
      system: `你是答卷局部数值审验模型。每张图只包含某一小问最终答案附近的学生笔迹。你的唯一任务是独立、忠实地重读图中实际写出的数值答案，不得评分，不得查看或推测参考答案，也不得根据物理计算补写模糊字符。

对每个目标返回 observedAnswer 和按出现顺序列出的 numericTokens。numericTokens 只收录学生明确写出的数值，包括正负号、小数、分数和科学计数法；变量下标、题号和单位中的数字不属于答案数值。看不清任何关键数字时返回 unreadable，禁止猜测。`,
      prompt: `请独立读取所附局部图中的最终数值答案。

必须覆盖的小问：${reviewableTargets.map((target) => target.subquestionId).join("、")}
图片标签中的 subquestionId 是唯一映射依据。不要输出参考答案或判分结论。`,
      images: reviewImages,
      schemaName: "local_numeric_answer_review",
      schema: localNumericAnswerReviewJsonSchema,
      validate: (value) => localNumericAnswerReviewSchema.parse(value),
      reasoningEffort: reviewRoute.reasoningEffort ?? "low",
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

async function gradeStudentAnswerDirectLegacy(
  config: ModelConfigInput,
  input: StudentAnswerGradingInput,
  operationId: string,
  preparedStudentAnswer: PreparedStudentAnswer
): Promise<GradingResult> {
  logProgress(operationId, "grading", "paddleocr_started", "大题链路正在调用 PaddleOCR 读取整张学生答卷并提取区域索引", {
    provider: "paddleocr",
    model: config.paddleOcr?.model?.trim() || process.env.PADDLEOCR_MODEL?.trim() || "PaddleOCR-VL-1.6",
    imageBytes: preparedStudentAnswer.preparation.buffer.length,
    imageMimeType: preparedStudentAnswer.preparation.mimeType,
    imagePreprocessed: preparedStudentAnswer.preparation.audit.applied
  });
  let ocr: PaddleOcrAudit;
  try {
    ocr = await runPaddleOcr({
      imageBuffer: preparedStudentAnswer.preparation.buffer,
      mimeType: preparedStudentAnswer.preparation.mimeType,
      fileName: input.fileName,
      settings: config.paddleOcr,
      signal: getOperationSignal(operationId)
    });
  } catch (error) {
    logProgress(operationId, "grading", "paddleocr_failed", "PaddleOCR 读取失败，已停止本次大题批改且不会继续调用教师模型", {
      error: error instanceof Error ? error.message : String(error)
    }, "error");
    throw error;
  }
  logProgress(operationId, "grading", "paddleocr_completed", "PaddleOCR 整页识别完成，已保留原始 JSONL、辅助文本和 bbox 区域索引", {
    provider: ocr.provider,
    model: ocr.model,
    jobId: ocr.jobId,
    rawJsonlBytes: Buffer.byteLength(ocr.rawJsonl, "utf8"),
    markdownCharacters: ocr.markdownText.length,
    imageWidth: ocr.imageWidth,
    imageHeight: ocr.imageHeight,
    layoutBlocks: ocr.layoutBlocks?.length ?? 0,
    durationMs: ocr.durationMs
  });

  const contextImages: GradingImage[] = dedupeGradingImages([
    ...(input.questionImages ?? []),
    ...(input.referenceImages ?? []),
    ...preparedStudentAnswer.modelImages
  ]);
  const questionIds = input.rubric.subquestions.map((item) => item.id);
  const pointKeys = new Set(input.rubric.subquestions.flatMap((subquestion) => subquestion.scorePoints.map((point) => `${subquestion.id}:${point.id}`)));
  const deductionKeys = new Set(input.rubric.subquestions.flatMap((subquestion) => subquestion.deductions.map((deduction) => `${subquestion.id}:${deduction.id}`)));
  const ocrBlockIndex = (ocr.layoutBlocks ?? []).map((block) => ({
    block_id: block.blockId,
    page_index: block.pageIndex,
    label: block.label,
    score: block.score,
    coordinate: block.coordinate,
    polygon_points: block.polygonPoints,
    order: block.order
  }));
  const route = resolveModelRoute(config, "legacy_direct_visual_grading");
  logProgress(operationId, "model", "vision_direct_grade", "正在让教师模型直接查看题目、评分标准和学生答卷图片并完成逐点评分", {
    model: route.model,
    routeKey: route.routeKey,
    gradingMode: "vision_direct",
    reasoningEffort: route.reasoningEffort ?? "disabled",
    questionImages: input.questionImages?.length ?? 0,
    referenceImages: input.referenceImages?.length ?? 0,
    studentImages: preparedStudentAnswer.modelImages.length
  });

  const response = await callStructured<unknown>(route.config, {
    model: route.model,
    routeKey: route.routeKey,
    system: `你是高中物理教师阅卷模型，必须直接查看输入的题目图片、参考答案与评分标准图片和经过本地预处理的学生答卷图，依据本次使用的评分标准版本给出结构化阅卷结果。当前评分标准 JSON 是唯一的评分点和分值来源；题图与参考答案图用于理解题干、图示和评分语义。PaddleOCR 负责全量分块和定位；你必须逐块查看预处理后的答卷图，检验并矫正 OCR 转录后再评分。PaddleOCR 文字只用于辅助定位和防止遗漏，不是最终事实来源；所有关键评分证据必须结合预处理后的答卷图判断。你是最终答案和每个评分点是否得分的唯一判断者，不得把判断交给字符串、公式或数值匹配程序。

${PHYSICS_SIGN_POLICY_GUIDANCE}

${STUDENT_IMAGE_INPUT_GUIDANCE}

严格规则：
  1. 逐页查看所有图片，题目图片、参考答案图片和学生答卷图必须区分。只根据当前评分标准中的评分点和分值评分，不得自行增加得分点或扣分点。必须根据数学关系和物理意义判断等价表达，不得要求学生逐字复现 expected。OCR 识别了被划掉、删除或废弃的内容时，不得把它作为有效得分证据；不要为了符合正确解法而修改或补全学生实际笔迹。
2. 每个小问必须返回且只能返回一条 finalAnswerJudgement。只要你将该小问最终答案判为 correct，本地计分引擎就会无条件将该小问计为满分，不受 finalAnswerPolicy、过程评分点、步骤缺失、无法辨认或扣分规则影响。过程仍必须逐点评审，但只用于审计，不能降低该小问得分。最终答案为 incorrect、missing 或 uncertain 时，才按评分点和扣分规则计分。
  3. 每个评分点必须返回且只能返回一次，放入 pointJudgements 的 satisfied、notSatisfied、notPresent 或 unreadable 之一，并严格按评分点 type 使用下方评分点证据协议。pointKey 使用“subquestionId:pointId”。学生明确写出的移项、约分、不同但等价的变量记号或单位换算可以判为等价，例如 p=p₀+mg/S 与 pS=p₀S+mg 等价；但不能从纯数字算式反推未写出的字母公式。核心公式实际写出且正确时应判 satisfied，即使后续计算错误；计算错误只影响对应代入或结果评分点。单位、方向、符号和重复错误必须按评分标准处理，不能重复扣分。若当前评分点的 description 或 expected 明确拆出多个有独立分值的子条件，才允许部分得分：完整满足放入 satisfied，且 satisfied 对象禁止 awardedScore；未完全满足放入 notSatisfied，且 notSatisfied 对象必须带 awardedScore（0 到该评分点 score）。对于没有明确子分值的评分点，不得自行创造部分分。unreadable 对象也禁止 awardedScore。
   3.1 等式的合法约分、移项和变量重命名必须按代数等价处理，不得因为学生没有保留评分标准中的公共非零因子而判为未作答。例如评分标准中的“μm₂g=m₂a”与学生清楚写出的“a=μg”是同一加速度关系；只要该行未被划掉且预处理后的答卷图可辨认，就应作为对应评分点的有效证据。不要仅因公式出现在联立方程或解题分支中就忽略它，除非学生明确划掉或该行确实无法辨认。
   3.2 同一条未划掉且可辨认的 active 证据行可以被多个评分点引用；只要该物理关系在这些评分点的对象和阶段中都成立，不得因为它已经被前一个评分点引用而排除。对于本题，清楚写出的 a=μg 可同时作为 2-3 的加速度子条件和 3-1 的加速度关系证据；若对象、阶段或方向不同导致关系不成立，仍不得跨阶段套用。
  4. 先完成 transcription：对 PaddleOCR bbox 索引中每个可用 block_id 各返回一条记录，不能只返回与得分有关的几行；header/table 只是分类提示，也必须转录，不能因此忽略其中可能存在的学生作答。根据该 block 在预处理后的学生答卷图中的实际笔迹检验并矫正 OCR；text/latex 只能记录该区域实际可见的字符、数字、公式或图形事实，禁止在转录文字中加入“错误”“正确”“未见评分证据”等判分结论。划掉内容标记 crossed_out，无法辨认标记 uncertain，图形区域用“图形/示意图区域”等简短事实性占位描述，不得凭物理逻辑补全。transcription 记录只写 block_id、text、latex、status、confidence、alternatives；没有公式时 latex 返回空字符串，不要返回坐标；程序会从 OCR 原始坐标绑定定位。
  5. 无法辨认时返回 unreadable，不得猜测；没有出现相关作答时返回 not_present，不得把未作答统一写成 unreadable。不要因为 OCR confidence 低就自动要求复核；如果预处理后的答卷图已经能明确确认，直接评分。只有预处理后的答卷图确实存在视觉歧义且不同解释会导致得分变化时，才设置 review_required=true 并返回 review_items。
6. evidence 是评分审计用的最小卷面证据，不替代 transcription。每条证据必须是预处理后的学生答卷图中确实存在的可定位片段，使用唯一 line id；能提供位置时 region 使用预处理图像素坐标 [x,y,width,height]。evidence.lines[].id 与 transcription.lines[].block_id、review_items[].block_id 属于不同命名空间；evidenceLineIds 只能逐字引用当前 evidence.lines[].id，不能把 PaddleOCR 的 block_id（例如 block-14）直接当作 evidenceLineIds，除非该字符串确实也是 evidence.lines 中的一条 id。不要为了填充字段臆造文字或公式。pointJudgements 中除 notPresent 外只输出 pointKey、evidenceLineIds、简短 reason、confidence；只有明确拆分出独立子分值的 notSatisfied 项才额外输出 awardedScore。不要在 satisfied 或 unreadable 中输出 awardedScore，不要输出 evidenceQuote、requiresReview 或 reviewReason。notSatisfied 只用于预处理后的答卷图中明确看见了该评分点相关但错误的实际表达，必须引用至少一条有效证据行；如果没有看见任何相关表达，必须放入 notPresent，禁止返回 notSatisfied + 空 evidenceLineIds。返回 notPresent 前必须逐条核对 evidence.lines：若 active 证据行已经写出该评分点要求的等价公式，不得同时把该评分点判为 notPresent；复合评分点只满足其中部分明确子条件时按实际子分值返回 notSatisfied + awardedScore。
  7. correct、satisfied、not_satisfied 和 appliedDeductions 必须引用至少一条有效的 active 证据行；incorrect 可以引用 active 或 uncertain 证据行，但只要引用 uncertain，必须同时保留为错误/不确定风险并等待局部视觉复核，不能直接视为最终确定结果；unreadable 应引用对应的 uncertain 证据行；missing 或 not_present 可以不引用。所有引用的 line id 必须出现在 evidence.lines 中。
  8. 不要生成 teacherCommentary，不要输出模型总分。教师评语由本地程序根据已校验结果生成。
  9. review_items 只描述会影响评分的真实视觉歧义：review_id、PaddleOCR 区域索引中的 block_id、受影响评分点 criterion_id、需要确认的 target、你从预处理后的答卷图和 OCR 读到的 recognized、至少两个 candidates、歧义 reason，以及每个候选对应的 score_effect。score_effect 必须是数组，每项使用 {"candidate":"候选原文","score":该候选对应分值}，例如 [{"candidate":"5","score":2},{"candidate":"4","score":0}]；不要使用以候选文字作为动态键的对象。criterion_id 必须使用完整的“subquestionId:pointId”格式，例如本题第（1）问评分点1-3应写为“1:1-3”，不要省略小问ID。不要为不影响得分的文字识别差异创建复核项。header/table 区域保留索引并纳入转录，但不作为默认局部复核目标。教师模型不需要输出像素坐标。
  10. review_required 与 review_items 必须同时准确反映是否存在需要局部复核的评分歧义；不需要复核时返回 false 和空数组。
  11. 只输出符合 JSON Schema 的对象，不输出 Markdown、解释性前缀或隐藏推理过程。reason 只写简短、可审计的判分依据。

 ${COMPACT_SCORE_POINT_EVIDENCE_PROTOCOL}

数学公式可以使用 LaTeX，但必须遵守系统附加的安全公式块协议。`,
    prompt: `请先依据 PaddleOCR bbox 索引逐块核验预处理后的学生答卷整页图，输出完整的教师核验 transcription；再根据 transcription 和预处理后的答卷图完成整份物理答卷批改。transcription 必须覆盖所有可用 block_id，不能因为某个区域与评分点无关或 label 为 header/table 而省略。evidence 仍只保留支持评分判断所需的最小证据片段。

题目文字（可能为空，题图可补足图示；计分仍以当前评分标准 JSON 为准）：
${input.questionText?.trim() || "题目内容见题目图片"}

参考答案和评分标准文字（可能为空，参考答案图仅作上下文核对；计分仍以当前评分标准 JSON 为准）：
${input.referenceText?.trim() || "参考答案与评分标准见参考答案图片"}

本次使用的评分标准 JSON（仅含本次判分所需字段）：
${JSON.stringify(createDirectGradingRubricProjection(input.rubric))}

必须覆盖的小问：${questionIds.join("、")}
必须覆盖的评分点：${[...pointKeys].join("、") || "无"}
  允许使用的扣分规则：${[...deductionKeys].join("、") || "无"}

PaddleOCR 辅助转录（仅用于防止遗漏，不能替代预处理后的答卷图）：
${ocr.markdownText}

PaddleOCR bbox 区域索引（transcription 与 review_items 只需返回 block_id，不需要返回坐标）：
${JSON.stringify({ image_width: ocr.imageWidth, image_height: ocr.imageHeight, blocks: ocrBlockIndex })}

输出前强制自检（只检查，不输出检查过程）：
- finalAnswerJudgements 的 subquestionId 必须恰好覆盖：${questionIds.join("、")}
- pointJudgements 的 satisfied、notSatisfied、notPresent、unreadable 四组数组合并后，pointKey 必须恰好覆盖：${[...pointKeys].join("、") || "无"}；每个评分点只能出现一次，不能漏掉任何一个
- transcription.lines 的 block_id 必须覆盖全部可用区块：${ocrBlockIndex.map((block) => block.block_id).join("、") || "无"}`,
    images: contextImages,
    schemaName: "direct_vision_grading",
    schema: compactDirectVisionGradeJsonSchema,
    validate: (value) => expandCompactDirectVisionGrade(value, input.rubric, questionIds, pointKeys),
    reasoningEffort: route.reasoningEffort,
    operationId
  });
  throwIfOperationCancelled(operationId);
  const parsed = response.data && typeof response.data === "object" && "pointJudgements" in response.data
    ? expandCompactDirectVisionGrade(response.data, input.rubric, questionIds, pointKeys)
    : validateDirectVisionGradeCompleteness(response.data, questionIds, pointKeys, { allowIncomplete: true });
  const evidence: AnswerEvidence = normalizeEvidenceReferences(parsed.evidence);
  const ocrTranscription = normalizeOcrTranscription(parsed.transcription, ocr);
  if (ocrTranscription) {
    logProgress(operationId, "grading", "ocr_transcription_verified", "教师模型已逐块核验 OCR 转录并绑定原始 bbox 定位", {
      blockCount: ocrTranscription.blockCount,
      verifiedBlockCount: ocrTranscription.verifiedBlockCount,
      missingBlockIds: ocrTranscription.missingBlockIds
    }, ocrTranscription.missingBlockIds.length ? "warning" : "success");
  }
  const seenSubquestions = new Set<string>();
  const finalAnswerJudgements: FinalAnswerJudgement[] = parsed.finalAnswerJudgements.flatMap((item) => {
    if (!questionIds.includes(item.subquestionId) || seenSubquestions.has(item.subquestionId)) return [];
    seenSubquestions.add(item.subquestionId);
    return [normalizeFinalAnswerJudgement({ ...item, decisionSource: "teacher_model" as const }).judgement];
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

  // Audits written by releases before bbox metadata was introduced do not
  // contain layoutBlocks. Keep their test/replay shape compatible; every real
  // PaddleOCR run in this release returns layoutBlocks (possibly an empty list)
  // and therefore uses the new block-driven path below.
  if (!Array.isArray(ocr.layoutBlocks)) {
    const legacyLocalReview = await reviewUnreadablePoints(config, input, operationId, preparedStudentAnswer.preparation.buffer, preparedStudentAnswer.studentImage, evidence, decisions, finalAnswerJudgements);
    const legacyNumericReview = await reviewNumericFinalAnswers(config, input, operationId, preparedStudentAnswer.preparation.buffer, evidence, legacyLocalReview.finalAnswerJudgements);
    const legacyResult = calculateGrade({
      id: input.id,
      studentId: input.studentId,
      fileName: input.fileName,
      rubric: input.rubric,
      evidence,
      finalAnswerJudgements: legacyNumericReview.finalAnswerJudgements,
      decisions: legacyLocalReview.decisions,
      appliedDeductions,
      modelName: config.visionModel,
      gradingMode: "vision_direct",
      evidenceValidationMode: "direct_visual",
      durationMs: ocr.durationMs + response.durationMs + legacyLocalReview.durationMs + legacyNumericReview.durationMs,
      unreadableReviewThreshold: config.unreadableReviewThreshold,
      operationId,
      previousResultId: input.previousResultId,
      regradedAt: input.regradedAt,
      regradeReason: input.regradeReason
    });
    legacyResult.gradingPipeline = "large_question";
    legacyResult.ocrAudit = ocr;
    legacyResult.imagePreprocessAudit = preparedStudentAnswer.preparation.audit;
    legacyResult.teacherCommentary = createFallbackTeacherCommentary(legacyResult);
    throwIfOperationCancelled(operationId);
    completeOperation(operationId, "grading", "grading_completed", `${input.studentId}直批完成：${legacyResult.score}/${legacyResult.maxScore}分`, {
      status: legacyResult.status,
      gradingMode: "vision_direct",
      reviewReasons: legacyResult.reviewReasons.length,
      commentaryStatus: legacyResult.teacherCommentary.status
    });
    return legacyResult;
  }

  const initialResult = calculateGrade({
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
    durationMs: ocr.durationMs + response.durationMs,
    unreadableReviewThreshold: config.unreadableReviewThreshold,
    operationId,
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason
  });
  const sourceMetadata = await sharp(preparedStudentAnswer.preparation.buffer).metadata();
    const automaticReviewItems = automaticFinalAnswerReviewItems(
    ocr,
    input.rubric,
    finalAnswerJudgements,
    evidence,
    ocrTranscription,
    sourceMetadata.width ?? 0,
    sourceMetadata.height ?? 0
  );
  if (automaticReviewItems.length) {
    logProgress(operationId, "grading", "direct_visual_review_auto_triggered", "教师最终答案与锁定答案存在高风险读取差异，已自动加入局部视觉复核且不阻断批改", {
      reviewIds: automaticReviewItems.map((item) => item.review_id),
      criteria: automaticReviewItems.map((item) => item.criterion_id)
    }, "warning");
  }
  const plan = normalizeDirectVisualReviewPlan(
    Boolean(parsed.review_required) || automaticReviewItems.length > 0,
    [...(parsed.review_items as DirectVisualReviewPayloadItem[]), ...automaticReviewItems],
    { imageBuffer: preparedStudentAnswer.preparation.buffer, rubric: input.rubric },
    ocr
  );
  const localReview = await runDirectVisualReview(config, { imageBuffer: preparedStudentAnswer.preparation.buffer, mimeType: preparedStudentAnswer.preparation.mimeType, rubric: input.rubric }, operationId, ocr, plan, initialResult, decisions, finalAnswerJudgements);
  const result = calculateGrade({
    id: input.id,
    studentId: input.studentId,
    fileName: input.fileName,
    rubric: input.rubric,
    evidence,
    finalAnswerJudgements: localReview.finalAnswerJudgements,
    decisions: localReview.decisions,
    appliedDeductions,
    modelName: config.visionModel,
    gradingMode: "vision_direct",
    evidenceValidationMode: "direct_visual",
    durationMs: ocr.durationMs + response.durationMs + localReview.durationMs,
    unreadableReviewThreshold: config.unreadableReviewThreshold,
    operationId,
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason,
    pointScoreOverrides: localReview.pointScoreOverrides
  });
  result.gradingPipeline = "large_question";
  result.ocrAudit = ocr;
  if (ocrTranscription) result.ocrTranscription = ocrTranscription;
  result.directVisualReviewAudit = { ...localReview.audit, finalScore: result.score };
  result.imagePreprocessAudit = preparedStudentAnswer.preparation.audit;
  if (localReview.reviewReasons.length) {
    result.reviewReasons = [...new Set([...result.reviewReasons, ...localReview.reviewReasons])];
    result.status = "needs_review";
  }
  result.teacherCommentary = createFallbackTeacherCommentary(result);
  throwIfOperationCancelled(operationId);
  logProgress(operationId, "grading", "teacher_commentary_ready", "已根据校验后的评分结果生成本地结构化评语", {
    status: result.teacherCommentary.status,
    version: result.teacherCommentary.version,
    integratedModelCall: false
  }, "success");
  completeOperation(operationId, "grading", "grading_completed", `${input.studentId}直批完成：${result.score}/${result.maxScore}分`, {
    status: result.status,
    gradingMode: "vision_direct",
    reviewReasons: result.reviewReasons.length,
    ocrJobId: ocr.jobId,
    localReviewItems: localReview.audit.reviewItems.length,
    localReviewResults: localReview.audit.results.length,
    commentaryStatus: result.teacherCommentary.status
  });
  return result;
}

function sanitizeSmallEvidenceLineIds(
  lineIds: string[],
  knownLineIds: ReadonlySet<string>,
  label: string,
  issues: string[]
): string[] {
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const lineId of lineIds) {
    if (seen.has(lineId)) {
      issues.push(`${label}重复引用作答还原行 ${lineId}`);
      continue;
    }
    seen.add(lineId);
    if (!knownLineIds.has(lineId)) {
      issues.push(`${label}引用了不存在的作答还原行 ${lineId}`);
      continue;
    }
    valid.push(lineId);
  }
  return valid;
}

function sanitizeSmallQuestionGrade(
  value: unknown,
  rubric: Rubric,
  reconstruction: StudentAnswerReconstruction
): { finalAnswerJudgements: FinalAnswerJudgement[]; decisions: RubricDecision[]; appliedDeductions: AppliedDeduction[]; teacherCommentary: TeacherCommentaryDraft; issues: string[] } {
  const parsed = smallQuestionGradeSchema.parse(value);
  const issues: string[] = [];
  const knownSubquestionIds = new Set(rubric.subquestions.map((item) => item.id));
  const knownPointIds = new Set(rubric.subquestions.flatMap((item) => item.scorePoints.map((point) => `${item.id}:${point.id}`)));
  const knownDeductionIds = new Set(rubric.subquestions.flatMap((item) => item.deductions.map((rule) => `${item.id}:${rule.id}`)));
  const knownLineIds = new Set(reconstruction.lines.map((line) => line.id));

  const seenFinalAnswers = new Set<string>();
  const finalAnswerJudgements: FinalAnswerJudgement[] = parsed.finalAnswerJudgements.flatMap((item): FinalAnswerJudgement[] => {
    if (!knownSubquestionIds.has(item.subquestionId)) {
      issues.push(`评分模型返回了未知小问 ${item.subquestionId}`);
      return [];
    }
    if (seenFinalAnswers.has(item.subquestionId)) {
      issues.push(`评分模型重复返回小问 ${item.subquestionId} 的最终答案判定`);
      return [];
    }
    seenFinalAnswers.add(item.subquestionId);
    const normalized = normalizeFinalAnswerJudgement({
      ...item,
      evidenceLineIds: sanitizeSmallEvidenceLineIds(item.evidenceLineIds, knownLineIds, `${item.subquestionId}最终答案`, issues),
      decisionSource: "teacher_model" as const
    });
    if (normalized.changed) issues.push(`${item.subquestionId}最终答案已按有效作答证据归一化：${normalized.reasons.join("、")}`);
    return [normalized.judgement];
  });
  for (const subquestionId of knownSubquestionIds) {
    if (!seenFinalAnswers.has(subquestionId)) issues.push(`评分模型遗漏小问 ${subquestionId} 的最终答案判定`);
  }

  const seenPoints = new Set<string>();
  const decisions: RubricDecision[] = parsed.decisions.flatMap((item): RubricDecision[] => {
    const key = `${item.subquestionId}:${item.pointId}`;
    if (!knownPointIds.has(key)) {
      issues.push(`评分模型返回了未知评分点 ${key}`);
      return [];
    }
    if (seenPoints.has(key)) {
      issues.push(`评分模型重复返回评分点 ${key}`);
      return [];
    }
    seenPoints.add(key);
    const evidenceLineIds = sanitizeSmallEvidenceLineIds(item.evidenceLineIds, knownLineIds, `${key}评分证据`, issues);
    if (item.requiresReview && item.status !== "unreadable" && item.status !== "insufficient_evidence") {
      issues.push(`${key}同时返回明确状态和人工复核标记`);
      return [{
        ...item,
        status: "unreadable" as const,
        evidenceLineIds,
        requiresReview: true,
        reviewReason: item.reviewReason || "评分模型的状态与复核标记矛盾",
        decisionSource: "normalized_uncertain" as const
      }];
    }
    return [{ ...item, evidenceLineIds, decisionSource: "model" as const }];
  });
  for (const pointKey of knownPointIds) {
    if (!seenPoints.has(pointKey)) issues.push(`评分模型遗漏评分点 ${pointKey}`);
  }

  const seenDeductions = new Set<string>();
  const appliedDeductions: AppliedDeduction[] = parsed.appliedDeductions.flatMap((item): AppliedDeduction[] => {
    const key = `${item.subquestionId}:${item.ruleId}`;
    if (!knownDeductionIds.has(key)) {
      issues.push(`评分模型返回了未知扣分规则 ${key}`);
      return [];
    }
    if (seenDeductions.has(key)) {
      issues.push(`评分模型重复返回扣分规则 ${key}`);
      return [];
    }
    seenDeductions.add(key);
    return [{
      ...item,
      evidenceLineIds: sanitizeSmallEvidenceLineIds(item.evidenceLineIds, knownLineIds, `${key}扣分证据`, issues)
    }];
  });

  return { finalAnswerJudgements, decisions, appliedDeductions, teacherCommentary: parsed.teacherCommentary, issues };
}

type SmallEvidenceLineAudit = {
  locatable: boolean;
  issues: string[];
};

/**
 * The small-question scoring model is intentionally isolated from the student
 * image.  This audit is therefore the last place where the extracted line
 * coordinates can be checked against the OCR image and its layout blocks
 * before the score is accepted as reliable.
 */
function auditSmallQuestionEvidence(
  ocr: PaddleOcrAudit,
  reconstruction: StudentAnswerReconstruction,
  finalAnswerJudgements: FinalAnswerJudgement[],
  result: GradingResult
): string[] {
  const reasons: string[] = [];
  const linesById = new Map(reconstruction.lines.map((line) => [line.id, line]));
  const lineAudits = new Map<string, SmallEvidenceLineAudit>();
  const lineSources = new Map<string, Set<string>>();
  const keyLineIds = new Set<string>();

  const imageWidth = ocr.imageWidth;
  const imageHeight = ocr.imageHeight;
  const boundedImageWidth = typeof imageWidth === "number" && Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : 0;
  const boundedImageHeight = typeof imageHeight === "number" && Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : 0;
  const hasImageBounds = boundedImageWidth > 0 && boundedImageHeight > 0;
  const blocks = (ocr.layoutBlocks ?? []).flatMap((block) => {
    if (!Array.isArray(block.coordinate) || block.coordinate.length !== 4) return [];
    const [rawX1, rawY1, rawX2, rawY2] = block.coordinate;
    if (![rawX1, rawY1, rawX2, rawY2].every((value) => Number.isFinite(value))) return [];
    const left = Math.min(rawX1, rawX2);
    const top = Math.min(rawY1, rawY2);
    const right = Math.max(rawX1, rawX2);
    const bottom = Math.max(rawY1, rawY2);
    return right > left && bottom > top
      ? [{ blockId: block.blockId, left, top, right, bottom }]
      : [];
  });

  const inspectLine = (lineId: string): SmallEvidenceLineAudit => {
    const cached = lineAudits.get(lineId);
    if (cached) return cached;
    const line = linesById.get(lineId);
    const issues: string[] = [];
    let locatable = false;
    if (!line) {
      issues.push("作答还原行不存在");
    } else {
      const region = line.region;
      const finiteRegion = Array.isArray(region)
        && region.length === 4
        && region.every((value) => Number.isFinite(value));
      if (!finiteRegion) {
        issues.push("缺少有限的区域坐标");
      } else {
        const [x, y, width, height] = region;
        if (width <= 0 || height <= 0) {
          issues.push("区域宽高必须为正数");
        } else if (!hasImageBounds) {
          issues.push("PaddleOCR未返回有效的图像尺寸，无法校验区域范围");
        } else if (x < 0 || y < 0 || x + width > boundedImageWidth || y + height > boundedImageHeight) {
          issues.push("区域超出PaddleOCR图像范围");
        } else if (!blocks.length) {
          issues.push("PaddleOCR未返回可绑定的layout block");
        } else {
          const regionArea = width * height;
          const BOUNDING_BOX_PADDING = 8;
          const expandedLeft = Math.max(0, x - BOUNDING_BOX_PADDING);
          const expandedTop = Math.max(0, y - BOUNDING_BOX_PADDING);
          const expandedRight = Math.min(boundedImageWidth, x + width + BOUNDING_BOX_PADDING);
          const expandedBottom = Math.min(boundedImageHeight, y + height + BOUNDING_BOX_PADDING);
          const bound = blocks.some((block) => {
            const intersectionWidth = Math.max(0, Math.min(expandedRight, block.right) - Math.max(expandedLeft, block.left));
            const intersectionHeight = Math.max(0, Math.min(expandedBottom, block.bottom) - Math.max(expandedTop, block.top));
            const intersectionArea = intersectionWidth * intersectionHeight;
            const blockArea = (block.right - block.left) * (block.bottom - block.top);
            // A one-pixel touch is not a meaningful binding.  Requiring the
            // overlap to cover at least 10% of the smaller rectangle accepts
            // both OCR blocks around a line and lines spanning a larger block.
            return intersectionArea / Math.max(1, Math.min(regionArea, blockArea)) >= 0.1;
          });
          if (!bound) {
            issues.push("区域无法与任何PaddleOCR layout block合理相交");
          } else {
            locatable = true;
          }
        }
      }
      if (line.status === "crossed_out") issues.push("证据行已被划掉");
      if (line.status === "uncertain") issues.push("证据行状态为uncertain");
      if (!Number.isFinite(line.confidence) || line.confidence < REVIEW_CONFIDENCE_THRESHOLD) {
        issues.push(`证据行置信度低于复核阈值${REVIEW_CONFIDENCE_THRESHOLD}`);
      }
    }
    const audit = { locatable, issues };
    lineAudits.set(lineId, audit);
    return audit;
  };

  const addReferences = (source: string, lineIds: string[]) => {
    for (const lineId of [...new Set(lineIds)]) {
      keyLineIds.add(lineId);
      const sources = lineSources.get(lineId) ?? new Set<string>();
      sources.add(source);
      lineSources.set(lineId, sources);
      inspectLine(lineId);
    }
  };

  for (const judgement of finalAnswerJudgements) {
    addReferences(`${judgement.subquestionId}最终答案`, judgement.evidenceLineIds);
  }
  for (const subquestion of result.subquestions) {
    for (const decision of subquestion.decisions) {
      addReferences(`${subquestion.id}:${decision.pointId}评分点`, decision.evidenceLineIds);
    }
    for (const deduction of subquestion.deductions) {
      addReferences(`${subquestion.id}:${deduction.ruleId}扣分`, deduction.evidenceLineIds);
    }
  }

  for (const lineId of keyLineIds) {
    const audit = inspectLine(lineId);
    if (!audit.issues.length) continue;
    const sources = [...(lineSources.get(lineId) ?? [])].join("、");
    reasons.push(`关键证据行 ${lineId}（${sources}）${audit.issues.join("；")}，需要人工复核。`);
  }

  const hasLocatableEvidence = (lineIds: string[]): boolean => [...new Set(lineIds)].some((lineId) => inspectLine(lineId).locatable);
  for (const judgement of finalAnswerJudgements) {
    if (judgement.status !== "missing" && !hasLocatableEvidence(judgement.evidenceLineIds)) {
      reasons.push(`${judgement.subquestionId}最终答案判定没有任何可定位学生证据，需要人工复核。`);
    }
  }
  for (const subquestion of result.subquestions) {
    for (const decision of subquestion.decisions) {
      const requiresEvidence = decision.status !== "not_present";
      const hasScore = Number.isFinite(decision.awardedScore) && decision.awardedScore > 0;
      if ((requiresEvidence || hasScore) && !hasLocatableEvidence(decision.evidenceLineIds)) {
        reasons.push(`${subquestion.id}:${decision.pointId}评分点${hasScore ? `已计入${decision.awardedScore}分但` : "判定为非未作答但"}没有任何可定位学生证据，需要人工复核。`);
      }
    }
    for (const deduction of subquestion.deductions) {
      if (deduction.deductedScore > 0 && !hasLocatableEvidence(deduction.evidenceLineIds)) {
        reasons.push(`${subquestion.id}:${deduction.ruleId}扣分已生效但没有任何可定位学生证据，需要人工复核。`);
      }
    }
  }

  return [...new Set(reasons)];
}

function addSmallQuestionReviewReasons(
  result: GradingResult,
  reconstruction: StudentAnswerReconstruction,
  contractIssues: string[],
  evidence: AnswerEvidence
): void {
  const reasons = [...contractIssues];
  const reconstructionReviewReasons = reconstruction.reviewReasons.filter((reason) => reason.trim());
  if (reconstruction.status === "review") {
    reasons.push(...reconstructionReviewReasons);
    if (!reconstructionReviewReasons.length) reasons.push("作答还原标记为需要复核，但没有提供具体原因。");
  } else if (reconstructionReviewReasons.length) {
    reasons.push("作答还原返回了复核原因但状态不是 review，需要人工复核。");
  }
  if (reconstruction.lines.some((line) => line.status === "uncertain")) {
    reasons.push("作答还原中存在无法确认的字、数字、公式、单位、方向或上下标，需要人工复核。");
  }
  for (const ambiguity of reconstruction.ambiguities) {
    if (ambiguity.scoreImpact !== "none") {
      reasons.push(`作答还原存在${ambiguity.scoreImpact === "certain" ? "确定影响" : "可能影响"}得分的歧义：${ambiguity.reason}`);
    }
  }
  for (const ambiguity of evidence.ambiguities) {
    if (ambiguity.scoreImpact !== "none") {
      reasons.push(`作答证据存在${ambiguity.scoreImpact === "certain" ? "确定影响" : "可能影响"}得分的歧义：${ambiguity.reason}`);
    }
  }
  for (const subquestion of result.subquestions) {
    if (subquestion.finalAnswerStatus === "uncertain") reasons.push(`${subquestion.title}最终答案无法可靠确认，需要人工复核。`);
    if (subquestion.decisions.some((decision) => decision.status === "unreadable" || decision.status === "insufficient_evidence")) {
      reasons.push(`${subquestion.title}存在无法辨认的评分点，需要人工复核。`);
    }
  }
  if (reasons.length) {
    result.reviewReasons = [...new Set([...result.reviewReasons, ...reasons])];
    result.status = "needs_review";
  }
}

interface ArbitrateSmallQuestionDisputesInput {
  config: ModelConfigInput;
  input: StudentAnswerGradingInput;
  operationId: string;
  preparedStudentAnswer: PreparedStudentAnswer;
  disputedJudgements: FinalAnswerJudgement[];
}

async function arbitrateSmallQuestionDisputes(args: ArbitrateSmallQuestionDisputesInput): Promise<{
  arbitrations: Array<{
    subquestionId: string;
    confirmedStatus: "correct" | "incorrect" | "uncertain";
    studentHandwrittenEvidence: string;
    overridesInitialJudgement: boolean;
    reason: string;
    confidence: number;
  }>;
  durationMs: number;
}> {
  const { config, input, operationId, preparedStudentAnswer, disputedJudgements } = args;
  const reviewRoute = resolveModelRoute(config, "small_question_grading_vision");
  const model = reviewRoute.model;

  const subquestionsById = new Map(input.rubric.subquestions.map((sub) => [sub.id, sub]));
  const disputesPromptText = disputedJudgements.map((judgement, idx) => {
    const sub = subquestionsById.get(judgement.subquestionId);
    const title = sub?.title ?? judgement.subquestionId;
    const refAnswers = sub?.finalAnswers.map((a) => a.expression).join(" / ") ?? judgement.referenceAnswer;
    return `【争议小问 ${idx + 1}】${title}（ID: ${judgement.subquestionId}）
- 初评判定状态：${judgement.status}
- 初评转录的学生作答：${judgement.studentAnswer || "（未识别到有效作答）"}
- 评分标准参考答案：${refAnswers}
- 初评判定为错误/存疑的原因：${judgement.reason}
`;
  }).join("\n");

  logProgress(operationId, "model", "small_question_dispute_arbitration_started", `正在对 ${disputedJudgements.length} 个初评未给满分的小问进行卷面原图死刑复核`, {
    model,
    disputedCount: disputedJudgements.length,
    subquestions: disputedJudgements.map((j) => j.subquestionId)
  });

  const response = await callStructured<unknown>(reviewRoute.config, {
    model,
    routeKey: reviewRoute.routeKey,
    system: `你是高中物理小题错题死刑复核与争议仲裁专家。初评流程初步将部分小问判定为错误（incorrect）或存疑（uncertain）。
你的唯一任务是独立查看预处理后的学生答卷原图，逐一核对初评是否存在“因文字转录漏看负号、小数点、上下标、根号或物理等价表达而导致的误判”。

规则：
1. 如果原图中学生确实清晰写出了与参考答案等价的内容（例如初评漏看了负号或负数、漏看了小数点、因字母上下标识别不准而误判），应果断纠正判定：overridesInitialJudgement 设为 true，confirmedStatus 设为 correct，并在 studentHandwrittenEvidence 中写出原图中实际看出的完整内容。
2. 如果原图中学生确实写错了（如数值错误、公式错误、确实缺少关键符号）或字迹涂抹确实无法辨认，overridesInitialJudgement 设为 false，confirmedStatus 设为 incorrect 或 uncertain。
3. 严禁无中生有、严禁替学生补写卷面上没有的步骤。所有判断必须以本次输入的学生答卷原图中的真实字迹为准。只输出严格符合 JSON Schema 的对象。`,
    prompt: `请对以下初评存疑或被判错的小问进行卷面原图死刑复核：

${disputesPromptText}

题目文字：
${input.questionText?.trim() || "题目文字见题目图片"}

参考答案及依据：
${input.referenceText?.trim() || "见参考答案图片"}

请仔细查看学生答卷原图，判定原图是否支持推翻初评判定并纠正为正确。`,
    images: preparedStudentAnswer.modelImages,
    schemaName: "small_question_dispute_arbitration",
    schema: smallQuestionDisputeArbitrationJsonSchema,
    validate: (value) => smallQuestionDisputeArbitrationSchema.parse(value),
    reasoningEffort: reviewRoute.reasoningEffort,
    operationId
  });

  const parsed = smallQuestionDisputeArbitrationSchema.parse(response.data);
  return {
    arbitrations: parsed.arbitrations,
    durationMs: response.durationMs
  };
}

async function gradeSmallQuestion(
  config: ModelConfigInput,
  input: StudentAnswerGradingInput,
  operationId: string,
  preparedStudentAnswer: PreparedStudentAnswer
): Promise<GradingResult> {
  logProgress(operationId, "grading", "paddleocr_started", "小题链路正在调用 PaddleOCR 读取学生答卷", {
    provider: "paddleocr",
    model: config.paddleOcr?.model?.trim() || process.env.PADDLEOCR_MODEL?.trim() || "PaddleOCR-VL-1.6",
    imageBytes: preparedStudentAnswer.preparation.buffer.length,
    imageMimeType: preparedStudentAnswer.preparation.mimeType,
    imagePreprocessed: preparedStudentAnswer.preparation.audit.applied
  });
  let ocr: PaddleOcrAudit;
  try {
    ocr = await runPaddleOcr({
      imageBuffer: preparedStudentAnswer.preparation.buffer,
      mimeType: preparedStudentAnswer.preparation.mimeType,
      fileName: input.fileName,
      settings: config.paddleOcr,
      signal: getOperationSignal(operationId)
    });
  } catch (error) {
    logProgress(operationId, "grading", "paddleocr_failed", "PaddleOCR 读取失败，已停止小题批改且不会继续调用模型", {
      error: error instanceof Error ? error.message : String(error)
    }, "error");
    throw error;
  }
  logProgress(operationId, "grading", "paddleocr_completed", "PaddleOCR 读取完成，原始 JSONL 已保留在本次结果审计中", {
    provider: ocr.provider,
    model: ocr.model,
    jobId: ocr.jobId,
    rawJsonlBytes: Buffer.byteLength(ocr.rawJsonl, "utf8"),
    markdownCharacters: ocr.markdownText.length,
    durationMs: ocr.durationMs
  });

  const reconstructionRoute = resolveModelRoute(config, "small_question_reconstruction");
  const reconstructionResponse = await callStructured<unknown>(reconstructionRoute.config, {
    model: reconstructionRoute.model,
    routeKey: reconstructionRoute.routeKey,
    system: getBuiltInSystemPrompt(reconstructionRoute.routeKey),
    prompt: `请只根据预处理后的学生答卷图和下面的 PaddleOCR Markdown 还原学生实际写出的作答。不要建立题目、小问或评分点映射，不要解题或评分。

PaddleOCR Markdown：
${ocr.markdownText}`,
    images: preparedStudentAnswer.modelImages,
    schemaName: "student_answer_reconstruction",
    schema: studentAnswerReconstructionJsonSchema,
    validate: (value) => studentAnswerReconstructionSchema.parse(value),
    reasoningEffort: reconstructionRoute.reasoningEffort,
    operationId
  });
  throwIfOperationCancelled(operationId);
  const reconstruction: StudentAnswerReconstruction = studentAnswerReconstructionSchema.parse(reconstructionResponse.data);
  const evidence: AnswerEvidence = normalizeEvidenceReferences({
    lines: reconstruction.lines,
    finalAnswers: [],
    ambiguities: reconstruction.ambiguities
  });
  logProgress(operationId, "grading", "student_answer_reconstructed", "GPT 作答还原完成，正在进入与题目和评分标准隔离的评分阶段", {
    lines: evidence.lines.length,
    ambiguities: evidence.ambiguities.length,
    status: reconstruction.status,
    reviewReasons: reconstruction.reviewReasons.length,
    durationMs: reconstructionResponse.durationMs
  });

  const scoringImages = [...(input.questionImages ?? []), ...(input.referenceImages ?? [])];
  const scoringRoute = resolveModelRoute(config, scoringImages.length ? "small_question_grading_vision" : "small_question_grading_text");
  const scoringModel = scoringRoute.model;
  const questionIds = input.rubric.subquestions.map((item) => item.id);
  const pointKeys = input.rubric.subquestions.flatMap((subquestion) => subquestion.scorePoints.map((point) => `${subquestion.id}:${point.id}`));
  logProgress(operationId, "model", "small_question_grade", "正在根据题目、参考答案、作答还原和小题评分标准评分", {
    model: scoringModel,
    routeKey: scoringRoute.routeKey,
    questionType: "small",
    questionImages: input.questionImages?.length ?? 0,
    referenceImages: input.referenceImages?.length ?? 0,
    studentImages: 0,
    subquestions: questionIds,
    scorePoints: pointKeys
  });
  const scoringResponse = await callStructured<unknown>(scoringRoute.config, {
    model: scoringModel,
    routeKey: scoringRoute.routeKey,
    system: getBuiltInSystemPrompt(scoringRoute.routeKey),
    prompt: `请完成小题评分。所有学生作答只能来自“作答还原 JSON”，本次请求没有学生原图；不要补写还原结果中不存在的内容。

题目文字：
${input.questionText?.trim() || "题目文字见题目图片"}

参考答案与评分依据文字：
${input.referenceText?.trim() || "参考答案与评分依据见参考答案图片"}

当前锁定的小题评分标准 JSON：
${JSON.stringify(input.rubric)}

作答还原 JSON：
${JSON.stringify(reconstruction)}

必须覆盖的小问：${questionIds.join("、")}
必须覆盖的评分点：${pointKeys.join("、") || "无"}`,
    images: scoringImages,
    schemaName: "small_question_grading",
    schema: smallQuestionGradeJsonSchema,
    validate: (value) => smallQuestionGradeSchema.parse(value),
    reasoningEffort: scoringRoute.reasoningEffort,
    operationId
  });
  throwIfOperationCancelled(operationId);
  const sanitized = sanitizeSmallQuestionGrade(scoringResponse.data, input.rubric, reconstruction);

  for (const judgement of sanitized.finalAnswerJudgements) {
    if (judgement.status !== "correct") {
      const targetSubquestion = input.rubric.subquestions.find((sub) => sub.id === judgement.subquestionId);
      if (targetSubquestion && targetSubquestion.finalAnswers && targetSubquestion.finalAnswers.length > 0) {
        const comparison = comparePhysicsAnswer(judgement.studentAnswer, targetSubquestion.finalAnswers);
        if (comparison.status === "equivalent") {
          judgement.status = "correct";
          judgement.reason = `经确定性物理等价规则判定与参考答案等价：${comparison.reason}`;
          judgement.confidence = Math.max(judgement.confidence, 0.95);
          judgement.decisionSource = "local_numeric_review";
          logProgress(operationId, "grading", "small_question_deterministic_equivalence_override", `${targetSubquestion.title}经确定性物理等价规则判定为正确`, {
            subquestionId: judgement.subquestionId,
            studentAnswer: judgement.studentAnswer,
            matchedAnswerIndex: comparison.matchedAnswerIndex
          });
        }
      }
    }
  }

  let arbitrationDurationMs = 0;
  const disputedJudgements = sanitized.finalAnswerJudgements.filter(
    (j) => j.status === "incorrect" || j.status === "uncertain"
  );
  if (disputedJudgements.length > 0) {
    try {
      const arbitrationResult = await arbitrateSmallQuestionDisputes({
        config,
        input,
        operationId,
        preparedStudentAnswer,
        disputedJudgements
      });
      arbitrationDurationMs = arbitrationResult.durationMs;
      for (const arb of arbitrationResult.arbitrations) {
        const targetJudgement = sanitized.finalAnswerJudgements.find((j) => j.subquestionId === arb.subquestionId);
        if (!targetJudgement) continue;
        const targetSub = input.rubric.subquestions.find((s) => s.id === arb.subquestionId);
        if (arb.overridesInitialJudgement && arb.confirmedStatus === "correct") {
          targetJudgement.status = "correct";
          if (arb.studentHandwrittenEvidence?.trim()) {
            targetJudgement.studentAnswer = arb.studentHandwrittenEvidence.trim();
          }
          targetJudgement.reason = `经死刑复核反查原图纠正为正确：${arb.reason}`;
          targetJudgement.confidence = arb.confidence;
          targetJudgement.decisionSource = "visual_local_review";
          logProgress(operationId, "grading", "small_question_dispute_overridden", `${targetSub?.title ?? arb.subquestionId}经原图反查纠正为正确：${arb.reason}`, {
            subquestionId: arb.subquestionId,
            studentEvidence: arb.studentHandwrittenEvidence,
            confidence: arb.confidence
          }, "success");
        } else {
          logProgress(operationId, "grading", "small_question_dispute_confirmed", `${targetSub?.title ?? arb.subquestionId}经原图反查确认维持初评：${arb.reason}`, {
            subquestionId: arb.subquestionId,
            confirmedStatus: arb.confirmedStatus,
            confidence: arb.confidence
          }, "info");
        }
      }
    } catch (arbitrationError) {
      logProgress(operationId, "grading", "small_question_dispute_arbitration_failed", "错疑小问原图反查仲裁调用失败，维持初评判定并进入人工复核", {
        error: arbitrationError instanceof Error ? arbitrationError.message : String(arbitrationError)
      }, "warning");
      sanitized.issues.push("错疑小问原图反查仲裁调用失败，维持初评判定，需要人工复核。");
    }
  }

  const result = calculateGrade({
    id: input.id,
    studentId: input.studentId,
    fileName: input.fileName,
    rubric: input.rubric,
    evidence,
    finalAnswerJudgements: sanitized.finalAnswerJudgements,
    decisions: sanitized.decisions,
    appliedDeductions: sanitized.appliedDeductions,
    modelName: scoringModel,
    evidenceValidationMode: "extracted_text",
    durationMs: ocr.durationMs + reconstructionResponse.durationMs + scoringResponse.durationMs + arbitrationDurationMs,
    unreadableReviewThreshold: config.unreadableReviewThreshold,
    operationId,
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason
  });
  result.gradingPipeline = "small_question_ocr";
  result.ocrAudit = ocr;
  result.imagePreprocessAudit = preparedStudentAnswer.preparation.audit;
  const evidenceAuditReasons = auditSmallQuestionEvidence(
    ocr,
    reconstruction,
    sanitized.finalAnswerJudgements,
    result
  );
  addSmallQuestionReviewReasons(result, reconstruction, [...sanitized.issues, ...evidenceAuditReasons], evidence);
  result.teacherCommentary = finalizeTeacherCommentary(sanitized.teacherCommentary, result, scoringModel);
  throwIfOperationCancelled(operationId);
  logProgress(operationId, "grading", "small_question_result_ready", "小题 OCR 独立批改完成，后端已重算总分并完成复核判定", {
    model: scoringModel,
    status: result.status,
    score: result.score,
    maxScore: result.maxScore,
    reviewReasons: result.reviewReasons.length,
    ocrJobId: ocr.jobId,
    rawJsonlBytes: Buffer.byteLength(ocr.rawJsonl, "utf8")
  }, result.status === "needs_review" ? "warning" : "success");
  completeOperation(operationId, "grading", "grading_completed", `${input.studentId}小题批改完成：${result.score}/${result.maxScore}分`, {
    status: result.status,
    gradingPipeline: result.gradingPipeline,
    reviewReasons: result.reviewReasons.length,
    ocrJobId: ocr.jobId
  });
  return result;
}

export async function gradeStudentAnswer(config: ModelConfigInput, input: StudentAnswerGradingInput): Promise<{
  result: GradingResult;
  operationId: string;
  artifactSource: GradingArtifactSource;
}> {
  const gradingMode: GradingMode = config.gradingMode ?? DEFAULT_GRADING_MODE;
  const questionType = input.rubric.questionType ?? DEFAULT_QUESTION_TYPE;
  const useResponsesAgent = questionType === "large" && config.largeQuestionWorkflow === "responses_agent";
  const initialStep = questionType === "small"
    ? "paddleocr"
    : useResponsesAgent
      ? "large_question_responses_agent"
      : gradingMode === "vision_direct" ? "large_question_staged" : "extract_answer";
  const operationId = beginOperation("grading", `开始批改 ${input.studentId}`, initialStep, {
    studentId: input.studentId,
    fileName: input.fileName,
    rubricVersion: input.rubric.version,
    gradingMode,
    largeQuestionWorkflow: config.largeQuestionWorkflow ?? "staged",
    questionType
  });
  try {
    assertRubricIntegrity(input.rubric);
    if (useResponsesAgent) {
      const grading = await gradeLargeQuestionResponsesAgent(config, input, operationId);
      completeOperation(operationId, "grading", "grading_completed", `${input.studentId} Responses Agent 大题批改完成：${grading.result.score}/${grading.result.maxScore}分`, {
        status: grading.result.status,
        gradingPipeline: grading.result.gradingPipeline,
        reviewReasons: grading.result.reviewReasons.length,
        scoreResolved: grading.result.scoreResolved
      });
      return { result: grading.result, operationId, artifactSource: grading.artifactSource };
    }
    const preparedStudentAnswer = await prepareStudentAnswerForModels(input, operationId);
    const artifactSource = createGradingArtifactSource(input, preparedStudentAnswer);
    throwIfOperationCancelled(operationId);
    if (questionType === "small") {
      const result = await gradeSmallQuestion(config, input, operationId, preparedStudentAnswer);
      return { result, operationId, artifactSource };
    }
    if (gradingMode === "vision_direct") {
      const result = await gradeLargeQuestionStaged(config, input, operationId, preparedStudentAnswer, artifactSource);
      return { result, operationId, artifactSource };
    }
    const extractionRoute = resolveModelRoute(config, "legacy_evidence_extraction");
    logProgress(operationId, "model", "extract_answer", "正在调用多模态模型提取卷面证据", {
      model: extractionRoute.model,
      routeKey: extractionRoute.routeKey
    });
    const extraction = await callStructured<unknown>(extractionRoute.config, {
    model: extractionRoute.model,
    routeKey: extractionRoute.routeKey,
    system: `${STUDENT_IMAGE_INPUT_GUIDANCE}\n\n你只负责忠实转录学生卷面，不得评分，不得根据正确解法补全、纠正或美化学生内容。模糊内容必须给出候选并降低置信度。划去内容必须标记。`,
    prompt: `提取这份学生作答的所有有效行、公式、卷面位置、涂改状态和最终答案候选。评分标准中的小问ID如下：${input.rubric.subquestions.map((item) => item.id).join(", ")}。坐标使用预处理答卷图像素坐标。表达式尽量使用可解析的普通代数形式，保留原始LaTeX。`,
    images: preparedStudentAnswer.modelImages,
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

    const finalAnswerRoute = resolveModelRoute(config, "legacy_final_answer");
    logProgress(operationId, "model", "verify_final_answers", "正在调用教师模型独立判定各小问最终答案", {
      model: finalAnswerRoute.model,
      routeKey: finalAnswerRoute.routeKey,
      reasoningEffort: finalAnswerRoute.reasoningEffort ?? "disabled",
      subquestions: input.rubric.subquestions.map((item) => item.id)
    });
    const finalAnswerResponse = await callStructured<unknown>(finalAnswerRoute.config, {
      model: finalAnswerRoute.model,
      routeKey: finalAnswerRoute.routeKey,
      system: `你是高中物理教师判分模型，只负责判断每个小问的最终答案是否正确。你的最终答案判断是本次评分的权威结论。

${STUDENT_IMAGE_INPUT_GUIDANCE}

根据物理意义比较学生实际写出的最终答案与本次使用的评分标准。接受代数等价、根式等价、分数等价、合理的测量与舍入误差、单位换算、变量大小写或命名差异、多个结果顺序变化，以及学生明确说明的方向变化。不得使用或模拟字符串、公式模板、固定数值容差白名单等机械匹配。最终答案包括大小、方向、单位和题目要求的全部结果。

不得因为中间过程缺失而否定已经清晰写出的正确最终答案。不得根据你自己求解题目得到的结果修改学生答案或参考答案。没有清晰、未划掉的最终答案时返回missing，evidenceLineIds应为空；只有在卷面上确实存在疑似最终答案、但字迹或含义无法可靠确认时才返回uncertain，并引用相关卷面行。已经划掉的数值、公式或结论不能作为最终答案。confidence表示你对当前状态判断的可靠程度，不表示结论方向。correct或incorrect必须引用至少一条实际、未划掉且可识别的卷面行。每个小问必须恰好返回一条finalAnswerJudgement。`,
      prompt: `请对本次使用的评分标准中的每个小问独立判定最终答案。你必须同时核对预处理后的学生答卷图与卷面转录；转录只是辅助证据，整页预处理图可以纠正转录遗漏，但不得补写学生没有写出的内容。

锁定题目与评分标准：
${JSON.stringify(input.rubric)}

卷面转录与最终答案候选：
${JSON.stringify(evidence)}`,
      images: preparedStudentAnswer.modelImages,
      schemaName: "final_answer_judgements",
      schema: finalAnswerJudgementsJsonSchema,
      validate: (value) => finalAnswerJudgementsSchema.parse(value),
      reasoningEffort: finalAnswerRoute.reasoningEffort,
      operationId
    });
    throwIfOperationCancelled(operationId);
    const parsedFinalAnswers = finalAnswerJudgementsSchema.parse(finalAnswerResponse.data);
    const knownSubquestions = new Set(input.rubric.subquestions.map((item) => item.id));
    const seenSubquestions = new Set<string>();
    const finalAnswerJudgements: FinalAnswerJudgement[] = parsedFinalAnswers.finalAnswerJudgements.flatMap((item) => {
      if (!knownSubquestions.has(item.subquestionId) || seenSubquestions.has(item.subquestionId)) return [];
      seenSubquestions.add(item.subquestionId);
      const normalized = normalizeFinalAnswerJudgement({ ...item, decisionSource: "teacher_model" as const });
      return [normalized.judgement];
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
    const processRoute = resolveModelRoute(config, "legacy_process_review");
    logProgress(operationId, "model", "judge_rubric_points", "正在对所有小问的每个评分点执行过程审验", {
      model: processRoute.model,
      routeKey: processRoute.routeKey,
      reasoningEffort: processRoute.reasoningEffort ?? "disabled",
      subquestions: processSubquestionIds,
      finalAnswerCorrectStillAudited: true
    });
    try {
      const processResponse = await callStructured<unknown>(processRoute.config, {
        model: processRoute.model,
        routeKey: processRoute.routeKey,
        system: `你是高中物理评分点判分模型。严格依据给定评分标准和卷面证据判断每一个评分点，不得补写学生没有写出的内容或创造评分点。最终答案状态由上一步教师模型确定，你不得修改它。即使最终答案状态为correct，也必须逐点评审并返回审验结论。你的 satisfied、not_satisfied、not_present、unreadable 决定将直接用于计分，本地程序只按锁定分值加总。

${STUDENT_IMAGE_INPUT_GUIDANCE}

每个评分点只能使用以下状态：
- satisfied：存在清晰、未划掉、可识别的有效卷面证据，且明确满足评分点；requiresReview=false。
- not_satisfied：存在清晰有效证据，但内容明确错误或不满足评分点；requiresReview=false。
- not_present：有效卷面中没有出现评分点要求的公式、关系、物理量或结论，或者只出现了已经划掉的内容；requiresReview=false。没有写出相关内容不能返回unreadable。
- unreadable：确实存在与评分点相关的作答痕迹，但字迹、涂改或公式结构无法可靠辨认；requiresReview=true并说明需核对的区域。该字段只表示复核候选，最终是否进入人工复核由本地汇总程序按整卷影响分值和教师设置的阈值决定。

只有satisfied可以获得该评分点分数。not_satisfied、not_present和unreadable当前都不得给分。你必须自行判断学生实际写出表达的数学和物理等价关系，不得使用逐字匹配思路，也不得把 expected 当作只能逐字复现的模板。明确写出的移项、约分或变量替换可以正常得分，例如 p=p₀+mg/S 与 pS=p₀S+mg 等价；但不得根据具体数字反推学生“可能写过”某个字母公式。无法找到有效证据时优先返回not_present，不得把所有未出现的步骤统一标为unreadable。已划掉内容不能证明评分点完成。confidence表示你对状态判断的可靠程度，不是正确或错误标签。核心公式实际写出且正确时应判为satisfied，即使后续计算错误；同一错误不得重复触发扣分。

        ${SCORE_POINT_EVIDENCE_PROTOCOL}

输出格式要求：每个 decisions 项都必须包含 awardedScore；satisfied、not_satisfied、not_present、unreadable 和 insufficient_evidence 不适用部分分时返回 null，只有评分标准明确允许部分分的 not_satisfied 才返回数字。没有复核原因时 reviewReason 返回空字符串。

在同一次响应中生成teacherCommentary。评语只能总结本次decisions、教师最终答案结论和卷面证据，不得重新解题、修改分数或创造评分点。最终答案正确且触发满分的小问，过程问题只能列入auditConcerns，不能列入lostPoints。所有引用必须使用已有的小问ID、评分点ID和证据行号；overallComment不写具体总分，由本地计分引擎负责。`,
        prompt: `必须判断本次评分标准中的每一个评分点：${processSubquestionIds.join(", ")}。最终答案正确的小问也不能跳过。所有评分点必须使用同一证据标准，不能因为最终答案状态而改变客观审验结论。审验结果用于过程展示、审计和复核；如果最终答案状态为correct，任何过程问题都不能降低该小问最终得分。本地程序只按照你的逐点决定和当前版本分值汇总总分，你只返回客观的逐点评审结果。

待判断评分标准：
${JSON.stringify(processRubric)}

教师模型最终答案结论（仅供分支和解释，不得修改）：
${JSON.stringify(finalAnswerJudgements)}

卷面转录：
${JSON.stringify(evidence)}`,
        images: preparedStudentAnswer.modelImages,
        schemaName: "process_point_judgement_with_commentary",
        schema: processJudgementWithCommentaryJsonSchema,
        validate: (value) => processJudgementWithCommentarySchema.parse(value),
        reasoningEffort: processRoute.reasoningEffort,
        operationId
      });
      const parsedProcess = processJudgementWithCommentarySchema.parse(processResponse.data);
      decisions = parsedProcess.decisions.filter((item) => processSubquestionIds.includes(item.subquestionId));
      const lockedMissingSubquestions = new Set(finalAnswerJudgements
        .filter((item) => item.status === "missing" && item.answerPresence === "no_effective_answer")
        .map((item) => item.subquestionId));
      decisions = decisions.map((decision) => lockedMissingSubquestions.has(decision.subquestionId)
        ? {
            ...decision,
            status: "not_present" as const,
            evidenceLineIds: [],
            evidenceQuote: "",
            reason: "该小问未发现有效学生作答；扫描阴影、孤立痕迹和背景噪声不作为评分证据。",
            confidence: Math.max(decision.confidence, 0.9),
            requiresReview: false,
            reviewReason: undefined,
            decisionSource: "normalized_uncertain" as const
          }
        : decision);
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

    const localReview = await reviewUnreadablePoints(config, input, operationId, preparedStudentAnswer.preparation.buffer, preparedStudentAnswer.studentImage, evidence, decisions, finalAnswerJudgements);
    const numericReview = await reviewNumericFinalAnswers(
      config,
      input,
      operationId,
      preparedStudentAnswer.preparation.buffer,
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
    result.imagePreprocessAudit = preparedStudentAnswer.preparation.audit;
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
    return { result, operationId, artifactSource };
  } catch (error) {
    failOperation(operationId, "grading", "grading_failed", error, { studentId: input.studentId });
    // 失败路径统一释放模型调用记录，避免调用方无法拿到 operationId 时泄漏（成功路径由保存方释放）。
    releaseOperationModelCalls(operationId);
    throw error;
  }
}
