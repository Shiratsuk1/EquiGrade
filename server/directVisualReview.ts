
import sharp from "sharp";
import { getBuiltInSystemPrompt } from "../shared/modelPrompts.js";
import type {
  DirectVisualReviewAudit,
  DirectVisualReviewPlanItem,
  DirectVisualReviewResult,
  FinalAnswerJudgement,
  GradingResult,
  ModelConfigInput,
  PaddleOcrAudit,
  Rubric,
  RubricDecision
} from "../shared/types.js";
import { directVisualReviewJsonSchema, directVisualReviewSchema } from "./schemas.js";
import { answerMatchesAnyFinalAnswer } from "./physicsAnswerEquivalence.js";
import { callStructured } from "./modelClient.js";
import { resolveModelRoute } from "./modelRouting.js";
import { isOperationCancelled, logProgress, throwIfOperationCancelled } from "./systemLog.js";

export interface DirectVisualReviewImage {
  mimeType: string;
  base64: string;
  label?: string;
}

type GradingImage = DirectVisualReviewImage;
type OcrBlock = NonNullable<PaddleOcrAudit["layoutBlocks"]>[number];

function isRenderableOcrBlock(block: OcrBlock): boolean {
  const [x1, y1, x2, y2] = block.coordinate;
  return Boolean(block.blockId.trim())
    && [x1, y1, x2, y2].every(Number.isFinite)
    && x2 > x1
    && y2 > y1;
}

export interface DirectVisualReviewPayloadItem {
  review_id: string;
  block_id: string;
  criterion_id: string;
  target: string;
  recognized: string;
  candidates: string[];
  reason: string;
  score_effect: Array<{ candidate: string; score: number }> | Record<string, number>;
}

export interface DirectVisualReviewInput {
  imageBuffer: Buffer;
  rubric: Rubric;
  mimeType?: string;
}

export interface NormalizedDirectVisualReviewPlan {
  reviewRequired: boolean;
  items: DirectVisualReviewPlanItem[];
  actionableItems: DirectVisualReviewPlanItem[];
  reasons: string[];
}

export interface DirectVisualReviewOutcome {
  decisions: RubricDecision[];
  finalAnswerJudgements: FinalAnswerJudgement[];
  pointScoreOverrides: Record<string, number>;
  audit: DirectVisualReviewAudit;
  reviewReasons: string[];
  durationMs: number;
}

function normalizeVisualReviewToken(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

function finalAnswerReviewReason(
  judgement: FinalAnswerJudgement,
  reviewResult: DirectVisualReviewResult,
): string {
  const firstRead = judgement.studentAnswer.trim();
  const confirmed = reviewResult.result.trim();
  if (!confirmed) {
    return judgement.reason;
  }
  if (!firstRead) {
    return `局部视觉复核确认最终答案为“${confirmed}”。`;
  }
  return `首轮识别为“${firstRead}”；局部视觉复核确认最终答案为“${confirmed}”。`;
}

function normalizeScoreEffect(value: DirectVisualReviewPayloadItem["score_effect"]): Record<string, number> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((entry) => [entry.candidate.trim(), entry.score]));
  }
  return Object.fromEntries(Object.entries(value).map(([key, score]) => [key.trim(), score]));
}

