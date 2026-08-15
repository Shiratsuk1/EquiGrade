import { DEFAULT_UNREADABLE_REVIEW_THRESHOLD } from "../shared/types.js";
import type {
  AnswerEvidence,
  AppliedDeduction,
  FinalAnswerJudgement,
  GradingMode,
  GradingResult,
  Rubric,
  RubricDecision,
  TeacherCommentary
} from "../shared/types.js";
import { logEvent } from "./systemLog.js";

export const REVIEW_CONFIDENCE_THRESHOLD = 0.6;

interface EvidenceReferenceCheck {
  validLineIds: string[];
  missingLineIds: string[];
  crossedOutLineIds: string[];
  uncertainLineIds: string[];
  lowConfidenceLineIds: string[];
}

function inspectEvidenceLineIds(evidence: AnswerEvidence, lineIds: string[]): EvidenceReferenceCheck {
  const linesById = new Map(evidence.lines.map((line) => [line.id, line]));
  const validLineIds: string[] = [];
  const missingLineIds: string[] = [];
  const crossedOutLineIds: string[] = [];
  const uncertainLineIds: string[] = [];
  const lowConfidenceLineIds: string[] = [];

  for (const lineId of [...new Set(lineIds)]) {
    const line = linesById.get(lineId);
    if (!line) {
      missingLineIds.push(lineId);
    } else if (line.status === "crossed_out") {
      crossedOutLineIds.push(lineId);
    } else if (line.status === "uncertain") {
      uncertainLineIds.push(lineId);
    } else if (!(line.text?.trim() || line.latex?.trim())) {
      uncertainLineIds.push(lineId);
    } else if (line.confidence < REVIEW_CONFIDENCE_THRESHOLD) {
      lowConfidenceLineIds.push(lineId);
    } else {
      validLineIds.push(lineId);
    }
  }

  return { validLineIds, missingLineIds, crossedOutLineIds, uncertainLineIds, lowConfidenceLineIds };
}

function directVisualEvidenceLineIds(evidence: AnswerEvidence, lineIds: string[]): string[] {
  const linesById = new Map(evidence.lines.map((line) => [line.id, line]));
  return [...new Set(lineIds)].filter((lineId) => {
    const line = linesById.get(lineId);
    return Boolean(line && line.status === "active" && (line.text.trim() || line.latex?.trim()));
  });
}

function localReviewEvidenceLineIds(evidence: AnswerEvidence, lineIds: string[]): string[] {
  const linesById = new Map(evidence.lines.map((line) => [line.id, line]));
  return [...new Set(lineIds)].filter((lineId) => {
    const line = linesById.get(lineId);
    return Boolean(line && line.status !== "crossed_out" && line.region);
  });
}

export function normalizeEvidenceReferences(input: AnswerEvidence): AnswerEvidence {
  const seenLineIds = new Set<string>();
  const ambiguities = [...input.ambiguities];
  const lines = input.lines.filter((line) => {
    if (seenLineIds.has(line.id)) {
      ambiguities.push({ lineId: line.id, reason: "卷面转录返回了重复的行ID，已保留第一条", scoreImpact: "certain" });
      return false;
    }
    seenLineIds.add(line.id);
    return true;
  });
  const linesById = new Map(lines.map((line) => [line.id, line]));
  const finalAnswers = input.finalAnswers.filter((answer) => {
    const line = linesById.get(answer.lineId);
    if (!line) {
      ambiguities.push({ lineId: answer.lineId, reason: `最终答案引用了不存在的卷面行 ${answer.lineId}`, scoreImpact: "certain" });
      return false;
    }
    if (line.status === "crossed_out") {
      ambiguities.push({ lineId: answer.lineId, reason: "最终答案引用了已划掉的卷面行，已从有效候选中排除", scoreImpact: "certain" });
      return false;
    }
    return true;
  });
  return { ...input, lines, finalAnswers, ambiguities };
}

export const GRADING_ENGINE_VERSION = "2.5.1";
export const TEACHER_JUDGEMENT_VERSION = "model-authority-v1";
export const TEACHER_COMMENTARY_VERSION = "teacher-commentary-v3";

