import type { GradingResult } from "./types.js";

/** 与前端置信度颜色约定一致：低于此值的证据需要优先查看。 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export interface ReviewSignalSummary {
  lowConfidenceLines: number;
  lowConfidenceFinalAnswers: number;
  lowConfidenceDecisions: number;
  totalLowConfidence: number;
  reviewReasons: number;
}

export type GradingReliabilityLevel = "reliable" | "caution" | "review";

export interface GradingReliabilityAttentionItem {
  tone: "warning" | "info";
  text: string;
}

export interface GradingReliabilitySummary {
  level: GradingReliabilityLevel;
  headline: string;
  explanation: string;
  finalAnswers: {
    total: number;
    conclusive: number;
    traceable: number;
    missing: number;
    uncertain: number;
    missingEvidence: number;
    bySource: {
      teacherModel: number;
      visualReview: number;
      missingTeacherJudgement: number;
    };
  };
  processAudit: {
    subquestions: number;
    points: number;
    traceablePoints: number;
    missingEvidencePoints: number;
    unauditedNotPresent: number;
    reviewRequired: number;
    syntheticMissing: number;
    excludedByFinalAnswerAuthority: number;
  };
  visualReview: {
    triggered: number;
    resolved: number;
    unresolved: number;
  };
  pointReviewSubquestions: number;
  pendingReviewItems: number;
  lowConfidenceSignals: number;
  directFullCreditSubquestions: number;
  riskSignals: {
    lowConfidence: number;
    conflicts: number;
    missingEvidence: number;
  };
  attentionItems: GradingReliabilityAttentionItem[];
}

function uniqueNonEmpty(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function hasTraceableFinalEvidence(result: GradingResult, subquestion: GradingResult["subquestions"][number]): boolean {
  const uniqueLineIds = [...new Set(subquestion.finalAnswerEvidenceLineIds ?? [])];
  if (uniqueLineIds.length === 0) return false;
  const linesById = new Map(result.evidence.lines.map((line) => [line.id, line]));
  return uniqueLineIds.every((lineId) => {
    const line = linesById.get(lineId);
    if (!line || line.status === "uncertain" || line.confidence < LOW_CONFIDENCE_THRESHOLD) return false;
    if (subquestion.finalAnswerStatus === "missing") {
      return Boolean(line.region && (line.text.trim() || line.latex?.trim()));
    }
    return line.status === "active" && Boolean(line.text.trim() || line.latex?.trim());
  });
}

function hasTraceableDecisionEvidence(result: GradingResult, decision: GradingResult["subquestions"][number]["decisions"][number]): boolean {
  const uniqueLineIds = [...new Set(decision.evidenceLineIds)];
  if (uniqueLineIds.length === 0 || (decision.status !== "not_present" && !decision.evidenceQuote.trim())) return false;
  const linesById = new Map(result.evidence.lines.map((line) => [line.id, line]));
  return uniqueLineIds.every((lineId) => {
    const line = linesById.get(lineId);
    const isStructuredAbsenceAudit = Boolean(
      line
      && decision.status === "not_present"
      && line.status === "uncertain"
      && line.text.trim().startsWith("缺失审验锚点：")
      && line.region
    );
    if (isStructuredAbsenceAudit) return true;
    if (!line || line.status === "uncertain" || line.confidence < LOW_CONFIDENCE_THRESHOLD) return false;
    if (decision.status === "not_present") {
      // A crossed-out line is useful evidence for absence, unlike a missing
      // citation or an uncertain line.
      return Boolean(line.region && (line.text.trim() || line.latex?.trim()));
    }
    return line.status !== "crossed_out" && Boolean(line.text.trim() || line.latex?.trim());
  });
}

/**
 * Produces a conservative, score-neutral audit summary from persisted grading facts.
 * It never upgrades a result's status or invents a numeric confidence score.
 */