export function normalizeDirectVisualReviewPlan(
  reviewRequired: boolean,
  rawItems: DirectVisualReviewPayloadItem[],
  input: DirectVisualReviewInput,
  ocr: PaddleOcrAudit
): NormalizedDirectVisualReviewPlan {
  const pointMap = new Map(input.rubric.subquestions.flatMap((subquestion) => subquestion.scorePoints.map((point) => [
    subquestion.id + ":" + point.id,
    point
  ] as const)));
  const finalAnswerMap = new Map<string, Rubric["subquestions"][number]>(input.rubric.subquestions.map((subquestion) => [`${subquestion.id}:final`, subquestion]));
  const pointKeysByShortId = new Map<string, string[]>();
  for (const subquestion of input.rubric.subquestions) {
    for (const point of subquestion.scorePoints) {
      const keys = pointKeysByShortId.get(point.id) ?? [];
      keys.push(subquestion.id + ":" + point.id);
      pointKeysByShortId.set(point.id, keys);
    }
  }
  const blockMap = new Map((ocr.layoutBlocks ?? []).map((block) => [block.blockId, block]));
  const seenReviewIds = new Set<string>();
  const reasons: string[] = [];
  const items = rawItems.flatMap((raw): DirectVisualReviewPlanItem[] => {
    const reviewId = raw.review_id.trim();
    const blockId = raw.block_id.trim();
    const rawCriterionId = raw.criterion_id.trim();
    const shortMatches = pointKeysByShortId.get(rawCriterionId) ?? [];
    const criterionId = pointMap.has(rawCriterionId)
      ? rawCriterionId
      : shortMatches.length === 1
        ? shortMatches[0]
        : rawCriterionId;
    const candidates = [...new Set(raw.candidates.map((candidate) => candidate.trim()).filter(Boolean))];
    const scoreEffect = normalizeScoreEffect(raw.score_effect);
    const item: DirectVisualReviewPlanItem = {
      reviewId,
      blockId,
      criterionId,
      target: raw.target,
      recognized: raw.recognized,
      candidates,
      reason: raw.reason,
      scoreEffect
    };
    if (!reviewId || seenReviewIds.has(reviewId)) {
      reasons.push("局部复核计划存在重复或空 review_id：" + (reviewId || "（空）") + "，已保留首次计划。");
      return [];
    }
    seenReviewIds.add(reviewId);
    const point = pointMap.get(criterionId);
    const finalAnswer = finalAnswerMap.get(criterionId);
    const block = blockMap.get(blockId);
    const itemReasons: string[] = [];
    if (!point && !finalAnswer) itemReasons.push("criterion_id " + (rawCriterionId || "（空）") + " 不是当前评分点、最终答案目标或无法唯一映射");
    if (candidates.length < 2) itemReasons.push("候选结果少于两个，无法形成可审计的歧义复核");
    const candidateKeys = new Set(candidates.map(normalizeVisualReviewToken));
    const effectEntries = Object.entries(scoreEffect);
    if (effectEntries.some(([key, value]) => !candidateKeys.has(normalizeVisualReviewToken(key)) || !Number.isFinite(value))) {
      itemReasons.push("score_effect 存在候选列表之外的结果或非有限数字");
    }
    if (candidates.some((candidate) => !effectEntries.some(([key]) => normalizeVisualReviewToken(key) === normalizeVisualReviewToken(candidate)))) {
      itemReasons.push("score_effect 未覆盖全部候选结果");
    }
    const maximumEffect = point?.score ?? finalAnswer?.maxScore;
    if (maximumEffect !== undefined && effectEntries.some(([, value]) => value < 0 || value > maximumEffect)) {
      itemReasons.push("score_effect 超出目标 " + maximumEffect + " 分范围");
    }
    if (itemReasons.length) reasons.push("复核项 " + reviewId + " 无法安全执行：" + itemReasons.join("；") + "。");
    return [item];
  });
  const actionableItems = items.filter((item) => {
    const point = pointMap.get(item.criterionId);
    const finalAnswer = finalAnswerMap.get(item.criterionId);
    const maximumEffect = point?.score ?? finalAnswer?.maxScore;
    const block = blockMap.get(item.blockId);
    const candidateKeys = new Set(item.candidates.map(normalizeVisualReviewToken));
    const effects = Object.entries(item.scoreEffect);
    return Boolean((point || finalAnswer)
      && item.candidates.length >= 2
      && effects.length === item.candidates.length
      && effects.every(([key, value]) => candidateKeys.has(normalizeVisualReviewToken(key)) && Number.isFinite(value) && value >= 0 && value <= (maximumEffect ?? 0))
      && item.candidates.every((candidate) => effects.some(([key]) => normalizeVisualReviewToken(key) === normalizeVisualReviewToken(candidate))));
  });
  if (reviewRequired && !items.length) reasons.push("教师模型标记需要局部复核，但没有返回 review_items。");
  return { reviewRequired: reviewRequired || items.length > 0, items, actionableItems, reasons };
}

