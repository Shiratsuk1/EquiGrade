import type {
  AnswerEvidence,
  AnswerLine,
  AnswerPresenceAudit,
  AppliedDeduction,
  FinalAnswerJudgement,
  GradingResult,
  ModelConfigInput,
  OcrTranscription,
  OcrTranscriptionLine,
  PaddleOcrAudit,
  Rubric,
  RubricDecision,
  StudentAnswerImagePreprocessAudit
} from "../shared/types.js";
import { getBuiltInSystemPrompt } from "../shared/modelPrompts.js";
import { calculateGrade, createFallbackTeacherCommentary, normalizeEvidenceReferences } from "./gradingEngine.js";
import {
  largeQuestionAnswerTriageJsonSchema,
  largeQuestionAnswerTriageSchema,
  largeQuestionPointReviewJsonSchema,
  largeQuestionPointReviewSchema
} from "./schemas.js";
import { callStructured } from "./modelClient.js";
import { resolveModelRoute } from "./modelRouting.js";
import sharp from "sharp";
import type { GradingArtifactSource } from "./gradingArtifactStore.js";
import {
  createDirectBlockReviewImage,
  createDirectOcrBlockIndexImage,
  normalizeDirectVisualReviewPlan,
  runDirectVisualReview,
  type DirectVisualReviewImage,
  type DirectVisualReviewPayloadItem
} from "./directVisualReview.js";
import { runPaddleOcr } from "./paddleOcr.js";
import { detectModelNativeLayout } from "./modelNativeLayout.js";
import { comparePhysicsAnswer } from "./physicsAnswerEquivalence.js";
import { normalizeFinalAnswerJudgement } from "./finalAnswerNormalization.js";
import { combineFinalAnswerExpression } from "../shared/finalAnswer.js";
import {
  completeOperation,
  getOperationSignal,
  isOperationCancelled,
  logProgress,
  throwIfOperationCancelled
} from "./systemLog.js";

export interface LargeQuestionGradingImage {
  mimeType: string;
  base64: string;
  label?: string;
}

export interface LargeQuestionGradingInput {
  id: string;
  studentId: string;
  fileName: string;
  mimeType: string;
  imageBuffer: Buffer;
  rubric: Rubric;
  questionText?: string;
  referenceText?: string;
  questionImages?: LargeQuestionGradingImage[];
  referenceImages?: LargeQuestionGradingImage[];
  /** Controlled replay can reuse a previously saved OCR audit without contacting PaddleOCR. */
  ocrAudit?: PaddleOcrAudit;
  previousResultId?: string;
  regradedAt?: string;
  regradeReason?: string;
}

export interface LargeQuestionPreparedStudentAnswer {
  preparation: {
    buffer: Buffer;
    mimeType: string;
    audit: StudentAnswerImagePreprocessAudit;
  };
  modelImages: LargeQuestionGradingImage[];
}

type OcrBlock = NonNullable<PaddleOcrAudit["layoutBlocks"]>[number];

/**
 * A layout label is only a hint from PaddleOCR.  In practice handwritten
 * answers are sometimes classified as `header` or `table`, so filtering by
 * that label would silently remove valid evidence.  Keep a small geometric
 * guard here instead: only blocks with a real, finite, in-bounds rectangle
 * are safe to use as an evidence/search anchor.
 */
const MINIMUM_OCR_BLOCK_AREA = 4;

interface NormalizedLargeQuestionAnswer {
  subquestionId: string;
  status: FinalAnswerJudgement["status"];
  answerPresence?: FinalAnswerJudgement["answerPresence"];
  studentAnswer: string;
  confidence: number;
  reason: string;
  blockIds: string[];
  coordinate?: number[] | null;
  evidenceLineIds: string[];
  evidenceLineIdsByBlockId: Map<string, string>;
}

interface LargeQuestionPointReviewTarget {
  subquestion: Rubric["subquestions"][number];
  blockIds: string[];
  evidenceLineIdsByBlockId: Map<string, string>;
}

interface LargeQuestionPointReviewOutcome {
  decisions: RubricDecision[];
  appliedDeductions: AppliedDeduction[];
  evidenceLines: AnswerLine[];
  reviewReasons: string[];
  durationMs: number;
}