export function createFallbackTeacherCommentary(result: GradingResult): TeacherCommentary {
  const lostPoints = result.subquestions.flatMap((subquestion) => subquestion.decisions
    .filter((decision) => decision.awardedScore < decision.maxScore && (decision.status === "not_satisfied" || decision.status === "not_present"))
    .map((decision) => ({
      subquestionId: subquestion.id,
      pointId: decision.pointId,
      scoreLost: decision.maxScore - decision.awardedScore,
      reason: decision.reason,
      evidenceLineIds: decision.evidenceLineIds
    })));
  const auditConcerns = result.subquestions.flatMap((subquestion) => subquestion.decisions
    .filter((decision) => ["not_satisfied", "not_present", "unreadable", "insufficient_evidence"].includes(decision.status))
    .map((decision) => ({
      subquestionId: subquestion.id,
      pointId: decision.pointId,
      kind: decision.status === "unreadable" || decision.status === "insufficient_evidence" ? "uncertain_evidence" as const : "confirmed_issue" as const,
      reason: decision.reason,
      evidenceLineIds: decision.evidenceLineIds
    })));
  const strengths = result.subquestions.flatMap((subquestion) => subquestion.decisions
    .filter((decision) => decision.status === "satisfied")
    .map((decision) => `${subquestion.title}：${decision.pointId}已满足评分要求`));
  const reviewItems = result.reviewReasons;
  const overallComment = result.score === result.maxScore
      ? "本次作答最终得分为满分。过程审验已执行，存在的证据不足或过程问题仅作为人工复核提示，不影响最终得分。"
      : result.reviewReasons.length
        ? `本次作答当前确定得分为 ${result.score}/${result.maxScore} 分。待复核项目当前不计分，复核状态不形成分数区间。`
        : `本次作答得分${result.score}/${result.maxScore}分。主要失分来自错误、未作答或没有有效卷面证据的评分点。`;
  return {
    overallComment,
    strengths: [...new Set(strengths)].slice(0, 8),
    lostPoints,
    auditConcerns,
    reviewItems,
    basedOnDecisionIds: result.subquestions.flatMap((subquestion) => subquestion.decisions.map((decision) => `${subquestion.id}:${decision.pointId}`)),
    status: "fallback",
    version: TEACHER_COMMENTARY_VERSION
  };
}