export async function createDirectBlockReviewImage(
  imageBuffer: Buffer,
  ocr: PaddleOcrAudit,
  block: NonNullable<PaddleOcrAudit["layoutBlocks"]>[number],
  reviewId: string
): Promise<GradingImage | null> {
  const metadata = await sharp(imageBuffer).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (!sourceWidth || !sourceHeight) return null;
  const ocrWidth = ocr.imageWidth && ocr.imageWidth > 0 ? ocr.imageWidth : sourceWidth;
  const ocrHeight = ocr.imageHeight && ocr.imageHeight > 0 ? ocr.imageHeight : sourceHeight;
  const scaleX = sourceWidth / ocrWidth;
  const scaleY = sourceHeight / ocrHeight;
  const [rawX1, rawY1, rawX2, rawY2] = block.coordinate;
  const x1 = Math.min(rawX1, rawX2) * scaleX;
  const y1 = Math.min(rawY1, rawY2) * scaleY;
  const x2 = Math.max(rawX1, rawX2) * scaleX;
  const y2 = Math.max(rawY1, rawY2) * scaleY;

  const blockWidth = x2 - x1;
  const blockHeight = y2 - y1;
  const isFinalAnswerReview = reviewId.includes("final-answer") || reviewId.includes(":final");

  // When focusing on final answers on macro-blocks (> 200px tall), the final
  // answer almost always resides in the lower portion of the derivation block.
  // Focusing on the lower window removes huge swaths of crossed-out scratchwork
  // and allows a much higher optical magnification on the actual answer formula.
  let effectiveY1 = y1;
  let effectiveY2 = y2;
  if (isFinalAnswerReview && blockHeight > 200) {
    effectiveY1 = y1 + blockHeight * 0.45;
  }
  const effectiveHeight = effectiveY2 - effectiveY1;

  // Keep nearby correction strokes and complete numerator/denominator in the crop.
  // For small blocks (< 140px), keep generous padding up to 20% horizontal and 40% vertical.
  // For large macro blocks, clamp padding to absolute pixel limits (max 28px horizontal, max 36px vertical)
  // so we don't balloon the crop across half the page into other questions or margins.
  const horizontalPadding = Math.min(28, Math.max(12, blockWidth * (blockWidth < 140 ? 0.2 : 0.08)));
  const verticalPadding = Math.min(36, Math.max(18, effectiveHeight * (effectiveHeight < 140 ? 0.4 : 0.12)));

  const left = Math.max(0, Math.floor(x1 - horizontalPadding));
  const top = Math.max(0, Math.floor(effectiveY1 - verticalPadding));
  const right = Math.min(sourceWidth, Math.ceil(x2 + horizontalPadding));
  const bottom = Math.min(sourceHeight, Math.ceil(effectiveY2 + verticalPadding));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(4, 2400 / width, 2400 / height);
  const reviewBuffer = await sharp(imageBuffer)
    .extract({ left, top, width, height })
    .resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), fit: "fill" })
    .png()
    .toBuffer();
  return { mimeType: "image/png", base64: reviewBuffer.toString("base64"), label: "[局部复核 " + reviewId + " / " + block.blockId + "]" };
}

function escapeSvgText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;"
  })[character] ?? character);
}

/**
 * Produce one visual index for all OCR boxes. The model already receives the
 * preprocessed page, but this overlay makes an incorrect block binding
 * auditable and lets a local reviewer search neighboring boxes instead of
 * trusting a single crop selected by the first pass.
 */