export function summarizeGradingReliability(result: GradingResult): GradingReliabilitySummary {
  const reviewSignals = summarizeReviewSignals(result);
  const finalAnswers = result.subquestions;
  const conclusiveFinalAnswers = finalAnswers.filter((subquestion) => (
    subquestion.finalAnswerStatus !== "uncertain"
    && subquestion.finalAnswerDecisionSource !== "missing_teacher_judgement"
  ));
  const traceableFinalAnswers = conclusiveFinalAnswers.filter((subquestion) => (
    hasTraceableFinalEvidence(result, subquestion)
  ));

  const allDecisions = result.subquestions.flatMap((subquestion) => subquestion.decisions);
  const processDecisions = allDecisions.filter((decision) => (
    decision.decisionSource !== "final_answer_authority"
    && decision.decisionSource !== "synthetic_missing"
    && decision.status !== "not_required"
  ));
  const syntheticMissingDecisions = allDecisions.filter((decision) => decision.decisionSource === "synthetic_missing");
  const authorityDecisions = allDecisions.filter((decision) => decision.decisionSource === "final_answer_authority");
  const traceablePointDecisions = processDecisions.filter((decision) => hasTraceableDecisionEvidence(result, decision));
  const missingEvidencePointDecisions = processDecisions.filter((decision) => !hasTraceableDecisionEvidence(result, decision));
  const unauditedNotPresentDecisions = processDecisions.filter((decision) => (
    decision.status === "not_present" && !hasTraceableDecisionEvidence(result, decision)
  ));
  const reviewRequiredPointDecisions = processDecisions.filter((decision) => decision.requiresReview);
  const auditedSubquestionIds = new Set(processDecisions.map((decision) => decision.subquestionId));
  const pendingReviewItems = allDecisions.filter((decision) => decision.requiresReview).length
    + finalAnswers.filter((subquestion) => subquestion.finalAnswerStatus === "uncertain").length
    + unauditedNotPresentDecisions.filter((decision) => !decision.requiresReview).length;

  const reviewAudit = result.directVisualReviewAudit;
  const resolvedReviewIds = new Set((reviewAudit?.results ?? [])
    .filter((review) => review.certainty === "clear")
    .map((review) => review.reviewId));
  const triggeredReviewIds = new Set((reviewAudit?.reviewItems ?? []).map((item) => item.reviewId));
  const resolvedVisualReviews = [...triggeredReviewIds].filter((reviewId) => resolvedReviewIds.has(reviewId)).length;
  const unresolvedVisualReviews = Math.max(0, triggeredReviewIds.size - resolvedVisualReviews);

  const pointReviewSubquestions = result.gradingPipeline === "large_question"
    ? result.subquestions.filter((subquestion) => subquestion.finalAnswerStatus !== "correct" && subquestion.decisions.length > 0).length
    : new Set(allDecisions
      .filter((decision) => decision.decisionSource === "large_question_point_review")
      .map((decision) => decision.subquestionId)).size;
  const directFullCreditSubquestions = result.subquestions.filter((subquestion) => (
    subquestion.finalAnswerStatus === "correct"
    && subquestion.decisions.length > 0
    && subquestion.decisions.every((decision) => (
      decision.decisionSource === "final_answer_authority"
      || decision.scoringDisposition === "not_deducted_by_final_answer"
    ))
  )).length;

  const finalEvidenceGaps = conclusiveFinalAnswers.length - traceableFinalAnswers.length;
  const pointEvidenceGaps = missingEvidencePointDecisions.length;
  const finalAnswerConflictCount = finalAnswers.filter((subquestion) => subquestion.finalAnswerStatus === "uncertain").length;
  const explicitConflictCount = result.reviewReasons.filter((reason) => /冲突|矛盾/.test(reason)).length
    + allDecisions.filter((decision) => /冲突|矛盾/.test(decision.reviewReason ?? "")).length;
  const conflictCount = finalAnswerConflictCount + explicitConflictCount;
  const finalAnswerByTeacherModel = finalAnswers.filter((subquestion) => subquestion.finalAnswerDecisionSource === "teacher_model").length;
  const finalAnswerByVisualReview = finalAnswers.filter((subquestion) => (
    subquestion.finalAnswerDecisionSource === "unreadable_local_review"
    || subquestion.finalAnswerDecisionSource === "local_numeric_review"
    || subquestion.finalAnswerDecisionSource === "visual_local_review"
  )).length;
  const finalAnswerMissingJudgement = finalAnswers.filter((subquestion) => subquestion.finalAnswerDecisionSource === "missing_teacher_judgement").length;
  const finalAnswerMissingEvidence = conclusiveFinalAnswers.filter((subquestion) => (
    !hasTraceableFinalEvidence(result, subquestion)
  )).length;
  const missingOcrBlocks = result.ocrTranscription?.missingBlockIds.length ?? 0;
  const hardReview = result.scoreResolved === false
    || result.status !== "completed"
    || result.reviewReasons.length > 0
    || pendingReviewItems > 0
    || unresolvedVisualReviews > 0;
  const caution = !hardReview && (
    reviewSignals.totalLowConfidence > 0
    || finalEvidenceGaps > 0
    || pointEvidenceGaps > 0
    || missingOcrBlocks > 0
  );
  const level: GradingReliabilityLevel = hardReview ? "review" : caution ? "caution" : "reliable";

  const warningItems = uniqueNonEmpty([
    ...(result.scoreResolved === false
      ? [`当前分数存在可能改变得分的未确定判定，已禁止自动写分。${result.scoreResolutionReasons?.length ? ` ${result.scoreResolutionReasons.join("；")}` : ""}`]
      : []),
    ...result.reviewReasons,
    ...(unresolvedVisualReviews > 0 ? [`${unresolvedVisualReviews} 项局部视觉复核未得到明确结论。`] : []),
    ...(reviewSignals.totalLowConfidence > 0
      ? [`发现 ${reviewSignals.totalLowConfidence} 个低于 ${Math.round(LOW_CONFIDENCE_THRESHOLD * 100)}% 的置信度信号：卷面行 ${reviewSignals.lowConfidenceLines}、最终答案 ${reviewSignals.lowConfidenceFinalAnswers}、评分点 ${reviewSignals.lowConfidenceDecisions}。`]
      : []),
    ...(finalEvidenceGaps + pointEvidenceGaps > 0
      ? [`有 ${finalEvidenceGaps + pointEvidenceGaps} 个明确判分结论缺少可定位的卷面证据。`]
      : []),
    ...(unauditedNotPresentDecisions.length > 0
      ? [`有 ${unauditedNotPresentDecisions.length} 个“未作答”判定没有缺失审验证据，不能视为已确认未作答。`]
      : []),
    ...(syntheticMissingDecisions.length > 0
      ? [`有 ${syntheticMissingDecisions.length} 个评分点由系统补齐缺失判断，未计入过程追溯率。`]
      : []),
    ...(conflictCount > 0
      ? [`发现 ${conflictCount} 个冲突或未决结论，需核对模型判定与卷面。`]
      : []),
    ...(missingOcrBlocks > 0 ? [`仍有 ${missingOcrBlocks} 个 OCR 区块未返回教师核验，未作为评分依据。`] : []),
    ...(result.status === "failed" ? ["本次批改未完成，不能按当前分数直接使用。"] : [])
  ]).map((text) => ({ tone: "warning" as const, text }));
  const infoItems = uniqueNonEmpty([
    ...(directFullCreditSubquestions > 0
      ? [`${directFullCreditSubquestions} 个小问因最终答案确认正确而按规则直接满分，过程评分点未用于扣分。`]
      : []),
    ...(result.imagePreprocessAudit?.fallbackReason
      ? [`答卷图像增强未生效，已使用未增强输入作为回退结果：${result.imagePreprocessAudit.fallbackReason}`]
      : []),
    ...(!result.gradingPipeline ? ["这是历史记录，未保存当前版本的完整批改链路标识。"] : [])
  ]).map((text) => ({ tone: "info" as const, text }));

  const headline = level === "review"
    ? "评分未完全闭环，需要人工复核"
    : level === "caution"
      ? "评分已完成，但仍有注意项"
      : "评分依据完整，当前无待复核项";
  const explanation = level === "review"
    ? "存在未确认结论、复核原因或未闭环审验；应先核对下列注意事项和对应卷面证据。"
    : level === "caution"
      ? "当前分数已由本地计分引擎确定，但部分证据或置信度信号建议人工扫一遍。"
      : "最终答案、计分依据和已触发审验均已形成可追溯结果，可按当前分数使用。";

  return {
    level,
    headline,
    explanation,
    finalAnswers: {
      total: finalAnswers.length,
      conclusive: conclusiveFinalAnswers.length,
      traceable: traceableFinalAnswers.length,
      missing: finalAnswers.filter((subquestion) => subquestion.finalAnswerStatus === "missing").length,
      uncertain: finalAnswerConflictCount,
      missingEvidence: finalAnswerMissingEvidence,
      bySource: {
        teacherModel: finalAnswerByTeacherModel,
        visualReview: finalAnswerByVisualReview,
        missingTeacherJudgement: finalAnswerMissingJudgement
      }
    },
    processAudit: {
      subquestions: auditedSubquestionIds.size,
      points: processDecisions.length,
      traceablePoints: traceablePointDecisions.length,
      missingEvidencePoints: missingEvidencePointDecisions.length,
      unauditedNotPresent: unauditedNotPresentDecisions.length,
      reviewRequired: reviewRequiredPointDecisions.length,
      syntheticMissing: syntheticMissingDecisions.length,
      excludedByFinalAnswerAuthority: authorityDecisions.length
    },
    visualReview: {
      triggered: triggeredReviewIds.size,
      resolved: resolvedVisualReviews,
      unresolved: unresolvedVisualReviews
    },
    pointReviewSubquestions,
    pendingReviewItems,
    lowConfidenceSignals: reviewSignals.totalLowConfidence,
    directFullCreditSubquestions,
    riskSignals: {
      lowConfidence: reviewSignals.totalLowConfidence,
      conflicts: conflictCount,
      missingEvidence: finalEvidenceGaps + pointEvidenceGaps
    },
    attentionItems: [...warningItems, ...infoItems]
  };
}

export function summarizeReviewSignals(result: GradingResult): ReviewSignalSummary {
  const lowConfidenceLines = result.evidence.lines.filter((line) => line.confidence < LOW_CONFIDENCE_THRESHOLD).length;
  const lowConfidenceFinalAnswers = result.subquestions.filter((subquestion) => (
    typeof subquestion.finalAnswerConfidence === "number"
    && subquestion.finalAnswerConfidence < LOW_CONFIDENCE_THRESHOLD
  )).length;
  const lowConfidenceDecisions = result.subquestions
    .flatMap((subquestion) => subquestion.decisions)
    .filter((decision) => (
      decision.decisionSource !== "synthetic_missing"
      && decision.decisionSource !== "final_answer_authority"
      && decision.confidence < LOW_CONFIDENCE_THRESHOLD
    ))
    .length;
  return {
    lowConfidenceLines,
    lowConfidenceFinalAnswers,
    lowConfidenceDecisions,
    totalLowConfidence: lowConfidenceLines + lowConfidenceFinalAnswers + lowConfidenceDecisions,
    reviewReasons: result.reviewReasons.length
  };
}