export function calculateGrade(input: {
  id: string;
  studentId: string;
  fileName: string;
  rubric: Rubric;
  evidence: AnswerEvidence;
  finalAnswerJudgements: FinalAnswerJudgement[];
  decisions: RubricDecision[];
  appliedDeductions?: AppliedDeduction[];
  modelName: string;
  durationMs: number;
  operationId?: string;
  previousResultId?: string;
  regradedAt?: string;
  regradeReason?: string;
  teacherJudgementVersion?: string;
  unreadableReviewThreshold?: number;
  evidenceValidationMode?: "extracted_text" | "direct_visual";
  gradingMode?: GradingMode;
}): GradingResult {
  const reviewReasons = new Set<string>();
  const deductions = input.appliedDeductions ?? [];
  const configuredThreshold = Number(input.unreadableReviewThreshold);
  const unreadableScoreThreshold = Number.isFinite(configuredThreshold) && configuredThreshold >= 0.5
    ? configuredThreshold
    : DEFAULT_UNREADABLE_REVIEW_THRESHOLD;

  const subquestions = input.rubric.subquestions.map((subquestion) => {
    const finalEvidenceItems = input.evidence.finalAnswers.filter((item) => item.subquestionId === subquestion.id);
    const modelJudgement = input.finalAnswerJudgements.find((item) => item.subquestionId === subquestion.id);
    const finalAnswerDecisionSource = modelJudgement?.decisionSource === "unreadable_local_review"
      ? "unreadable_local_review" as const
      : modelJudgement?.decisionSource === "local_numeric_review"
        ? "local_numeric_review" as const
        : modelJudgement ? "teacher_model" as const : "missing_teacher_judgement" as const;
    const finalAnswerJudgement: FinalAnswerJudgement = modelJudgement ?? {
      subquestionId: subquestion.id,
      status: "uncertain",
      evidenceLineIds: [],
      studentAnswer: finalEvidenceItems.map((item) => item.expression).join("；"),
      referenceAnswer: subquestion.finalAnswers.map((item) => item.expression).join(" / "),
      reason: "教师模型未返回该小问的最终答案判定，不能自动发布结果。",
      confidence: 0
    };
    const finalAnswerStatus = finalAnswerJudgement.status;
    const finalEvidenceCheck = inspectEvidenceLineIds(input.evidence, finalAnswerJudgement.evidenceLineIds);
    const finalAnswerEvidenceLineIds = finalAnswerDecisionSource === "unreadable_local_review" || finalAnswerDecisionSource === "local_numeric_review"
      ? localReviewEvidenceLineIds(input.evidence, finalAnswerJudgement.evidenceLineIds)
      : finalEvidenceCheck.validLineIds;
    if (!modelJudgement) {
      reviewReasons.add(`${subquestion.title}缺少教师模型最终答案判定，需要人工复核。`);
    } else if (finalAnswerStatus === "uncertain") {
      reviewReasons.add(finalAnswerDecisionSource === "local_numeric_review"
        ? `${subquestion.title}最终答案的教师读取与局部审验结果冲突或无法确认，需要人工复核。`
        : `${subquestion.title}最终答案经视觉复查后仍无法可靠确认，需要人工复核。`);
    } else if (input.evidenceValidationMode === "direct_visual"
      && (finalAnswerStatus === "correct" || finalAnswerStatus === "incorrect")
      && (finalAnswerDecisionSource === "unreadable_local_review" || finalAnswerDecisionSource === "local_numeric_review"
        ? localReviewEvidenceLineIds(input.evidence, finalAnswerJudgement.evidenceLineIds)
        : directVisualEvidenceLineIds(input.evidence, finalAnswerJudgement.evidenceLineIds)).length === 0) {
      reviewReasons.add(`${subquestion.title}的教师模型最终答案判定缺少可定位的图像证据，需要人工复核。`);
    }

    // The teacher model is the sole authority for final-answer correctness.
    // Process work is still audited, but cannot reduce a correct final answer.
    const grantsFullCredit = finalAnswerStatus === "correct";
    if (input.operationId) {
      logEvent(input.operationId, "grading", "final_answer_authority_decision", `${subquestion.title}：教师模型判定最终答案为${finalAnswerStatus}`, {
        subquestionId: subquestion.id,
        teacherStatus: finalAnswerStatus,
        teacherReason: finalAnswerJudgement.reason,
        teacherConfidence: finalAnswerJudgement.confidence,
        teacherEvidenceLineIds: finalAnswerJudgement.evidenceLineIds,
        decisionSource: finalAnswerDecisionSource,
        grantsFullCredit,
        finalAnswerPolicy: subquestion.finalAnswerPolicy
      }, !modelJudgement || finalAnswerStatus === "uncertain" ? "warning" : finalAnswerStatus === "correct" ? "success" : "info");
    }

    const pointDecisions = subquestion.scorePoints.map((point) => {
      const modelDecision = input.decisions.find(
        (item) => item.subquestionId === subquestion.id && item.pointId === point.id
      );
      let decision: RubricDecision;
      if (!modelDecision) {
        decision = {
          subquestionId: subquestion.id,
          pointId: point.id,
          status: "not_present" as const,
          evidenceLineIds: [],
          evidenceQuote: "",
          reason: "模型未返回该评分点的判断，当前按未提供可确认的评分证据计0分。",
          confidence: 0,
          requiresReview: true,
          reviewReason: "评分点缺少判断结果",
          decisionSource: "synthetic_missing"
        };
      } else {
        decision = { ...modelDecision, decisionSource: modelDecision.decisionSource ?? "model" };
        if (decision.status === "insufficient_evidence") {
          decision = {
            ...decision,
            status: "unreadable",
            requiresReview: true,
            reviewReason: decision.reviewReason || "卷面内容无法可靠辨认",
            decisionSource: "normalized_uncertain"
          };
        }
      }
      const isUnreadable = decision.status === "unreadable" || decision.status === "insufficient_evidence";
      const isMissingModelDecision = decision.decisionSource === "synthetic_missing";
      // Unreadable points are candidates until the whole-paper affected score is
      // known. A clear model status cannot independently force human review.
      const requiresReview = isMissingModelDecision;
      if (!isUnreadable && !isMissingModelDecision && (decision.requiresReview || decision.reviewReason)) {
        decision = { ...decision, requiresReview: false, reviewReason: undefined };
      }
      const scoringDisposition = grantsFullCredit
        ? "not_deducted_by_final_answer" as const
        : decision.status === "satisfied"
          ? "awarded" as const
          : "not_awarded" as const;
      if (isMissingModelDecision) reviewReasons.add(decision.reviewReason || `${point.title}缺少评分判断，需要人工复核`);
      return {
        ...decision,
        requiresReview,
        scoringDisposition,
        maxScore: point.score,
        awardedScore: grantsFullCredit || decision.status === "satisfied" ? point.score : 0,
        uncertainScore: 0
      };
    });

    if (input.operationId) {
      pointDecisions.forEach((decision) => {
        const point = subquestion.scorePoints.find((candidate) => candidate.id === decision.pointId);
        logEvent(
          input.operationId!,
          "scoring",
          "score_point_audit",
          `${subquestion.title} / ${point?.title ?? decision.pointId}：${decision.awardedScore}/${decision.maxScore}分`,
          {
            subquestionId: subquestion.id,
            subquestionTitle: subquestion.title,
            pointId: decision.pointId,
            pointTitle: point?.title,
            status: decision.status,
            awardedScore: decision.awardedScore,
            maxScore: decision.maxScore,
            reason: decision.reason,
            evidenceLineIds: decision.evidenceLineIds,
            evidenceQuote: decision.evidenceQuote,
            confidence: decision.confidence,
            requiresReview: decision.requiresReview,
            reviewReason: decision.reviewReason,
            decisionSource: decision.decisionSource,
            scoringDisposition: decision.scoringDisposition
          },
          decision.requiresReview || decision.status === "unreadable" ? "warning" : decision.awardedScore > 0 ? "success" : "info"
        );
      });
    }

    const uniqueDeductions = deductions
      .filter((item) => item.subquestionId === subquestion.id)
      .reduce<Array<AppliedDeduction & { deductedScore: number }>>((items, deduction) => {
        const rule = subquestion.deductions.find((candidate) => candidate.id === deduction.ruleId);
        if (!rule || items.some((item) => {
          const priorRule = subquestion.deductions.find((candidate) => candidate.id === item.ruleId);
          return priorRule?.exclusiveGroup === rule.exclusiveGroup;
        })) return items;
        items.push({ ...deduction, deductedScore: rule.deduct });
        return items;
      }, []);
    const processScore = pointDecisions.reduce((sum, item) => sum + item.awardedScore, 0);
    const uncertainScore = 0;
    const scoreBeforeDeduction = grantsFullCredit
      ? subquestion.maxScore
      : processScore;
    let remainingDeductionBudget = Math.max(0, scoreBeforeDeduction);
    const auditDeductions = uniqueDeductions.map((deduction) => {
      const deductedScore = grantsFullCredit
        ? 0
        : Math.min(deduction.deductedScore, remainingDeductionBudget);
      remainingDeductionBudget -= deductedScore;
      return {
        ...deduction,
        deductedScore,
        scoringDisposition: grantsFullCredit
          ? "not_deducted_by_final_answer" as const
          : deductedScore > 0
            ? "awarded" as const
            : "not_deducted_by_score_floor" as const
      };
    });
    const subDeductions = grantsFullCredit
      ? []
      : auditDeductions.filter((deduction) => deduction.deductedScore > 0);
    const deductionTotal = subDeductions.reduce((sum, item) => sum + item.deductedScore, 0);
    const score = Math.max(0, Math.min(subquestion.maxScore, scoreBeforeDeduction - deductionTotal));
    const maximumPossibleScore = score;
    if (input.operationId) {
      logEvent(input.operationId, "scoring", "subquestion_score", `${subquestion.title}：${score}/${subquestion.maxScore}分`, {
        subquestionId: subquestion.id,
        finalAnswerStatus,
        teacherReason: finalAnswerJudgement.reason,
        teacherConfidence: finalAnswerJudgement.confidence,
        decisionSource: finalAnswerDecisionSource,
        grantsFullCredit,
        processScore,
        uncertainScore,
        maximumPossibleScore,
        appliedDeduction: deductionTotal,
        processPointsOverridden: grantsFullCredit,
        processAuditExecuted: true,
        notPresentPoints: pointDecisions.filter((item) => item.status === "not_present").length,
        unreadablePoints: pointDecisions.filter((item) => item.status === "unreadable" || item.status === "insufficient_evidence").length
      }, "success");
    }

    return {
      id: subquestion.id,
      title: subquestion.title,
      score,
      maxScore: subquestion.maxScore,
      maximumPossibleScore,
      uncertainScore,
      finalAnswerStatus,
      finalAnswerReason: finalAnswerJudgement.reason,
      finalAnswerConfidence: finalAnswerJudgement.confidence,
      finalAnswerDecisionSource,
      finalAnswerEvidenceLineIds,
      studentFinalAnswer: finalAnswerJudgement.studentAnswer,
      referenceFinalAnswer: finalAnswerJudgement.referenceAnswer,
      processAuditSummary: {
        totalPoints: pointDecisions.length,
        satisfied: pointDecisions.filter((item) => item.status === "satisfied").length,
        notSatisfied: pointDecisions.filter((item) => item.status === "not_satisfied").length,
        uncertain: pointDecisions.filter((item) => item.status === "unreadable" || item.status === "insufficient_evidence").length,
        notPresent: pointDecisions.filter((item) => item.status === "not_present").length,
        unreadable: pointDecisions.filter((item) => item.status === "unreadable" || item.status === "insufficient_evidence").length,
        reviewRequired: pointDecisions.filter((item) => item.requiresReview).length
      },
      decisions: pointDecisions,
      deductions: subDeductions,
      auditDeductions
    };
  });

  const unreadableAffectedDecisions = subquestions.flatMap((subquestion) => subquestion.decisions
    .filter((decision) => (
      decision.status === "unreadable" || decision.status === "insufficient_evidence"
    ) && decision.awardedScore < decision.maxScore)
    .map((decision) => ({ subquestionId: subquestion.id, decision })));
  const unreadableAffectedScore = Math.round(unreadableAffectedDecisions.reduce(
    (sum, item) => sum + (item.decision.maxScore - item.decision.awardedScore),
    0
  ) * 1000) / 1000;
  const unreadableReviewTriggered = unreadableAffectedScore > 0
    && unreadableAffectedScore >= unreadableScoreThreshold;

  if (unreadableReviewTriggered) {
    const pointIds = unreadableAffectedDecisions.map((item) => `${item.subquestionId}:${item.decision.pointId}`);
    reviewReasons.add(`卷面无法辨认导致 ${unreadableAffectedScore} 分未计入，达到教师设置的 ${unreadableScoreThreshold} 分人工复核阈值（评分点：${pointIds.join("、")}）。`);
    for (const item of unreadableAffectedDecisions) item.decision.requiresReview = true;
  }
  for (const subquestion of subquestions) {
    if (subquestion.processAuditSummary) {
      subquestion.processAuditSummary.reviewRequired = subquestion.decisions.filter((item) => item.requiresReview).length;
    }
  }
  if (input.operationId) {
    logEvent(input.operationId, "scoring", "unreadable_review_threshold", unreadableReviewTriggered
      ? `无法辨认影响 ${unreadableAffectedScore} 分，已达到 ${unreadableScoreThreshold} 分人工复核阈值`
      : `无法辨认影响 ${unreadableAffectedScore} 分，未达到 ${unreadableScoreThreshold} 分人工复核阈值`, {
      unreadableAffectedScore,
      unreadableScoreThreshold,
      unreadableReviewTriggered,
      affectedPointIds: unreadableAffectedDecisions.map((item) => `${item.subquestionId}:${item.decision.pointId}`)
    }, unreadableReviewTriggered ? "warning" : "success");
  }

  const allDecisions = subquestions.flatMap((item) => item.decisions);
  const expectedDecisionCount = input.rubric.subquestions.reduce((sum, item) => sum + item.scorePoints.length, 0);
  const executedDecisions = allDecisions.filter((item) => item.decisionSource !== "synthetic_missing");
  const traceable = executedDecisions.filter((item) => {
    if (input.evidenceValidationMode === "direct_visual") {
      return (item.decisionSource === "unreadable_local_review"
        ? localReviewEvidenceLineIds(input.evidence, item.evidenceLineIds)
        : directVisualEvidenceLineIds(input.evidence, item.evidenceLineIds)).length > 0;
    }
    const evidenceCheck = inspectEvidenceLineIds(input.evidence, item.evidenceLineIds);
    return evidenceCheck.validLineIds.length > 0
      && evidenceCheck.missingLineIds.length === 0
      && evidenceCheck.crossedOutLineIds.length === 0
      && evidenceCheck.uncertainLineIds.length === 0
      && evidenceCheck.lowConfidenceLineIds.length === 0;
  }).length;
  const automatic = executedDecisions.filter((item) => {
    const evidenceCheck = inspectEvidenceLineIds(input.evidence, item.evidenceLineIds);
    const evidenceSupportsStatus = item.status === "not_present"
      || (input.evidenceValidationMode === "direct_visual"
        ? (item.decisionSource === "unreadable_local_review"
          ? localReviewEvidenceLineIds(input.evidence, item.evidenceLineIds)
          : directVisualEvidenceLineIds(input.evidence, item.evidenceLineIds)).length > 0
        : evidenceCheck.validLineIds.length > 0
          && evidenceCheck.missingLineIds.length === 0
          && evidenceCheck.crossedOutLineIds.length === 0
          && evidenceCheck.uncertainLineIds.length === 0
          && evidenceCheck.lowConfidenceLineIds.length === 0);
    return (item.decisionSource === "model" || item.decisionSource === "unreadable_local_review")
      && !item.requiresReview
      && item.status !== "unreadable"
      && item.status !== "insufficient_evidence"
      && evidenceSupportsStatus;
  }).length;
  const ambiguousLineIds = new Set([
    ...input.evidence.lines.filter((line) => line.status === "uncertain").map((line) => line.id),
    ...input.evidence.ambiguities
      .filter((item) => item.scoreImpact !== "none" && item.lineId && input.evidence.lines.some((line) => line.id === item.lineId))
      .map((item) => item.lineId as string)
  ]);
  const score = subquestions.reduce((sum, item) => sum + item.score, 0);
  const maximumPossibleScore = score;

  return {
    id: input.id,
    studentId: input.studentId,
    fileName: input.fileName,
    score,
    maxScore: input.rubric.totalScore,
    maximumPossibleScore,
    status: reviewReasons.size > 0 ? "needs_review" : "completed",
    reviewReasons: [...reviewReasons],
    evidence: input.evidence,
    subquestions,
    metrics: {
      ruleCoverage: expectedDecisionCount ? executedDecisions.length / expectedDecisionCount : 1,
      evidenceTraceability: expectedDecisionCount ? traceable / expectedDecisionCount : 1,
      autoDecisionRate: expectedDecisionCount ? automatic / expectedDecisionCount : 1,
      ambiguityRate: input.evidence.lines.length ? ambiguousLineIds.size / input.evidence.lines.length : 0,
      durationMs: input.durationMs
    },
    modelName: input.modelName,
    gradingMode: input.gradingMode,
    rubricVersion: input.rubric.version,
    gradingEngineVersion: GRADING_ENGINE_VERSION,
    teacherJudgementVersion: input.teacherJudgementVersion ?? TEACHER_JUDGEMENT_VERSION,
    reviewPolicy: {
      unreadableScoreThreshold,
      unreadableAffectedScore,
      unreadableReviewTriggered
    },
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason
  };
}
