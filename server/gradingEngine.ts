import { evaluate, simplify } from "mathjs";
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

export const AUTO_CONFIDENCE_THRESHOLD = 0.85;
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

function evidenceReferenceReason(check: EvidenceReferenceCheck): string {
  const reasons: string[] = [];
  if (check.missingLineIds.length) reasons.push(`引用了不存在的卷面行：${check.missingLineIds.join(", ")}`);
  if (check.crossedOutLineIds.length) reasons.push(`引用了已划掉的卷面行：${check.crossedOutLineIds.join(", ")}`);
  if (check.uncertainLineIds.length) reasons.push(`引用的卷面行存在视觉歧义：${check.uncertainLineIds.join(", ")}`);
  if (check.lowConfidenceLineIds.length) reasons.push(`引用的卷面行识别置信度过低：${check.lowConfidenceLineIds.join(", ")}`);
  if (!check.validLineIds.length) reasons.push("没有可确认的有效卷面证据");
  return reasons.join("；");
}

function canSupportAutomaticDecision(check: EvidenceReferenceCheck, confidence: number): { ok: boolean; reason?: string } {
  if (confidence < AUTO_CONFIDENCE_THRESHOLD) {
    return { ok: false, reason: `置信度 ${Math.round(confidence * 100)}% 低于自动判定阈值 ${Math.round(AUTO_CONFIDENCE_THRESHOLD * 100)}%` };
  }
  if (check.missingLineIds.length || check.crossedOutLineIds.length || check.uncertainLineIds.length || check.lowConfidenceLineIds.length || !check.validLineIds.length) {
    return { ok: false, reason: evidenceReferenceReason(check) };
  }
  return { ok: true };
}

function unsupportedDecisionStatus(check: EvidenceReferenceCheck): "not_present" | "unreadable" {
  return check.validLineIds.length
    || check.missingLineIds.length
    || check.uncertainLineIds.length
    || check.lowConfidenceLineIds.length
    ? "unreadable"
    : "not_present";
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

function readLatexGroup(source: string, start: number): { content: string; end: number } | null {
  if (source[start] !== "{") return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return { content: source.slice(start + 1, index), end: index + 1 };
  }
  return null;
}