export async function createDirectOcrBlockIndexImage(
  imageBuffer: Buffer,
  ocr: PaddleOcrAudit,
  label = "[PaddleOCR bbox定位索引图]"
): Promise<GradingImage | null> {
  const blocks = (ocr.layoutBlocks ?? []).filter(isRenderableOcrBlock);
  if (!blocks.length) return null;
  const metadata = await sharp(imageBuffer).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (!sourceWidth || !sourceHeight) return null;
  const ocrWidth = ocr.imageWidth && ocr.imageWidth > 0 ? ocr.imageWidth : sourceWidth;
  const ocrHeight = ocr.imageHeight && ocr.imageHeight > 0 ? ocr.imageHeight : sourceHeight;
  const scaleX = sourceWidth / ocrWidth;
  const scaleY = sourceHeight / ocrHeight;
  const colors = ["#ef4444", "#2563eb", "#16a34a", "#d97706", "#9333ea", "#0891b2"];
  const overlays = blocks.map((block, index) => {
    const [rawX1, rawY1, rawX2, rawY2] = block.coordinate;
    const x1 = Math.max(0, Math.min(sourceWidth - 1, Math.min(rawX1, rawX2) * scaleX));
    const y1 = Math.max(0, Math.min(sourceHeight - 1, Math.min(rawY1, rawY2) * scaleY));
    const x2 = Math.max(x1 + 1, Math.min(sourceWidth, Math.max(rawX1, rawX2) * scaleX));
    const y2 = Math.max(y1 + 1, Math.min(sourceHeight, Math.max(rawY1, rawY2) * scaleY));
    const color = colors[index % colors.length]!;
    const text = escapeSvgText(block.blockId);
    const textY = Math.max(16, y1 - 2);
    return `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="${color}" stroke-width="3"/><rect x="${x1}" y="${textY - 14}" width="${Math.max(48, text.length * 9 + 8)}" height="16" fill="${color}" opacity="0.9"/><text x="${x1 + 3}" y="${textY - 2}" font-size="13" font-family="Arial, sans-serif" font-weight="bold" fill="white">${text}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sourceWidth}" height="${sourceHeight}"><rect width="100%" height="100%" fill="transparent"/>${overlays}</svg>`;
  const maxDimension = 1800;
  const scale = Math.min(1, maxDimension / sourceWidth, maxDimension / sourceHeight);
  const indexed = await sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), blend: "over" }])
    .resize({ width: Math.max(1, Math.round(sourceWidth * scale)), height: Math.max(1, Math.round(sourceHeight * scale)), fit: "fill" })
    .png()
    .toBuffer();
  return { mimeType: "image/png", base64: indexed.toString("base64"), label };
}

function uncertainResult(reviewId: string, reason: string): DirectVisualReviewResult {
  return { reviewId, result: "uncertain", certainty: "uncertain", reason };
}

function isMissingVisualReviewResult(value: string): boolean {
  const normalized = normalizeVisualReviewToken(value).toLowerCase();
  return normalized === "missing"
    || normalized === "未写出最终答案"
    || normalized === "未发现最终答案"
    || normalized === "没有最终答案";
}