function dedupeImages(images: LargeQuestionGradingImage[]): LargeQuestionGradingImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = `${image.mimeType}:${image.base64}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isUsableOcrBlock(block: OcrBlock, ocr: PaddleOcrAudit): boolean {
  const coordinate = block.coordinate;
  if (!Array.isArray(coordinate) || coordinate.length !== 4 || coordinate.some((value) => !Number.isFinite(value))) return false;
  const [x1, y1, x2, y2] = coordinate;
  if (!(x2 > x1 && y2 > y1)) return false;
  const width = x2 - x1;
  const height = y2 - y1;
  if (width * height < MINIMUM_OCR_BLOCK_AREA) return false;
  if (!block.blockId.trim()) return false;
  const imageWidth = ocr.imageWidth;
  const imageHeight = ocr.imageHeight;
  if (imageWidth !== undefined && (!Number.isFinite(imageWidth) || imageWidth <= 0)) return false;
  if (imageHeight !== undefined && (!Number.isFinite(imageHeight) || imageHeight <= 0)) return false;
  if (imageWidth !== undefined && (x1 < 0 || x2 > imageWidth)) return false;
  if (imageHeight !== undefined && (y1 < 0 || y2 > imageHeight)) return false;
  return true;
}

export function usableOcrBlocks(ocr: PaddleOcrAudit): OcrBlock[] {
  const seenBlockIds = new Set<string>();
  return (ocr.layoutBlocks ?? []).filter((block) => {
    if (!isUsableOcrBlock(block, ocr) || seenBlockIds.has(block.blockId)) return false;
    seenBlockIds.add(block.blockId);
    return true;
  });
}

function blockRegion(block: OcrBlock): [number, number, number, number] {
  const [x1, y1, x2, y2] = block.coordinate;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(1, Math.abs(x2 - x1)), Math.max(1, Math.abs(y2 - y1))];
}

function finalAnswerTexts(subquestion: Rubric["subquestions"][number]): string[] {
  return subquestion.finalAnswers
    .map((answer) => combineFinalAnswerExpression(answer.expression, answer.unit))
    .filter(Boolean);
}

function finalAnswerText(subquestion: Rubric["subquestions"][number]): string {
  return finalAnswerTexts(subquestion).join(" 或 ");
}

function buildAnswerPresenceAudit(answers: NormalizedLargeQuestionAnswer[]): AnswerPresenceAudit {
  const priority: Record<NonNullable<NormalizedLargeQuestionAnswer["answerPresence"]>, number> = {
    image_unreliable: 5,
    unreadable_answer: 4,
    probable_answer: 3,
    no_effective_answer: 2,
    confirmed_answer: 1
  };
  const classified = answers.filter((answer): answer is NormalizedLargeQuestionAnswer & { answerPresence: NonNullable<NormalizedLargeQuestionAnswer["answerPresence"]> } => Boolean(answer.answerPresence));
  const classification = classified.sort((a, b) => priority[b.answerPresence] - priority[a.answerPresence])[0]?.answerPresence ?? "image_unreliable";
  return {
    classification,
    confidence: classified.length ? Math.min(...classified.map((answer) => answer.confidence)) : 0,
    candidateRegions: classified
      .filter((answer) => answer.answerPresence !== "no_effective_answer")
      .flatMap((answer) => answer.blockIds.map(() => ({ reason: answer.answerPresence === "unreadable_answer" ? "connected_strokes" as const : "character_cluster" as const }))),
    artifactReasons: answers
      .filter((answer) => answer.answerPresence === "no_effective_answer")
      .map((answer) => `${answer.subquestionId}:no_effective_answer`)
  };
}

export function hasExplicitMissingAudit(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return false;
  const missingClaim = /未(?:[^\s，。；、]{0,6})?(?:发现|见|找到|写出|给出|列出|求出|得出|计算|求解|推导|作答|出现|观察到|涉及|表达|作|做|提供|包含)|没有(?:[^\s，。；、]{0,6})?(?:发现|看到|出现|写出|给出|列出|求出|得出|计算|求解|推导|作答|做|涉及|提供|相关)|无(?:相关)?(?:作答|内容|证据|算式|过程|表达|结果|步骤|文字)|not\s+(?:found|present|written|observed)|no\s+(?:relevant\s+)?(?:answer|work|evidence)/i.test(normalized);
  const searchScope = /整页|全页|全卷|卷面|答卷|各(?:区块|区域)|逐(?:个|块|区块|区域)|所有(?:区块|区域)|通读|搜索|查找|检查|核对|遍历|扫描|审验|排查|block|blocks|whole\s+page|all\s+blocks|search(?:ed|ing)?|check(?:ed|ing)?/i.test(normalized);
  return missingClaim && searchScope;
}

const MISSING_AUDIT_REVIEW_REASON = "not_present 缺少完整的缺失审验依据：必须提供至少一个有效 OCR 区块，并在 reason 中明确说明搜索范围和未发现的内容。";

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

function normalizeLargeQuestionAnswerTriage(
  value: unknown,
  rubric: Rubric,
  ocr: PaddleOcrAudit
): {
  answers: NormalizedLargeQuestionAnswer[];
  finalAnswerJudgements: FinalAnswerJudgement[];
  evidence: AnswerEvidence;
  ocrTranscription?: OcrTranscription;
  pointReviewTargets: LargeQuestionPointReviewTarget[];
  reviewItems: DirectVisualReviewPayloadItem[];
  issues: string[];
} {
  const parsed = largeQuestionAnswerTriageSchema.parse(value);
  const blocks = usableOcrBlocks(ocr);
  const blockMap = new Map(blocks.map((block) => [block.blockId, block]));
  const subquestionMap = new Map(rubric.subquestions.map((subquestion) => [subquestion.id, subquestion]));
  const seenSubquestionIds = new Set<string>();
  const issues: string[] = [];
  const answersById = new Map<string, NormalizedLargeQuestionAnswer>();

  const unusableBlockIds = (ocr.layoutBlocks ?? [])
    .filter((block) => !isUsableOcrBlock(block, ocr))
    .map((block) => block.blockId.trim() || "（无 block_id）");
  if (unusableBlockIds.length) {
    const uniqueUnusableBlockIds = [...new Set(unusableBlockIds)];
    issues.push(`PaddleOCR 返回了 ${uniqueUnusableBlockIds.length} 个坐标非法、越界或无意义的区块（${uniqueUnusableBlockIds.join("、")}），已从可引用证据和缺失审验范围中排除。`);
  }

  for (const raw of parsed.answers) {
    const subquestion = subquestionMap.get(raw.subquestionId);
    if (!subquestion) {
      issues.push(`首轮答案判定返回了未知小问 ${raw.subquestionId}，已忽略。`);
      continue;
    }
    if (seenSubquestionIds.has(raw.subquestionId)) {
      issues.push(`首轮答案判定重复返回小问 ${raw.subquestionId}，已保留首次结果。`);
      continue;
    }
    seenSubquestionIds.add(raw.subquestionId);
    const rawBlockIds = [...new Set(raw.blockIds.map((blockId) => blockId.trim()).filter(Boolean))];
    const unknownBlockIds = rawBlockIds.filter((blockId) => !blockMap.has(blockId));
    if (unknownBlockIds.length) issues.push(`${subquestion.title}引用了不存在或不可用于复核的 OCR 区块：${unknownBlockIds.join("、")}。`);
    const blockIds = rawBlockIds.filter((blockId) => blockMap.has(blockId));
    const studentAnswer = raw.studentAnswer.trim();
    let status = raw.status;
    let answerPresence = raw.answerPresence;
    let reason = raw.reason.trim() || `首轮判定为 ${status}`;
    if (status === "correct" && (!studentAnswer || !finalAnswerText(subquestion))) {
      status = "uncertain";
      issues.push(`${subquestion.title}首轮声称答案正确，但缺少可核对的答案文本或评分标准最终答案，已降为不确定。`);
    } else if ((status === "correct" || status === "incorrect") && blockIds.length === 0) {
      status = "uncertain";
      issues.push(`${subquestion.title}首轮最终答案没有绑定有效 OCR 区块，已降为不确定并加入复核。`);
    }
    if ((status === "incorrect" || status === "missing") && studentAnswer && subquestion.finalAnswers.length) {
      const comparison = comparePhysicsAnswer(studentAnswer, subquestion.finalAnswers);
      if (answerMatchesAnyFinalAnswer(studentAnswer, subquestion) || comparison.status === "convention_unclear") {
        status = "uncertain";
        reason = `${reason}；本地物理语义审计结果为 ${comparison.status}，不允许仅因符号、正方向、作用主体或等价答案差异直接判错。`;
        issues.push(`${subquestion.title}的最终答案存在物理语义等价或符号约定不明，已从 ${raw.status} 降为不确定并进入复核。`);
      }
    }
    const inferredPresence = answerPresence ?? (raw.blockIds.length > 0
      ? (status === "uncertain" ? "unreadable_answer" : "confirmed_answer")
      : undefined);
    const normalized = normalizeFinalAnswerJudgement({
      subquestionId: raw.subquestionId,
      status,
      answerPresence: inferredPresence,
      evidenceLineIds: [],
      studentAnswer,
      referenceAnswer: finalAnswerText(subquestion),
      reason,
      confidence: Math.max(0, Math.min(1, raw.confidence)),
      decisionSource: "teacher_model"
    });
    status = normalized.judgement.status;
    answerPresence = normalized.judgement.answerPresence;
    reason = normalized.judgement.reason;
    if (normalized.changed) issues.push(`${subquestion.title}首轮答案已按有效作答证据归一化为 ${status}。`);
    answersById.set(raw.subquestionId, {
      subquestionId: raw.subquestionId,
      status,
      answerPresence,
      studentAnswer,
      confidence: Math.max(0, Math.min(1, raw.confidence)),
      reason,
      blockIds,
      coordinate: raw.coordinate ?? null,
      evidenceLineIds: [],
      evidenceLineIdsByBlockId: new Map()
    });
  }

  for (const subquestion of rubric.subquestions) {
    if (answersById.has(subquestion.id)) continue;
    issues.push(`${subquestion.title}缺少首轮最终答案判定，已按不确定处理并加入复核。`);
    answersById.set(subquestion.id, {
      subquestionId: subquestion.id,
      status: "uncertain",
      answerPresence: "image_unreliable",
      studentAnswer: "",
      confidence: 0,
      reason: "首轮教师模型没有返回该小问的最终答案判定。",
      blockIds: [],
      coordinate: null,
      evidenceLineIds: [],
      evidenceLineIdsByBlockId: new Map()
    });
  }

  const evidenceLines: AnswerLine[] = [];
  const finalAnswers: AnswerEvidence["finalAnswers"] = [];
  const ambiguities: AnswerEvidence["ambiguities"] = [];
  const transcriptionLines: OcrTranscriptionLine[] = [];
  const seenTranscriptionBlocks = new Set<string>();
  for (const rawLine of parsed.transcription.lines) {
    const blockId = rawLine.blockId.trim();
    const block = blockMap.get(blockId);
    if (!block) {
      issues.push(`教师模型转录引用了不存在或不可用于转录的 OCR 区块 ${blockId}，已忽略。`);
      continue;
    }
    if (seenTranscriptionBlocks.has(blockId)) {
      issues.push(`教师模型重复转录 OCR 区块 ${blockId}，已保留第一条。`);
      continue;
    }
    seenTranscriptionBlocks.add(blockId);
    transcriptionLines.push({
      id: `OCR-${blockId}`,
      text: rawLine.text,
      ...(rawLine.latex === undefined ? {} : { latex: rawLine.latex }),
      region: blockRegion(block),
      status: rawLine.status,
      confidence: rawLine.confidence,
      alternatives: rawLine.alternatives,
      blockId,
      blockLabel: block.label,
      ocrScore: block.score
    });
  }
  const missingTranscriptionBlockIds = blocks
    .map((block) => block.blockId)
    .filter((blockId) => !seenTranscriptionBlocks.has(blockId));
  if (missingTranscriptionBlockIds.length) {
    issues.push(`教师模型未返回 ${missingTranscriptionBlockIds.length} 个 OCR 区块的转录，已标记人工复核：${missingTranscriptionBlockIds.join("、")}。`);
  }
  const answers = rubric.subquestions.map((subquestion) => {
    const answer = answersById.get(subquestion.id)!;
    for (const blockId of answer.blockIds) {
      const block = blockMap.get(blockId);
      if (!block) continue;
      if (answer.status === "missing" && answer.answerPresence === "no_effective_answer") continue;
      const lineId = `triage-${subquestion.id}-${blockId}`;
      answer.evidenceLineIds.push(lineId);
      answer.evidenceLineIdsByBlockId.set(blockId, lineId);
      const line: AnswerLine = {
        id: lineId,
        text: answer.studentAnswer,
        region: blockRegion(block),
        status: answer.status === "uncertain" || answer.status === "missing" ? "uncertain" : "active",
        confidence: answer.confidence,
        alternatives: []
      };
      evidenceLines.push(line);
    }
    if (answer.evidenceLineIds[0] && answer.studentAnswer) {
      finalAnswers.push({ subquestionId: subquestion.id, lineId: answer.evidenceLineIds[0], expression: answer.studentAnswer, confidence: answer.confidence });
    }
    if (answer.status === "uncertain") {
      ambiguities.push({
        ...(answer.evidenceLineIds[0] ? { lineId: answer.evidenceLineIds[0] } : {}),
        reason: answer.reason,
        scoreImpact: "possible"
      });
    }
    return answer;
  });
  const evidence = normalizeEvidenceReferences({ lines: evidenceLines, finalAnswers, ambiguities });
  const finalAnswerJudgements = answers.map((answer) => ({
    subquestionId: answer.subquestionId,
    status: answer.status,
    answerPresence: answer.answerPresence,
    evidenceLineIds: answer.evidenceLineIds,
    studentAnswer: answer.studentAnswer,
    referenceAnswer: finalAnswerText(subquestionMap.get(answer.subquestionId)!),
    reason: answer.reason,
    confidence: answer.confidence,
    decisionSource: "teacher_model" as const
  }));
  const ocrTranscription = Array.isArray(ocr.layoutBlocks)
    ? {
        lines: transcriptionLines,
        blockCount: blocks.length,
        verifiedBlockCount: transcriptionLines.length,
        missingBlockIds: blocks.map((block) => block.blockId).filter((blockId) => !seenTranscriptionBlocks.has(blockId))
      }
    : undefined;
  const pointReviewTargets = answers
    .filter((answer) => answer.status !== "correct" && !(answer.status === "missing" && answer.answerPresence === "no_effective_answer"))
    .map((answer) => ({
      subquestion: subquestionMap.get(answer.subquestionId)!,
      blockIds: answer.blockIds,
      evidenceLineIdsByBlockId: answer.evidenceLineIdsByBlockId
    }));
  const reviewItems = pointReviewTargets.flatMap((target): DirectVisualReviewPayloadItem[] => {
    const expectedAnswers = finalAnswerTexts(target.subquestion);
    if (!expectedAnswers.length) return [];
    const answer = answersById.get(target.subquestion.id)!;
    const recognized = answer.studentAnswer || "未写出最终答案";
    const candidates = [...new Set([recognized, ...expectedAnswers])];
    return [{
      review_id: `auto-final-answer-${target.subquestion.id}`,
      block_id: answer.blockIds[0] ?? "",
      criterion_id: `${target.subquestion.id}:final`,
      target: `${target.subquestion.title}的最终答案`,
      recognized,
      candidates,
      reason: `首轮最终答案判定为${answer.status}，必须结合对应 OCR 区块独立核对预处理后的答卷图。`,
      score_effect: candidates.map((candidate) => ({ candidate, score: answerMatchesAnyFinalAnswer(candidate, target.subquestion) ? target.subquestion.maxScore : 0 }))
    }];
  });
  return { answers, finalAnswerJudgements, evidence, ocrTranscription, pointReviewTargets, reviewItems, issues };
}

function createFinalAnswerAuthorityDecisions(rubric: Rubric, finalAnswerJudgements: FinalAnswerJudgement[]): RubricDecision[] {
  const correctIds = new Set(finalAnswerJudgements.filter((item) => item.status === "correct").map((item) => item.subquestionId));
  return rubric.subquestions.flatMap((subquestion) => {
    if (!correctIds.has(subquestion.id)) return [];
    const judgement = finalAnswerJudgements.find((item) => item.subquestionId === subquestion.id);
    return subquestion.scorePoints.map((point): RubricDecision => ({
      subquestionId: subquestion.id,
      pointId: point.id,
      status: "not_present",
      evidenceLineIds: [],
      evidenceQuote: "",
      reason: "首轮已确认该小问最终答案正确，按规则直接满分；本次未执行小分审验。",
      confidence: judgement?.confidence ?? 1,
      requiresReview: false,
      decisionSource: "final_answer_authority"
    }));
  });
}

export interface SubquestionAnswerCropItem {
  subquestionId: string;
  subquestionTitle: string;
  buffer: Buffer;
  mimeType: string;
  pixelRegion: [number, number, number, number];
  source: "model_coordinate" | "block_anchor";
}

export async function extractSubquestionAnswerCrops(
  studentImageBuffer: Buffer,
  rubric: Rubric,
  answers: NormalizedLargeQuestionAnswer[],
  ocr: PaddleOcrAudit
): Promise<{
  crops: SubquestionAnswerCropItem[];
  preCroppedImages: Map<string, DirectVisualReviewImage>;
}> {
  const crops: SubquestionAnswerCropItem[] = [];
  const preCroppedImages = new Map<string, DirectVisualReviewImage>();
  if (!studentImageBuffer.length) return { crops, preCroppedImages };

  let imageWidth = ocr.imageWidth ?? 0;
  let imageHeight = ocr.imageHeight ?? 0;
  try {
    const meta = await sharp(studentImageBuffer).metadata();
    if (meta.width && meta.height) {
      imageWidth = meta.width;
      imageHeight = meta.height;
    }
  } catch {
    // If metadata reading fails, keep ocr dimensions
  }
  if (!imageWidth || !imageHeight) return { crops, preCroppedImages };

  const blocks = usableOcrBlocks(ocr);
  const blockMap = new Map(blocks.map((b) => [b.blockId, b]));
  const subquestionMap = new Map(rubric.subquestions.map((s) => [s.id, s]));

  for (const answer of answers) {
    const subquestion = subquestionMap.get(answer.subquestionId);
    if (!subquestion) continue;

    let cropRect: [number, number, number, number] | null = null;
    let cropSource: "model_coordinate" | "block_anchor" = "model_coordinate";

    // 1. Try model-provided coordinate: [x1, y1, x2, y2] normalized to 0..1000
    if (
      Array.isArray(answer.coordinate) &&
      answer.coordinate.length === 4 &&
      answer.coordinate.every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      const [rx1, ry1, rx2, ry2] = answer.coordinate;
      const minX = Math.min(rx1, rx2);
      const maxX = Math.max(rx1, rx2);
      const minY = Math.min(ry1, ry2);
      const maxY = Math.max(ry1, ry2);

      if (maxX > minX && maxY > minY && minX >= 0 && maxX <= 1000 && minY >= 0 && maxY <= 1000) {
        const px1 = (minX / 1000) * imageWidth;
        const px2 = (maxX / 1000) * imageWidth;
        const py1 = (minY / 1000) * imageHeight;
        const py2 = (maxY / 1000) * imageHeight;

        const padX = 24;
        const padY = 24;
        const left = Math.max(0, Math.floor(px1 - padX));
        const top = Math.max(0, Math.floor(py1 - padY));
        const right = Math.min(imageWidth, Math.ceil(px2 + padX));
        const bottom = Math.min(imageHeight, Math.ceil(py2 + padY));
        const width = right - left;
        const height = bottom - top;

        if (width >= 10 && height >= 10) {
          cropRect = [left, top, width, height];
          cropSource = "model_coordinate";
        }
      }
    }

    // 2. Fallback to OCR layout block anchor if model coordinate not available
    if (!cropRect && answer.blockIds.length > 0) {
      const primaryBlock = blockMap.get(answer.blockIds[0]!);
      if (primaryBlock && Array.isArray(primaryBlock.coordinate) && primaryBlock.coordinate.length === 4) {
        const [bx1, by1, bx2, by2] = primaryBlock.coordinate;
        const ocrW = ocr.imageWidth && ocr.imageWidth > 0 ? ocr.imageWidth : imageWidth;
        const ocrH = ocr.imageHeight && ocr.imageHeight > 0 ? ocr.imageHeight : imageHeight;
        const scaleX = imageWidth / ocrW;
        const scaleY = imageHeight / ocrH;

        let left = Math.max(0, Math.floor(Math.min(bx1, bx2) * scaleX));
        let top = Math.max(0, Math.floor(Math.min(by1, by2) * scaleY));
        let right = Math.min(imageWidth, Math.ceil(Math.max(bx1, bx2) * scaleX));
        let bottom = Math.min(imageHeight, Math.ceil(Math.max(by1, by2) * scaleY));
        let width = right - left;
        let height = bottom - top;

        // If block is tall (>200px), final answer is typically in bottom 45%
        if (height > 200) {
          const cutTop = top + Math.floor(height * 0.55);
          top = cutTop;
          height = bottom - top;
        }

        const padX = Math.min(28, Math.max(8, Math.round(width * 0.05)));
        const padY = Math.min(36, Math.max(8, Math.round(height * 0.08)));
        left = Math.max(0, left - padX);
        top = Math.max(0, top - padY);
        right = Math.min(imageWidth, right + padX);
        bottom = Math.min(imageHeight, bottom + padY);
        width = right - left;
        height = bottom - top;

        if (width >= 10 && height >= 10) {
          cropRect = [left, top, width, height];
          cropSource = "block_anchor";
        }
      }
    }

    if (!cropRect) continue;

    try {
      const [left, top, width, height] = cropRect;
      const cropBuffer = await sharp(studentImageBuffer)
        .extract({ left, top, width, height })
        .webp({ quality: 90 })
        .toBuffer();

      const cropItem: SubquestionAnswerCropItem = {
        subquestionId: subquestion.id,
        subquestionTitle: subquestion.title,
        buffer: cropBuffer,
        mimeType: "image/webp",
        pixelRegion: cropRect,
        source: cropSource
      };
      crops.push(cropItem);

      const blockLabelPart = answer.blockIds.length ? `: ${answer.blockIds.join(",")}` : "";
      preCroppedImages.set(`auto-final-answer-${subquestion.id}`, {
        mimeType: "image/webp",
        base64: cropBuffer.toString("base64"),
        label: `[${subquestion.title}最终答案局部高清切图${blockLabelPart}]`
      });
    } catch {
      // Individual crop failure gracefully skipped
    }
  }

  return { crops, preCroppedImages };
}

function pointReviewFallback(target: LargeQuestionPointReviewTarget, reason: string): RubricDecision[] {
  return target.subquestion.scorePoints.map((point): RubricDecision => ({
    subquestionId: target.subquestion.id,
    pointId: point.id,
    status: "unreadable",
    evidenceLineIds: [],
    evidenceQuote: "",
    reason,
    confidence: 0,
    requiresReview: true,
    reviewReason: reason,
    decisionSource: "large_question_point_review"
  }));
}

async function runLargeQuestionPointReview(
  config: ModelConfigInput,
  input: LargeQuestionGradingInput,
  operationId: string,
  ocr: PaddleOcrAudit,
  targets: LargeQuestionPointReviewTarget[],
  studentImage: { buffer: Buffer; mimeType: string }
): Promise<LargeQuestionPointReviewOutcome> {
  const startedAt = performance.now();
  const reviewReasons: string[] = [];
  if (!targets.length) return { decisions: [], appliedDeductions: [], evidenceLines: [], reviewReasons, durationMs: 0 };

  const configuredReviewModel = config.modelRoutes?.large_question_point_review?.model?.trim() || config.reviewModel?.trim();
  let reviewRoute: ReturnType<typeof resolveModelRoute>;
  try {
    reviewRoute = resolveModelRoute(config, "large_question_point_review");
  } catch (error) {
    const reason = "未配置独立小分审验模型，已保留当前分数并标记人工复核。";
    return {
      decisions: targets.flatMap((target) => pointReviewFallback(target, reason)),
      appliedDeductions: [],
      evidenceLines: [],
      reviewReasons: [configuredReviewModel ? `${reason}（${error instanceof Error ? error.message : String(error)}）` : reason],
      durationMs: Math.round(performance.now() - startedAt)
    };
  }

  const blockMap = new Map(usableOcrBlocks(ocr).map((block) => [block.blockId, block]));
  const reviewImages: LargeQuestionGradingImage[] = [];
  const seenBlockIds = new Set<string>();
  for (const target of targets) {
    for (const blockId of target.blockIds) {
      if (seenBlockIds.has(blockId)) continue;
      seenBlockIds.add(blockId);
      const block = blockMap.get(blockId);
      if (!block) continue;
      try {
        const image = await createDirectBlockReviewImage(studentImage.buffer, ocr, block, `小分审验 ${target.subquestion.id}`);
        if (image) reviewImages.push(image);
        else reviewReasons.push(`小分审验区块 ${blockId} 无法生成局部图，改用预处理答卷图上下文。`);
      } catch (error) {
        reviewReasons.push(`小分审验区块 ${blockId} 局部图生成失败，改用预处理答卷图上下文：${error instanceof Error ? error.message : String(error)}。`);
      }
    }
  }
  let blockIndexImage: LargeQuestionGradingImage | undefined;
  try {
    blockIndexImage = await createDirectOcrBlockIndexImage(studentImage.buffer, ocr, "[PaddleOCR bbox定位索引图（小分审验）]") ?? undefined;
  } catch (error) {
    reviewReasons.push(`小分审验 bbox 定位索引图生成失败，改用预处理答卷图和局部图：${error instanceof Error ? error.message : String(error)}。`);
  }
  const images = dedupeImages([
    ...(input.questionImages ?? []),
    ...(input.referenceImages ?? []),
    ...reviewImages,
    ...(blockIndexImage ? [blockIndexImage] : []),
    {
      mimeType: studentImage.mimeType,
      base64: studentImage.buffer.toString("base64"),
      label: "[学生答卷图（预处理后小分审验上下文）]"
    }
  ]);
  const rubricProjection = targets.map((target) => ({
    id: target.subquestion.id,
    title: target.subquestion.title,
    maxScore: target.subquestion.maxScore,
    scorePoints: target.subquestion.scorePoints,
    deductions: target.subquestion.deductions,
    locationHintBlockIds: target.blockIds
  }));
  logProgress(operationId, "model", "large_question_point_review", "正在对首轮判错、判空或不确定的小问执行全卷视觉小分审验", {
    model: reviewRoute.model,
    routeKey: reviewRoute.routeKey,
    subquestionIds: targets.map((target) => target.subquestion.id),
    cropImageCount: reviewImages.length,
    imageCount: images.length,
    blockIndexImage: Boolean(blockIndexImage)
  });
  try {
    const response = await callStructured<unknown>(reviewRoute.config, {
      model: reviewRoute.model,
      routeKey: reviewRoute.routeKey,
      system: getBuiltInSystemPrompt(reviewRoute.routeKey),
      prompt: `请独立完成指定小问的小分审验。先通读预处理后的学生答卷整页图，再使用区块索引和局部放大图定位细节；不要依赖或复述首轮最终答案读取，不要输出最终答案判断。block_id 只是位置提示和审计锚点，不是“允许引用范围”；若首轮提示的区块不对，请在整页图中寻找真正相关的任意有效区块，header/table 标签也不能作为忽略理由。\n\n题目文字：\n${input.questionText?.trim() || "题目内容见题目图片"}\n\n参考答案文字：\n${input.referenceText?.trim() || "参考答案见参考答案图片"}\n\n指定小问及评分标准：\n${JSON.stringify(rubricProjection)}\n\nPaddleOCR 区块索引（只用于定位，不是事实依据；label 仅作提示）：\n${JSON.stringify({ image_width: ocr.imageWidth, image_height: ocr.imageHeight, blocks: usableOcrBlocks(ocr).map((block) => ({ block_id: block.blockId, label: block.label, coordinate: block.coordinate, score: block.score })) })}\n\n输出前自检：reviews 必须覆盖 ${targets.map((target) => target.subquestion.id).join("、")}；每个目标小问的 decisions 必须覆盖其全部评分点；satisfied/not_satisfied 和 appliedDeductions 的证据必须来自整页图中实际可见的区块，不能只因为区块不在首轮定位提示里就判定为没有证据；对于 not_present，必须同时提供有效 evidenceBlockIds 和包含“搜索范围 + 未发现内容”的明确 reason，否则改为 unreadable 并请求人工复核；appliedDeductions 只能使用该小问已有规则。`,
      images,
      schemaName: "large_question_point_review",
      schema: largeQuestionPointReviewJsonSchema,
      validate: (value) => largeQuestionPointReviewSchema.parse(value),
      reasoningEffort: reviewRoute.reasoningEffort ?? "low",
      operationId
    });
    throwIfOperationCancelled(operationId);
    const parsed = largeQuestionPointReviewSchema.parse(response.data);
    const decisions: RubricDecision[] = [];
    const appliedDeductions: AppliedDeduction[] = [];
    const evidenceLines: AnswerLine[] = [];
    const generatedEvidenceLineIds = new Map<string, string>();
    const makeEvidenceLineIds = (
      target: LargeQuestionPointReviewTarget,
      sourceKind: "point" | "deduction",
      sourceId: string,
      evidenceBlockIds: string[],
      evidenceQuote: string,
      confidence: number,
      status: AnswerLine["status"]
    ): string[] => {
      const quote = evidenceQuote.trim();
      return [...new Set(evidenceBlockIds.filter((blockId) => blockMap.has(blockId)))].flatMap((blockId) => {
        if (!quote) {
          const existingLineId = target.evidenceLineIdsByBlockId.get(blockId);
          return existingLineId ? [existingLineId] : [];
        }
        const key = `${sourceKind}:${target.subquestion.id}:${sourceId}:${blockId}`;
        const existingGeneratedLineId = generatedEvidenceLineIds.get(key);
        if (existingGeneratedLineId) return [existingGeneratedLineId];
        const block = blockMap.get(blockId);
        if (!block) return [];
        const lineId = `point-review-${target.subquestion.id}-${sourceKind}-${sourceId}-${blockId}`;
        generatedEvidenceLineIds.set(key, lineId);
        evidenceLines.push({
          id: lineId,
          text: quote,
          region: blockRegion(block),
          status,
          confidence,
          alternatives: []
        });
        return [lineId];
      });
    };
    const makeMissingAuditLineIds = (
      target: LargeQuestionPointReviewTarget,
      pointId: string,
      evidenceBlockIds: string[],
      reason: string,
      confidence: number
    ): string[] => [...new Set(evidenceBlockIds.filter((blockId) => blockMap.has(blockId)))].flatMap((blockId) => {
      const key = `missing-audit:${target.subquestion.id}:${pointId}:${blockId}`;
      const existingLineId = generatedEvidenceLineIds.get(key);
      if (existingLineId) return [existingLineId];
      const block = blockMap.get(blockId);
      if (!block) return [];
      const lineId = `point-review-${target.subquestion.id}-missing-audit-${pointId}-${blockId}`;
      generatedEvidenceLineIds.set(key, lineId);
      evidenceLines.push({
        id: lineId,
        text: `缺失审验锚点：${reason}`,
        region: blockRegion(block),
        // This line records where the page was searched.  It is deliberately
        // not active student evidence and therefore cannot silently support a
        // positive point or deduction.
        status: "uncertain",
        confidence: Math.min(0.59, Math.max(0, confidence)),
        alternatives: []
      });
      return [lineId];
    });
    const seenTargetIds = new Set<string>();
    for (const target of targets) {
      if (seenTargetIds.has(target.subquestion.id)) {
        reviewReasons.push(`小分审验重复返回小问 ${target.subquestion.id}，已保留首次结果。`);
        continue;
      }
      seenTargetIds.add(target.subquestion.id);
      const targetReview = parsed.reviews.find((item) => item.subquestionId === target.subquestion.id);
      if (!targetReview) {
        const reason = `${target.subquestion.title}的小分审验模型没有返回完整结果，保留当前分数并标记人工复核。`;
        decisions.push(...pointReviewFallback(target, reason));
        reviewReasons.push(reason);
        continue;
      }
      const pointMap = new Map(target.subquestion.scorePoints.map((point) => [point.id, point]));
      const seenPointIds = new Set<string>();
      for (const point of target.subquestion.scorePoints) {
        const raw = targetReview.decisions.find((item) => item.pointId === point.id);
        if (!raw) {
          const reason = `${target.subquestion.title}/${point.title}缺少小分审验结果，保留当前分数并标记人工复核。`;
          decisions.push(pointReviewFallback({ ...target, subquestion: { ...target.subquestion, scorePoints: [point] } }, reason)[0]!);
          reviewReasons.push(reason);
          continue;
        }
        if (seenPointIds.has(raw.pointId)) continue;
        seenPointIds.add(raw.pointId);
        const invalidBlockIds = raw.evidenceBlockIds.filter((blockId) => !blockMap.has(blockId));
        const evidenceBlockIds = [...new Set(raw.evidenceBlockIds.filter((blockId) => blockMap.has(blockId)))];
        let status: RubricDecision["status"] = raw.status;
        let decisionSource: RubricDecision["decisionSource"] = "model";
        let requiresReview = false;
        let reviewReason: string | undefined;
        const missingAuditValid = raw.status === "not_present"
          && invalidBlockIds.length === 0
          && evidenceBlockIds.length > 0
          && hasExplicitMissingAudit(raw.reason);
        const evidenceLineIds = raw.status === "not_present"
          ? missingAuditValid
            ? makeMissingAuditLineIds(target, raw.pointId, evidenceBlockIds, raw.reason.trim(), raw.confidence)
            : []
          : makeEvidenceLineIds(
            target,
            "point",
            raw.pointId,
            evidenceBlockIds,
            raw.evidenceQuote,
            raw.confidence,
            raw.status === "unreadable" ? "uncertain" : "active"
          );
        if (invalidBlockIds.length) {
          reviewReasons.push(`${target.subquestion.title}/${point.title}引用了不存在或不可用于复核的 OCR 区块：${invalidBlockIds.join("、")}。`);
        }
        if (raw.status === "not_present" && (!missingAuditValid || evidenceLineIds.length === 0)) {
          status = "unreadable";
          decisionSource = "large_question_point_review";
          requiresReview = true;
          reviewReason = MISSING_AUDIT_REVIEW_REASON;
          reviewReasons.push(`${target.subquestion.title}/${point.title}${reviewReason}`);
        } else if ((status === "satisfied" || status === "not_satisfied") && evidenceLineIds.length === 0) {
          status = "unreadable";
          decisionSource = "large_question_point_review";
          requiresReview = true;
          reviewReason = "小分审验结论缺少整页图中可定位的有效卷面证据";
          reviewReasons.push(`${target.subquestion.title}/${point.title}${reviewReason}，已标记人工复核。`);
        } else if (status === "unreadable") {
          decisionSource = "large_question_point_review";
          requiresReview = true;
          reviewReason = raw.reason || "局部小分证据仍无法可靠辨认";
        }
        decisions.push({
          subquestionId: target.subquestion.id,
          pointId: point.id,
          status,
          evidenceLineIds,
          evidenceQuote: raw.status === "not_present" ? "" : raw.evidenceQuote,
          reason: raw.reason || "小分审验完成",
          confidence: raw.confidence,
          requiresReview,
          ...(reviewReason ? { reviewReason } : {}),
          ...(status === "not_satisfied" ? { awardedScore: Math.max(0, Math.min(point.score, raw.awardedScore ?? 0)) } : {}),
          decisionSource
        });
      }
      for (const rawDeduction of targetReview.appliedDeductions) {
        const rule = target.subquestion.deductions.find((candidate) => candidate.id === rawDeduction.ruleId);
        if (!rule) {
          reviewReasons.push(`${target.subquestion.title}引用了未知扣分规则 ${rawDeduction.ruleId}，已忽略。`);
          continue;
        }
        const invalidBlockIds = rawDeduction.evidenceBlockIds.filter((blockId) => !blockMap.has(blockId));
        const evidenceBlockIds = [...new Set(rawDeduction.evidenceBlockIds.filter((blockId) => blockMap.has(blockId)))];
        const evidenceLineIds = makeEvidenceLineIds(
          target,
          "deduction",
          rawDeduction.ruleId,
          evidenceBlockIds,
          rawDeduction.evidenceQuote,
          rawDeduction.confidence,
          "active"
        );
        if (invalidBlockIds.length) {
          reviewReasons.push(`${target.subquestion.title}的扣分规则 ${rawDeduction.ruleId} 引用了不存在或不可用于复核的 OCR 区块：${invalidBlockIds.join("、")}。`);
        }
        if (!evidenceLineIds.length) {
          reviewReasons.push(`${target.subquestion.title}的扣分规则 ${rawDeduction.ruleId} 缺少可定位卷面证据，已忽略并标记复核。`);
          continue;
        }
        appliedDeductions.push({
          subquestionId: target.subquestion.id,
          ruleId: rule.id,
          evidenceLineIds,
          reason: rawDeduction.reason,
          confidence: rawDeduction.confidence
        });
      }
      const unknownPointIds = targetReview.decisions.map((item) => item.pointId).filter((pointId) => !pointMap.has(pointId));
      if (unknownPointIds.length) reviewReasons.push(`${target.subquestion.title}返回未知评分点：${[...new Set(unknownPointIds)].join("、")}，已忽略。`);
    }
    const returnedTargetIds = new Set(parsed.reviews.map((item) => item.subquestionId));
    const unknownTargetIds = [...returnedTargetIds].filter((id) => !targets.some((target) => target.subquestion.id === id));
    if (unknownTargetIds.length) reviewReasons.push(`小分审验返回了未知小问：${unknownTargetIds.join("、")}，已忽略。`);
    return { decisions, appliedDeductions, evidenceLines, reviewReasons: [...new Set(reviewReasons)], durationMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    const reason = "小分审验调用失败：" + (error instanceof Error ? error.message : String(error)) + "；已保留当前分数并标记人工复核。";
    reviewReasons.push(reason);
    logProgress(operationId, "grading", "large_question_point_review_failed", "小分审验失败，已保留当前分数并继续批改", {
      subquestionIds: targets.map((target) => target.subquestion.id),
      error: error instanceof Error ? error.message : String(error)
    }, "warning");
    return {
      decisions: targets.flatMap((target) => pointReviewFallback(target, reason)),
      appliedDeductions: [],
      evidenceLines: [],
      reviewReasons: [...new Set(reviewReasons)],
      durationMs: Math.round(performance.now() - startedAt)
    };
  }
}

export async function gradeLargeQuestionStaged(
  config: ModelConfigInput,
  input: LargeQuestionGradingInput,
  operationId: string,
  preparedStudentAnswer: LargeQuestionPreparedStudentAnswer,
  artifactSource?: GradingArtifactSource
): Promise<GradingResult> {
  const replayingOcr = Boolean(input.ocrAudit);
  const useModelNativeLayout = config.stagedLayoutEngine === "model_native";
  const studentImage = preparedStudentAnswer.preparation;
  logProgress(operationId, "grading", replayingOcr ? "paddleocr_replay_started" : (useModelNativeLayout ? "model_layout_started" : "paddleocr_started"), replayingOcr
    ? "大题链路正在加载已保存的版面分析审计结果并提取区块索引"
    : (useModelNativeLayout
      ? "大题链路正在调用模型原生视觉分块定位作答区域（已绕过 PaddleOCR）"
      : "大题链路正在调用 PaddleOCR 读取整张学生答卷并提取 OCR 区块索引"), {
    provider: useModelNativeLayout ? "model_native" : "paddleocr",
    model: useModelNativeLayout
      ? (config.modelRoutes?.large_question_layout_detection?.model || config.visionModel)
      : (config.paddleOcr?.model?.trim() || process.env.PADDLEOCR_MODEL?.trim() || "PaddleOCR-VL-1.6"),
    imageBytes: studentImage.buffer.length,
    imageMimeType: studentImage.mimeType,
    imagePreprocessed: studentImage.audit.applied,
    source: replayingOcr ? "cached_replay" : "live"
  });
  let ocr: PaddleOcrAudit;
  if (input.ocrAudit) {
    ocr = { ...input.ocrAudit, source: "cached_replay" };
    logProgress(operationId, "grading", "paddleocr_replay_loaded", "已加载保存的版面分析审计结果，本次回放不重新请求服务", {
      source: "cached_replay",
      model: ocr.model,
      jobId: ocr.jobId,
      rawJsonlBytes: Buffer.byteLength(ocr.rawJsonl, "utf8"),
      markdownCharacters: ocr.markdownText.length,
      imageWidth: ocr.imageWidth,
      imageHeight: ocr.imageHeight,
      layoutBlocks: ocr.layoutBlocks?.length ?? 0
    });
  } else if (useModelNativeLayout) {
    try {
      ocr = await detectModelNativeLayout({
        imageBuffer: studentImage.buffer,
        mimeType: studentImage.mimeType,
        fileName: input.fileName,
        config,
        operationId
      });
    } catch (error) {
      logProgress(operationId, "grading", "model_layout_failed", "模型原生视觉分块定位失败，已停止本次大题批改", {
        error: error instanceof Error ? error.message : String(error)
      }, "error");
      throw error;
    }
  } else {
    try {
      ocr = await runPaddleOcr({
        imageBuffer: studentImage.buffer,
        mimeType: studentImage.mimeType,
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
  }
  logProgress(operationId, "grading", replayingOcr ? "paddleocr_replay_ready" : (useModelNativeLayout ? "model_layout_completed" : "paddleocr_completed"), replayingOcr
    ? "缓存版面分析审计结果已就绪，已保留原始区块索引"
    : (useModelNativeLayout
      ? "模型原生视觉分块完成，已定位卷面作答区域与边界框"
      : "PaddleOCR 整页识别完成，已保留原始 JSONL、辅助文字和 bbox 区块索引"), {
    provider: ocr.provider,
    model: ocr.model,
    jobId: ocr.jobId,
    source: replayingOcr ? "cached_replay" : "live",
    rawJsonlBytes: Buffer.byteLength(ocr.rawJsonl, "utf8"),
    markdownCharacters: ocr.markdownText.length,
    imageWidth: ocr.imageWidth,
    imageHeight: ocr.imageHeight,
    layoutBlocks: ocr.layoutBlocks?.length ?? 0,
    durationMs: ocr.durationMs
  });

  let blockIndexImage: LargeQuestionGradingImage | undefined;
  try {
    const indexLabel = ocr.provider === "model_native"
      ? "[模型原生视觉分块定位索引图（首轮）]"
      : "[PaddleOCR bbox定位索引图（首轮区块定位）]";
    blockIndexImage = await createDirectOcrBlockIndexImage(studentImage.buffer, ocr, indexLabel) ?? undefined;
  } catch (error) {
    logProgress(operationId, "grading", "ocr_bbox_index_image_failed", "版面分析 bbox 定位索引图生成失败，首轮仍使用预处理答卷图和坐标索引", {
      error: error instanceof Error ? error.message : String(error)
    }, "warning");
  }
  const contextImages = dedupeImages([
    ...(input.questionImages ?? []),
    ...(input.referenceImages ?? []),
    ...preparedStudentAnswer.modelImages,
    ...(blockIndexImage ? [blockIndexImage] : [])
  ]);
  const questionIds = input.rubric.subquestions.map((subquestion) => subquestion.id);
  const ocrBlockIndex = usableOcrBlocks(ocr).map((block) => ({
    block_id: block.blockId,
    page_index: block.pageIndex,
    label: block.label,
    score: block.score,
    coordinate: block.coordinate,
    polygon_points: block.polygonPoints,
    order: block.order
  }));
  const finalAnswerRubricProjection = input.rubric.subquestions.map((subquestion) => ({
    id: subquestion.id,
    title: subquestion.title,
    maxScore: subquestion.maxScore,
    finalAnswers: subquestion.finalAnswers
  }));
  const answerTriageRoute = resolveModelRoute(config, "large_question_answer_triage");
  logProgress(operationId, "model", "large_question_answer_triage", "首轮教师模型核验全量 OCR 区块转录，并确认每个小问对应的区块和最终答案正误", {
    model: answerTriageRoute.model,
    routeKey: answerTriageRoute.routeKey,
    questionImages: input.questionImages?.length ?? 0,
    referenceImages: input.referenceImages?.length ?? 0,
    studentImages: preparedStudentAnswer.modelImages.length,
    blockIndexImage: Boolean(blockIndexImage),
    subquestions: questionIds.length,
    ocrBlocks: ocrBlockIndex.length
  });
  const response = await callStructured<unknown>(answerTriageRoute.config, {
    model: answerTriageRoute.model,
    routeKey: answerTriageRoute.routeKey,
      system: getBuiltInSystemPrompt(answerTriageRoute.routeKey),
    prompt: `请先通读预处理后的学生答卷整页图，再结合 PaddleOCR bbox 定位索引图完成全量区块转录和首轮最终答案判定。先逐一核对每个 block_id 的实际内容并输出 transcription，再确认每个小问的最终答案区块、正误以及精确答案手写坐标；发现首轮候选区块与整页图不符时必须改用正确区块。\n\n题目文字（可能为空，题图可补足）：\n${input.questionText?.trim() || "题目内容见题目图片"}\n\n参考答案文字（可能为空，参考答案图可补足）：\n${input.referenceText?.trim() || "参考答案见参考答案图片"}\n\n本次唯一有效的最终答案标准：\n${JSON.stringify(finalAnswerRubricProjection)}\n\nPaddleOCR 辅助文字（只用于定位，不是最终事实）：\n${ocr.markdownText}\n\n可用 PaddleOCR 区块索引（label 仅作提示）：\n${JSON.stringify({ image_width: ocr.imageWidth, image_height: ocr.imageHeight, blocks: ocrBlockIndex })}\n\n必须覆盖的小问：${questionIds.join("、")}\n必须覆盖的转录区块：${ocrBlockIndex.map((block) => block.block_id).join("、") || "无"}\n\n关键要求：\n1. answers 中的每个小问必须返回 coordinate: [x1, y1, x2, y2]，表示该小问最终答案在答卷整页图上的 0..1000 归一化手写边界框（x1为左，y1为上，x2为右，y2为下，仅紧密框选手写最终结论；未作答或未写出填 null），用于系统高清晰度单独切图审验；\n2. transcription.lines 恰好逐个覆盖全部有效 block_id（包括 label 为 header/table 的区块），transcription.lines 不要返回坐标；\n3. blockIds 只使用上面索引中的 block_id；\n4. 输出前强制自检：answers 恰好覆盖上述小问且每个小问只出现一次；不要输出 evidence、pointJudgements、decisions、review_items 或其他字段。`,
    images: contextImages,
    schemaName: "large_question_answer_triage",
    schema: largeQuestionAnswerTriageJsonSchema,
    validate: (value) => largeQuestionAnswerTriageSchema.parse(value),
    reasoningEffort: answerTriageRoute.reasoningEffort,
    operationId
  });
  throwIfOperationCancelled(operationId);
  const triage = normalizeLargeQuestionAnswerTriage(response.data, input.rubric, ocr);
  logProgress(operationId, "grading", "large_question_answer_triage_ready", "首轮最终答案判定已返回，错误、判空或不确定小问将进入并行复核与小分审验", {
    durationMs: response.durationMs,
    answers: triage.finalAnswerJudgements.length,
    correct: triage.finalAnswerJudgements.filter((item) => item.status === "correct").length,
    incorrect: triage.finalAnswerJudgements.filter((item) => item.status === "incorrect").length,
    uncertain: triage.finalAnswerJudgements.filter((item) => item.status === "uncertain").length,
    missing: triage.finalAnswerJudgements.filter((item) => item.status === "missing").length,
    issues: triage.issues.length,
    mappedBlocks: triage.answers.reduce((sum, item) => sum + item.blockIds.length, 0)
  }, triage.issues.length ? "warning" : "success");
  if (triage.ocrTranscription) {
    logProgress(operationId, "grading", "ocr_answer_blocks_bound", "已将教师核验的全量 OCR 区块转录绑定到预处理答卷图坐标；答案区块仍仅用于定位辅助", {
      blockCount: triage.ocrTranscription.blockCount,
      verifiedBlockCount: triage.ocrTranscription.verifiedBlockCount,
      missingBlockIds: triage.ocrTranscription.missingBlockIds
    }, triage.ocrTranscription.missingBlockIds.length ? "warning" : "success");
  }

  const { crops, preCroppedImages } = await extractSubquestionAnswerCrops(
    studentImage.buffer,
    input.rubric,
    triage.answers,
    ocr
  );
  if (artifactSource && crops.length > 0) {
    artifactSource.subquestionCrops = crops.map((crop) => ({
      fileName: `subquestion-${crop.subquestionId}-crop.webp`,
      mimeType: crop.mimeType,
      category: "agent_region",
      buffer: crop.buffer
    }));
  }
  logProgress(operationId, "grading", "subquestion_crops_extracted", `已完成各小问最终答案局部高清切图（${crops.length}/${input.rubric.subquestions.length}）`, {
    extractedCrops: crops.length,
    totalSubquestions: input.rubric.subquestions.length,
    modelCoordinateCount: crops.filter((c) => c.source === "model_coordinate").length,
    blockAnchorCount: crops.filter((c) => c.source === "block_anchor").length
  });

  const initialDecisions = createFinalAnswerAuthorityDecisions(input.rubric, triage.finalAnswerJudgements);
  const initialResult = calculateGrade({
    id: input.id,
    studentId: input.studentId,
    fileName: input.fileName,
    rubric: input.rubric,
    evidence: triage.evidence,
    finalAnswerJudgements: triage.finalAnswerJudgements,
    decisions: initialDecisions,
    appliedDeductions: [],
    modelName: answerTriageRoute.model,
    gradingMode: "vision_direct",
    evidenceValidationMode: "direct_visual",
    durationMs: ocr.durationMs + response.durationMs,
    unreadableReviewThreshold: config.unreadableReviewThreshold,
    operationId,
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason
  });

  const allSubquestionsCorrect =
    input.rubric.subquestions.length > 0 &&
    triage.finalAnswerJudgements.length === input.rubric.subquestions.length &&
    triage.finalAnswerJudgements.every((item) => item.status === "correct") &&
    triage.pointReviewTargets.length === 0;

  if (allSubquestionsCorrect) {
    initialResult.gradingPipeline = "large_question";
    initialResult.ocrAudit = ocr;
    if (triage.ocrTranscription) initialResult.ocrTranscription = triage.ocrTranscription;
    initialResult.directVisualReviewAudit = {
      reviewRequired: false,
      reviewItems: [],
      results: [],
      initialScore: initialResult.score,
      finalScore: initialResult.score,
      initialSubquestionScores: initialResult.subquestions.map((sq) => ({ subquestionId: sq.id, score: sq.score, maxScore: sq.maxScore })),
      durationMs: 0
    };
    initialResult.imagePreprocessAudit = preparedStudentAnswer.preparation.audit;
    initialResult.answerPresenceAudit = buildAnswerPresenceAudit(triage.answers);
    if (triage.issues.length) {
      initialResult.reviewReasons = [...new Set([...initialResult.reviewReasons, ...triage.issues])];
      initialResult.status = "needs_review";
    }
    initialResult.teacherCommentary = createFallbackTeacherCommentary(initialResult);
    throwIfOperationCancelled(operationId);
    logProgress(operationId, "grading", "teacher_commentary_ready", "已根据最终答案权威生成本地结构化评语", {
      status: initialResult.teacherCommentary.status,
      version: initialResult.teacherCommentary.version,
      integratedModelCall: false
    }, "success");
    logProgress(operationId, "grading", "large_question_all_correct_fast_path", `全部小问最终答案首轮均判定正确，已执行全对快速满分通道（${initialResult.score}/${initialResult.maxScore}分），跳过第二轮复核与审验`, {
      score: initialResult.score,
      maxScore: initialResult.maxScore,
      subquestions: input.rubric.subquestions.length,
      extractedCrops: crops.length
    }, "success");
    const subSummary = initialResult.subquestions.map((sub) => `(${sub.id}) [${sub.score}/${sub.maxScore}分]`).join("，");
    completeOperation(operationId, "grading", "grading_completed", `${input.studentId}大题首轮全对满分完成：${initialResult.score}/${initialResult.maxScore}分 (${subSummary})`, {
      status: initialResult.status,
      gradingMode: "vision_direct",
      fastPath: true,
      reviewReasons: initialResult.reviewReasons.length,
      ocrJobId: ocr.jobId,
      subquestionCrops: crops.length,
      commentaryStatus: initialResult.teacherCommentary.status
    });
    return initialResult;
  }

  const plan = normalizeDirectVisualReviewPlan(
    triage.reviewItems.length > 0,
    triage.reviewItems,
    { imageBuffer: studentImage.buffer, rubric: input.rubric },
    ocr
  );
  logProgress(operationId, "grading", "large_question_reviews_started", "已并行发起错误、判空或不确定小问的整页视觉复核和全卷小分审验，两条支路均不阻断批改", {
    subquestionIds: triage.pointReviewTargets.map((target) => target.subquestion.id),
    localReviewItems: plan.items.length,
    pointReviewTargets: triage.pointReviewTargets.length
  }, triage.pointReviewTargets.length ? "warning" : "success");
  const [localReview, pointReview] = await Promise.all([
    runDirectVisualReview(
      config,
      { imageBuffer: studentImage.buffer, mimeType: studentImage.mimeType, rubric: input.rubric },
      operationId,
      ocr,
      plan,
      initialResult,
      initialDecisions,
      triage.finalAnswerJudgements,
      preCroppedImages
    ),
    runLargeQuestionPointReview(config, input, operationId, ocr, triage.pointReviewTargets, studentImage)
  ]);
  const reviewedPointKeys = new Set(pointReview.decisions.map((decision) => `${decision.subquestionId}:${decision.pointId}`));
  const decisions = [
    ...localReview.decisions.filter((decision) => !reviewedPointKeys.has(`${decision.subquestionId}:${decision.pointId}`)),
    ...pointReview.decisions
  ];
  const reviewedEvidence = normalizeEvidenceReferences({
    lines: [...triage.evidence.lines, ...pointReview.evidenceLines],
    finalAnswers: triage.evidence.finalAnswers,
    ambiguities: triage.evidence.ambiguities
  });
  const result = calculateGrade({
    id: input.id,
    studentId: input.studentId,
    fileName: input.fileName,
    rubric: input.rubric,
    evidence: reviewedEvidence,
    finalAnswerJudgements: localReview.finalAnswerJudgements,
    decisions,
    appliedDeductions: pointReview.appliedDeductions,
    modelName: answerTriageRoute.model,
    gradingMode: "vision_direct",
    evidenceValidationMode: "direct_visual",
    durationMs: ocr.durationMs + response.durationMs + localReview.durationMs + pointReview.durationMs,
    unreadableReviewThreshold: config.unreadableReviewThreshold,
    operationId,
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason
  });
  result.gradingPipeline = "large_question";
  result.ocrAudit = ocr;
  if (triage.ocrTranscription) result.ocrTranscription = triage.ocrTranscription;
  result.directVisualReviewAudit = { ...localReview.audit, finalScore: result.score };
  result.imagePreprocessAudit = preparedStudentAnswer.preparation.audit;
  result.answerPresenceAudit = buildAnswerPresenceAudit(triage.answers);
  const reviewReasons = [...triage.issues, ...localReview.reviewReasons, ...pointReview.reviewReasons];
  if (reviewReasons.length) {
    result.reviewReasons = [...new Set([...result.reviewReasons, ...reviewReasons])];
    result.status = "needs_review";
  }
  result.teacherCommentary = createFallbackTeacherCommentary(result);
  throwIfOperationCancelled(operationId);
  logProgress(operationId, "grading", "teacher_commentary_ready", "已根据最终答案权威、局部复核和小分审验结果生成本地结构化评语", {
    status: result.teacherCommentary.status,
    version: result.teacherCommentary.version,
    integratedModelCall: false
  }, "success");
  const subSummary = result.subquestions.map((sub) => `(${sub.id}) [${sub.score}/${sub.maxScore}分]`).join("，");
  completeOperation(operationId, "grading", "grading_completed", `${input.studentId}大题批改完成：${result.score}/${result.maxScore}分 (${subSummary})`, {
    status: result.status,
    gradingMode: "vision_direct",
    reviewReasons: result.reviewReasons.length,
    ocrJobId: ocr.jobId,
    localReviewItems: localReview.audit.reviewItems.length,
    localReviewResults: localReview.audit.results.length,
    pointReviewDecisions: pointReview.decisions.length,
    commentaryStatus: result.teacherCommentary.status
  });
  return result;
}