function replaceLatexStructures(source: string): string {
  let result = source;
  for (let pass = 0; pass < 20; pass += 1) {
    const fractionMatch = /\\(?:d?frac)\s*\{/.exec(result);
    if (fractionMatch?.index !== undefined) {
      const numeratorStart = fractionMatch.index + fractionMatch[0].lastIndexOf("{");
      const numerator = readLatexGroup(result, numeratorStart);
      if (!numerator) break;
      const denominatorStart = result.indexOf("{", numerator.end);
      const denominator = denominatorStart >= 0 ? readLatexGroup(result, denominatorStart) : null;
      if (!denominator) break;
      const replacement = `((${replaceLatexStructures(numerator.content)})/(${replaceLatexStructures(denominator.content)}))`;
      result = result.slice(0, fractionMatch.index) + replacement + result.slice(denominator.end);
      continue;
    }

    const squareRootMatch = /\\sqrt\s*\{/.exec(result);
    if (squareRootMatch?.index !== undefined) {
      const groupStart = squareRootMatch.index + squareRootMatch[0].lastIndexOf("{");
      const group = readLatexGroup(result, groupStart);
      if (!group) break;
      result = result.slice(0, squareRootMatch.index)
        + `sqrt(${replaceLatexStructures(group.content)})`
        + result.slice(group.end);
      continue;
    }
    break;
  }
  return result;
}

export function normalizeExpression(expression: string): string {
  const withoutTextCommands = expression
    .replace(/```(?:latex|tex)?/gi, "")
    .replace(/\$/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\(?:,|;|!|quad|qquad)/g, "")
    .replace(/\\(?:mathrm|text)\{([^{}]*)\}/g, "$1")
    .replace(/\\cdot|\\times/g, "*")
    .replace(/＝/g, "=")
    .replace(/×|·/g, "*")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3");

  return replaceLatexStructures(withoutTextCommands)
    .replace(/_\{([^{}]+)\}/g, "_$1")
    .replace(/\^\{([^{}]+)\}/g, "^($1)")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, "")
    .replace(/([0-9)])(?=[a-zA-Z(])/g, "$1*")
    .replace(/\)(?=[a-zA-Z0-9(])/g, ")*");
}

function compactMultiplication(expression: string): string {
  return expression.replace(/\*/g, "");
}

function compareScalarExpressions(actual: string, expected: string, tolerance: number): { equivalent: boolean; method: string } {
  if (actual === expected) return { equivalent: true, method: "normalized_exact" };
  if (compactMultiplication(actual) === compactMultiplication(expected)) {
    return { equivalent: true, method: "implicit_multiplication" };
  }
  try {
    const differenceExpression = `(${actual})-(${expected})`;
    if (simplify(differenceExpression).toString() === "0") return { equivalent: true, method: "symbolic_simplification" };
    const evaluatedDelta = Number(evaluate(differenceExpression));
    if (Number.isFinite(evaluatedDelta) && Math.abs(evaluatedDelta) <= Math.max(tolerance, Number.EPSILON * 100)) {
      return { equivalent: true, method: "numeric_tolerance" };
    }
  } catch {
    // Non-math identifiers still receive deterministic normalized comparisons above.
  }
  return { equivalent: false, method: "not_equivalent" };
}

export interface EquivalenceExplanation {
  equivalent: boolean;
  actualNormalized: string;
  expectedNormalized: string;
  method: string;
}

export function explainExpressionEquivalence(actual: string, expected: string, tolerance = 0): EquivalenceExplanation {
  const actualNormalized = normalizeExpression(actual);
  const expectedNormalized = normalizeExpression(expected);
  const actualEquation = actualNormalized.split("=");
  const expectedEquation = expectedNormalized.split("=");

  if (actualEquation.length === 2 && expectedEquation.length === 2) {
    const direct = compareScalarExpressions(actualNormalized, expectedNormalized, tolerance);
    if (direct.equivalent) return { ...direct, actualNormalized, expectedNormalized };
    const values = compareScalarExpressions(actualEquation[1], expectedEquation[1], tolerance);
    if (values.equivalent) return { ...values, method: `equation_rhs_${values.method}`, actualNormalized, expectedNormalized };
    try {
      const actualResidual = simplify(`(${actualEquation[0]})-(${actualEquation[1]})`).toString();
      const expectedResidual = simplify(`(${expectedEquation[0]})-(${expectedEquation[1]})`).toString();
      if (simplify(`(${actualResidual})-(${expectedResidual})`).toString() === "0"
        || simplify(`(${actualResidual})+(${expectedResidual})`).toString() === "0") {
        return { equivalent: true, method: "equation_residual", actualNormalized, expectedNormalized };
      }
    } catch {
      // Fall through to a deterministic non-match.
    }
  } else if (actualEquation.length === 2 || expectedEquation.length === 2) {
    const equation = actualEquation.length === 2 ? actualEquation : expectedEquation;
    const scalar = actualEquation.length === 2 ? expectedNormalized : actualNormalized;
    const values = compareScalarExpressions(equation[1], scalar, tolerance);
    if (values.equivalent) return { ...values, method: `equation_value_${values.method}`, actualNormalized, expectedNormalized };
  } else {
    const scalar = compareScalarExpressions(actualNormalized, expectedNormalized, tolerance);
    if (scalar.equivalent) return { ...scalar, actualNormalized, expectedNormalized };
  }

  return { equivalent: false, actualNormalized, expectedNormalized, method: "not_equivalent" };
}

export function expressionsEquivalent(actual: string, expected: string, tolerance = 0): boolean {
  return explainExpressionEquivalence(actual, expected, tolerance).equivalent;
}

export function splitAnswerExpressions(expression: string): string[] {
  const latexSegments = [...expression.matchAll(/\$([^$]+)\$/g)].map((match) => match[1].trim()).filter(Boolean);
  if (latexSegments.length > 1) return latexSegments;

  const equationCount = (expression.match(/=/g) ?? []).length;
  if (equationCount > 1) {
    return expression
      .split(/\s*(?:[,，;；]|\s+\/\s+)\s*/)
      .map((part) => part.replace(/^\$|\$$/g, "").trim())
      .filter(Boolean);
  }
  return [expression.replace(/^\$|\$$/g, "").trim()].filter(Boolean);
}

export function answerCollectionsEquivalent(actual: string, expected: string, tolerance = 0): {
  equivalent: boolean;
  actualParts: string[];
  expectedParts: string[];
  comparisons: EquivalenceExplanation[];
} {
  const actualParts = splitAnswerExpressions(actual);
  const expectedParts = splitAnswerExpressions(expected);
  const usedActual = new Set<number>();
  const comparisons: EquivalenceExplanation[] = [];

  for (const expectedPart of expectedParts) {
    let matchIndex = -1;
    let bestComparison: EquivalenceExplanation | null = null;
    for (let index = 0; index < actualParts.length; index += 1) {
      if (usedActual.has(index)) continue;
      const comparison = explainExpressionEquivalence(actualParts[index], expectedPart, tolerance);
      if (!bestComparison) bestComparison = comparison;
      if (comparison.equivalent) {
        matchIndex = index;
        bestComparison = comparison;
        break;
      }
    }
    if (bestComparison) comparisons.push(bestComparison);
    if (matchIndex < 0) return { equivalent: false, actualParts, expectedParts, comparisons };
    usedActual.add(matchIndex);
  }

  return {
    equivalent: expectedParts.length > 0 && expectedParts.length === actualParts.length,
    actualParts,
    expectedParts,
    comparisons
  };
}

export const GRADING_ENGINE_VERSION = "2.4.0";
export const TEACHER_JUDGEMENT_VERSION = "final-answer-v4";
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
    const finalAnswerDecisionSource = modelJudgement ? "teacher_model" as const : "missing_teacher_judgement" as const;
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
    if (!modelJudgement) {
      reviewReasons.add(`${subquestion.title}缺少教师模型最终答案判定，需要人工复核。`);
    } else if (input.evidenceValidationMode === "direct_visual"
      && (finalAnswerStatus === "correct" || finalAnswerStatus === "incorrect")
      && directVisualEvidenceLineIds(input.evidence, finalAnswerJudgement.evidenceLineIds).length === 0) {
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
        decision = { ...modelDecision, decisionSource: "model" };
        if (decision.status === "insufficient_evidence") {
          decision = {
            ...decision,
            status: "unreadable",
            requiresReview: true,
            reviewReason: decision.reviewReason || "卷面内容无法可靠辨认",
            decisionSource: "normalized_uncertain"
          };
        }
        if (decision.status === "not_present" && decision.confidence < AUTO_CONFIDENCE_THRESHOLD) {
          decision = {
            ...decision,
            status: "unreadable",
            reason: `${decision.reason}；未作答判断置信度 ${Math.round(decision.confidence * 100)}% 低于自动判定阈值 ${Math.round(AUTO_CONFIDENCE_THRESHOLD * 100)}%，当前按无法确认处理。`,
            requiresReview: true,
            reviewReason: decision.reviewReason || "未作答判断置信度不足",
            decisionSource: "normalized_uncertain"
          };
        }
        if (decision.status === "satisfied" || decision.status === "not_satisfied") {
          if (input.evidenceValidationMode === "direct_visual") {
            const directEvidenceIds = directVisualEvidenceLineIds(input.evidence, decision.evidenceLineIds);
            if (directEvidenceIds.length === 0) {
              decision = {
                ...decision,
                status: "unreadable",
                reason: `${decision.reason}；教师模型未返回可定位的有效图像证据，当前按无法确认处理。`,
                requiresReview: true,
                reviewReason: decision.reviewReason || "缺少可定位的图像证据",
                decisionSource: "normalized_uncertain"
              };
            }
          } else {
            const evidenceCheck = inspectEvidenceLineIds(input.evidence, decision.evidenceLineIds);
            const automaticDecision = canSupportAutomaticDecision(evidenceCheck, decision.confidence);
            if (!automaticDecision.ok) {
              const normalizedStatus = unsupportedDecisionStatus(evidenceCheck);
              decision = {
                ...decision,
                status: normalizedStatus,
                reason: `${decision.reason}；${automaticDecision.reason}`,
                requiresReview: normalizedStatus === "unreadable",
                reviewReason: normalizedStatus === "unreadable" ? automaticDecision.reason : undefined,
                decisionSource: "normalized_uncertain"
              };
            }
          }
        }
      }
      const isUnreadable = decision.status === "unreadable" || decision.status === "insufficient_evidence";
      // Unreadable points are review candidates. The whole-paper score threshold
      // is applied after every subquestion has been scored.
      const requiresReview = isUnreadable ? false : decision.requiresReview;
      const scoringDisposition = grantsFullCredit
        ? "not_deducted_by_final_answer" as const
        : decision.status === "satisfied"
          ? "awarded" as const
          : "not_awarded" as const;
      if (requiresReview) reviewReasons.add(decision.reviewReason || `${point.title}需要复核`);
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
        const evidenceCheck = inspectEvidenceLineIds(input.evidence, deduction.evidenceLineIds);
        const directEvidenceIds = directVisualEvidenceLineIds(input.evidence, deduction.evidenceLineIds);
        const automaticDeduction = input.evidenceValidationMode === "direct_visual"
          ? { ok: directEvidenceIds.length > 0, reason: "教师模型未返回可定位的有效图像证据" }
          : canSupportAutomaticDecision(evidenceCheck, deduction.confidence);
        if (!automaticDeduction.ok) {
          reviewReasons.add(`${subquestion.title}的扣分规则 ${deduction.ruleId} 证据不足：${automaticDeduction.reason}`);
          return items;
        }
        if (!rule || items.some((item) => {
          const priorRule = subquestion.deductions.find((candidate) => candidate.id === item.ruleId);
          return priorRule?.exclusiveGroup === rule.exclusiveGroup;
        })) return items;
        items.push({ ...deduction, evidenceLineIds: input.evidenceValidationMode === "direct_visual" ? directEvidenceIds : evidenceCheck.validLineIds, deductedScore: rule.deduct });
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
      finalAnswerEvidenceLineIds: finalEvidenceCheck.validLineIds,
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
      return directVisualEvidenceLineIds(input.evidence, item.evidenceLineIds).length > 0;
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
        ? directVisualEvidenceLineIds(input.evidence, item.evidenceLineIds).length > 0
        : evidenceCheck.validLineIds.length > 0
          && evidenceCheck.missingLineIds.length === 0
          && evidenceCheck.crossedOutLineIds.length === 0
          && evidenceCheck.uncertainLineIds.length === 0
          && evidenceCheck.lowConfidenceLineIds.length === 0);
    return item.decisionSource === "model"
      && !item.requiresReview
      && item.status !== "unreadable"
      && item.status !== "insufficient_evidence"
      && item.confidence >= AUTO_CONFIDENCE_THRESHOLD
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