export async function runDirectVisualReview(
  config: ModelConfigInput,
  input: DirectVisualReviewInput,
  operationId: string,
  ocr: PaddleOcrAudit,
  plan: NormalizedDirectVisualReviewPlan,
  initialResult: GradingResult,
  decisions: RubricDecision[],
  finalAnswerJudgements: FinalAnswerJudgement[],
  preCroppedImages?: Map<string, GradingImage>
): Promise<DirectVisualReviewOutcome> {
  const startedAt = performance.now();
  const reviewReasons = [...plan.reasons];
  const results: DirectVisualReviewResult[] = [];
  const pointScoreOverrides: Record<string, number> = {};
  let nextDecisions = decisions.map((decision) => ({ ...decision }));
  let nextFinalAnswerJudgements = finalAnswerJudgements.map((judgement) => ({ ...judgement }));
  const initialSubquestionScores = initialResult.subquestions.map((subquestion) => ({
    subquestionId: subquestion.id,
    score: subquestion.score,
    maxScore: subquestion.maxScore
  }));
  const audit: DirectVisualReviewAudit = {
    reviewRequired: plan.reviewRequired,
    reviewItems: plan.items,
    results,
    initialScore: initialResult.score,
    initialSubquestionScores,
    durationMs: 0
  };
  const pointMap = new Map(input.rubric.subquestions.flatMap((subquestion) => subquestion.scorePoints.map((point) => [
    subquestion.id + ":" + point.id,
    point
  ] as const)));
  const finalAnswerMap = new Map<string, Rubric["subquestions"][number]>(input.rubric.subquestions.map((subquestion) => [`${subquestion.id}:final`, subquestion]));
  const blockMap = new Map((ocr.layoutBlocks ?? []).map((block) => [block.blockId, block]));
  const actionableIds = new Set(plan.actionableItems.map((item) => item.reviewId));
  for (const item of plan.items.filter((candidate) => !actionableIds.has(candidate.reviewId))) {
    results.push(uncertainResult(item.reviewId, "复核计划无法安全映射或缺少有效 score_effect，保留第一次评分并标记人工复核"));
  }

  const reviewImages: GradingImage[] = [];
  const cropFailedIds = new Set<string>();
  const itemsByBlock = new Map<string, DirectVisualReviewPlanItem[]>();
  for (const item of plan.actionableItems) {
    if (preCroppedImages?.has(item.reviewId)) {
      reviewImages.push(preCroppedImages.get(item.reviewId)!);
      continue;
    }
    const block = blockMap.get(item.blockId);
    if (!block || !isRenderableOcrBlock(block)) continue;
    const items = itemsByBlock.get(item.blockId) ?? [];
    items.push(item);
    itemsByBlock.set(item.blockId, items);
  }
  for (const [blockId, blockItems] of itemsByBlock) {
    const block = blockMap.get(blockId);
    if (!block) continue;
    try {
      const reviewLabel = blockItems.length === 1
        ? blockItems[0]!.reviewId
        : blockItems.map((item) => item.reviewId).join(", ");
      const image = await createDirectBlockReviewImage(input.imageBuffer, ocr, block, reviewLabel);
      if (!image) {
        blockItems.forEach((item) => cropFailedIds.add(item.reviewId));
        continue;
      }
      reviewImages.push(image);
    } catch (error) {
      blockItems.forEach((item) => cropFailedIds.add(item.reviewId));
      reviewReasons.push("复核项 " + blockItems.map((item) => item.reviewId).join("、") + " 无法从预处理答卷生成局部图：" + (error instanceof Error ? error.message : String(error)) + "。");
    }
  }
  const reviewableItems = plan.actionableItems.filter((item) => !cropFailedIds.has(item.reviewId));
  for (const item of plan.actionableItems.filter((candidate) => cropFailedIds.has(candidate.reviewId))) {
    const reason = "局部图生成失败，保留第一次评分并标记人工复核";
    results.push(uncertainResult(item.reviewId, reason));
    reviewReasons.push("复核项 " + item.reviewId + " " + reason + "。");
  }

  if (reviewableItems.length > 0) {
    let blockIndexImage: GradingImage | undefined;
    try {
      blockIndexImage = await createDirectOcrBlockIndexImage(input.imageBuffer, ocr, "[PaddleOCR bbox定位索引图（局部复核）]") ?? undefined;
    } catch (error) {
      reviewReasons.push("局部复核 bbox 定位索引图生成失败，改用局部图和预处理整页图：" + (error instanceof Error ? error.message : String(error)) + "。");
    }
    const reviewImagesWithContext: GradingImage[] = [
      ...reviewImages,
      ...(blockIndexImage ? [blockIndexImage] : []),
      {
        mimeType: input.mimeType?.trim() || "image/png",
        base64: input.imageBuffer.toString("base64"),
        label: "[学生答卷图（预处理后整页坐标上下文）]"
      }
    ];
    let reviewRoute: ReturnType<typeof resolveModelRoute> | undefined;
    try {
      reviewRoute = resolveModelRoute(config, "large_question_visual_review");
    } catch {
      const reason = "未配置独立局部视觉复核模型，保留第一次评分并标记人工复核";
      for (const item of reviewableItems) {
        results.push(uncertainResult(item.reviewId, reason));
        reviewReasons.push("复核项 " + item.reviewId + " " + reason + "。");
      }
      logProgress(operationId, "grading", "direct_visual_review_not_configured", "大题局部复核未配置独立模型，保留初始评分并继续批改", {
        reviewIds: reviewableItems.map((item) => item.reviewId)
      }, "warning");
    }
    if (reviewRoute) {
      logProgress(operationId, "model", "direct_visual_review", "正在一次性复核大题中会影响得分的整页视觉歧义", {
        model: reviewRoute.model,
        routeKey: reviewRoute.routeKey,
        reviewIds: reviewableItems.map((item) => item.reviewId),
        cropImageCount: reviewImages.length,
        imageCount: reviewImagesWithContext.length,
        blockIndexImage: Boolean(blockIndexImage)
      });
      try {
        const response = await callStructured<unknown>(reviewRoute.config, {
          model: reviewRoute.model,
          routeKey: reviewRoute.routeKey,
          system: getBuiltInSystemPrompt(reviewRoute.routeKey),
          prompt: "请根据所附局部放大图、PaddleOCR bbox 定位索引图和预处理后的学生答卷整页图核验指定内容。\n\n"
            + "复核目标（包含首轮初读或参考答案作为候选提示，候选集合顺序不代表倾向，不能限制你的视觉独立判断）：\n"
            + JSON.stringify(reviewableItems.map((item) => ({ review_id: item.reviewId, block_id: item.blockId, target: item.target, candidates: item.candidates }))) + "\n\n"
            + "核验规则：\n"
            + "1. 先通读整页图与定位索引图，再结合局部放大图独立辨识卷面上学生实际写出的字符、数值或公式片段，不要受候选集合先验诱导。\n"
            + "2. 特别防范笔画与符号粘连错觉：例如根号顶部的横线与数字2、3、7顶部圆弧粘连时极易被粗看误认为数字5，请仔细核对笔迹转折、下部平横与起收笔结构。\n"
            + "3. 若卷面上字迹清晰，但学生实际写出的内容与 candidates 中的任何一项都不一致，result 直接原样返回学生实际书写的真实字符串（不要勉强套用候选）；\n"
            + "4. 若卷面真实笔迹确实与 candidates 中的某项一致，result 原样返回该候选字符串；\n"
            + "5. 若字迹严重模糊、重度涂改涂抹或无法可靠辨识，result 返回 uncertain，并将 certainty 返回 uncertain 或 insufficient_visual_evidence。",
          images: reviewImagesWithContext,
          schemaName: "direct_visual_review",
          schema: directVisualReviewJsonSchema,
          validate: (value) => directVisualReviewSchema.parse(value),
          reasoningEffort: reviewRoute.reasoningEffort ?? "low",
          operationId
        });
        throwIfOperationCancelled(operationId);
        const parsed = directVisualReviewSchema.parse(response.data);
        const seen = new Set<string>();
        for (const item of parsed.reviews) {
          if (!reviewableItems.some((target) => target.reviewId === item.review_id) || seen.has(item.review_id)) continue;
          seen.add(item.review_id);
          results.push({ reviewId: item.review_id, result: item.result, certainty: item.certainty, reason: item.reason });
        }
        for (const item of reviewableItems) {
          if (!seen.has(item.reviewId)) {
            const reason = "局部视觉复核模型没有返回该 review_id 的结果";
            results.push(uncertainResult(item.reviewId, reason));
            reviewReasons.push("复核项 " + item.reviewId + " " + reason + "，保留第一次评分并标记人工复核。");
          }
        }
      } catch (error) {
        if (isOperationCancelled(error)) throw error;
        const reason = "局部视觉复核调用失败：" + (error instanceof Error ? error.message : String(error)) + "；保留第一次评分并标记人工复核";
        for (const item of reviewableItems) {
          results.push(uncertainResult(item.reviewId, reason));
          reviewReasons.push("复核项 " + item.reviewId + " " + reason + "。");
        }
        logProgress(operationId, "grading", "direct_visual_review_failed", "大题局部复核失败，保留初始评分并继续批改", {
          reviewIds: reviewableItems.map((item) => item.reviewId),
          error: error instanceof Error ? error.message : String(error)
        }, "warning");
      }
    }
  }

  const resultByReviewId = new Map(results.map((item) => [item.reviewId, item]));
  for (const item of plan.items) {
    const reviewResult = resultByReviewId.get(item.reviewId);
    const point = pointMap.get(item.criterionId);
    const finalAnswer = finalAnswerMap.get(item.criterionId);
    const effectEntry = Object.entries(item.scoreEffect).find(([key]) => normalizeVisualReviewToken(key) === normalizeVisualReviewToken(reviewResult?.result ?? ""));
    let dynamicFinalAnswerScore: number | undefined;
    if (finalAnswer && !effectEntry && reviewResult?.certainty === "clear" && reviewResult.result.trim() && reviewResult.result.trim().toLowerCase() !== "uncertain") {
      const isMissing = isMissingVisualReviewResult(reviewResult.result);
      if (isMissing) {
        dynamicFinalAnswerScore = 0;
      } else {
        const isMatch = answerMatchesAnyFinalAnswer(reviewResult.result, finalAnswer);
        dynamicFinalAnswerScore = isMatch ? finalAnswer.maxScore : 0;
      }
    }
    if (reviewResult?.certainty === "clear" && reviewResult.result.trim().toLowerCase() !== "uncertain" && (point || finalAnswer) && (effectEntry || dynamicFinalAnswerScore !== undefined)) {
      if (finalAnswer) {
        const finalAnswerScore = dynamicFinalAnswerScore !== undefined ? dynamicFinalAnswerScore : effectEntry![1];
        const finalAnswerStatus = isMissingVisualReviewResult(reviewResult.result)
          ? "missing"
          : finalAnswerScore >= finalAnswer.maxScore ? "correct" : "incorrect";
        nextFinalAnswerJudgements = nextFinalAnswerJudgements.map((judgement) => judgement.subquestionId === finalAnswer.id ? {
          ...judgement,
          status: finalAnswerStatus,
          studentAnswer: reviewResult.result,
          reason: finalAnswerReviewReason(judgement, reviewResult),
          confidence: 0.99,
          decisionSource: "visual_local_review" as const
        } : judgement);
        continue;
      }
      if (!point || !effectEntry) continue;
      const score = Math.max(0, Math.min(point.score, effectEntry[1]));
      pointScoreOverrides[item.criterionId] = score;
      nextDecisions = nextDecisions.map((decision) => decision.subquestionId + ":" + decision.pointId === item.criterionId ? {
        ...decision,
        status: score > 0 ? "satisfied" : "not_satisfied",
        reason: decision.reason + "；局部视觉复核确认“" + reviewResult.result + "”",
        requiresReview: false,
        reviewReason: undefined,
        decisionSource: "visual_local_review" as const
      } : decision);
    } else {
      const reason = reviewResult?.reason || "局部视觉复核没有可靠结果";
      reviewReasons.push("复核项 " + item.reviewId + " 未能确认：" + reason + "；保留第一次评分并标记人工复核。");
      if (finalAnswer) {
        nextFinalAnswerJudgements = nextFinalAnswerJudgements.map((judgement) => judgement.subquestionId === finalAnswer.id ? {
          ...judgement,
          status: "uncertain" as const,
          reason: reason,
          confidence: 0,
          decisionSource: "visual_local_review" as const
        } : judgement);
        continue;
      }
      nextDecisions = nextDecisions.map((decision) => decision.subquestionId + ":" + decision.pointId === item.criterionId ? {
        ...decision,
        requiresReview: true,
        reviewReason: reason,
        decisionSource: "visual_local_review" as const
      } : decision);
    }
  }
  audit.results = results;
  audit.durationMs = Math.round(performance.now() - startedAt);
  return { decisions: nextDecisions, finalAnswerJudgements: nextFinalAnswerJudgements, pointScoreOverrides, audit, reviewReasons: [...new Set(reviewReasons)], durationMs: audit.durationMs };
}
