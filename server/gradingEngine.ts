import { evaluate, simplify } from "mathjs";
import type {
  AnswerEvidence,
  AppliedDeduction,
  FinalAnswerJudgement,
  GradingResult,
  LocalFinalAnswerAudit,
  Rubric,
  RubricDecision,
  TeacherCommentary
} from "../shared/types.js";
import { logEvent } from "./systemLog.js";

const unitAliases: Record<string, string> = {
  "米/秒": "m/s",
  "米每秒": "m/s",
  "米/秒²": "m/s^2",
  "米每二次方秒": "m/s^2",
  "牛": "N",
  "牛顿": "N",
  "焦": "J",
  "焦耳": "J"
};

function normalizeUnit(unit?: string): string {
  if (!unit) return "";
  const compact = unit.replace(/\s+/g, "").replace(/²/g, "^2");
  return unitAliases[compact] ?? compact;
}

function hasSymbolicValue(expression: string): boolean {
  const normalized = normalizeExpression(expression);
  const value = normalized.includes("=") ? normalized.split("=").slice(1).join("=") : normalized;
  return /[a-zA-Z]/.test(value.replace(/sqrt|sin|cos|tan|log|exp/g, ""));
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

export const GRADING_ENGINE_VERSION = "2.1.0";
export const TEACHER_JUDGEMENT_VERSION = "final-answer-v1";
export const TEACHER_COMMENTARY_VERSION = "teacher-commentary-v1";

export function createFallbackTeacherCommentary(result: GradingResult): TeacherCommentary {
  const lostPoints = result.subquestions.flatMap((subquestion) => subquestion.decisions
    .filter((decision) => decision.awardedScore < decision.maxScore && decision.status === "not_satisfied")
    .map((decision) => ({
      subquestionId: subquestion.id,
      pointId: decision.pointId,
      scoreLost: decision.maxScore - decision.awardedScore,
      reason: decision.reason,
      evidenceLineIds: decision.evidenceLineIds
    })));
  const auditConcerns = result.subquestions.flatMap((subquestion) => subquestion.decisions
    .filter((decision) => decision.status === "not_satisfied" || decision.status === "insufficient_evidence")
    .map((decision) => ({
      subquestionId: subquestion.id,
      pointId: decision.pointId,
      kind: decision.status === "insufficient_evidence" ? "uncertain_evidence" as const : "confirmed_issue" as const,
      reason: decision.reason,
      evidenceLineIds: decision.evidenceLineIds
    })));
  const strengths = result.subquestions.flatMap((subquestion) => subquestion.decisions
    .filter((decision) => decision.status === "satisfied")
    .map((decision) => `${subquestion.title}：${decision.pointId}已满足评分要求`));
  const reviewItems = result.reviewReasons;
  const overallComment = result.score === result.maxScore
    ? "本次作答最终得分为满分。过程审验已执行，存在的证据不足或过程问题仅作为人工复核提示，不影响最终得分。"
    : `本次作答得分${result.score}/${result.maxScore}分。主要失分来自已确认未满足的评分点；证据不足的项目已保留并标记为人工复核。`;
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

interface LocalAuditComputation extends LocalFinalAnswerAudit {
  attempts: Array<Record<string, unknown>>;
}

function auditFinalAnswer(
  rubricAnswers: Rubric["subquestions"][number]["finalAnswers"],
  evidenceItems: AnswerEvidence["finalAnswers"]
): LocalAuditComputation {
  const actualAnswers = evidenceItems.map((item) => item.expression);
  const referenceAnswers = rubricAnswers.map((item) => item.expression);
  if (!actualAnswers.length || !referenceAnswers.length) {
    return {
      status: "not_available",
      method: !actualAnswers.length ? "student_answer_missing" : "reference_answer_missing",
      conflict: false,
      actualAnswers,
      referenceAnswers,
      attempts: []
    };
  }

  const actualExpression = actualAnswers.join("; ");
  const expectedCandidates = [
    ...rubricAnswers.map((item) => ({
      expression: item.expression,
      units: item.unit ? [item.unit] : [],
      tolerance: item.tolerance ?? 0
    })),
    ...(rubricAnswers.length > 1 ? [{
      expression: rubricAnswers.map((item) => item.expression).join("; "),
      units: rubricAnswers.flatMap((item) => item.unit ? [item.unit] : []),
      tolerance: Math.max(...rubricAnswers.map((item) => item.tolerance ?? 0))
    }] : [])
  ];
  const attempts: Array<Record<string, unknown>> = [];
  let matchedMethod = "not_equivalent";
  const matched = expectedCandidates.some((expected) => {
    const comparison = answerCollectionsEquivalent(actualExpression, expected.expression, expected.tolerance);
    const symbolicUnitWaiver = hasSymbolicValue(expected.expression);
    const unitMatches = symbolicUnitWaiver || expected.units.every((unit) => evidenceItems.some(
      (item) => normalizeUnit(item.unit) === normalizeUnit(unit)
    ));
    attempts.push({
      expected: expected.expression,
      actualParts: comparison.actualParts,
      expectedParts: comparison.expectedParts,
      comparisons: comparison.comparisons,
      expressionMatches: comparison.equivalent,
      unitMatches,
      expectedUnits: expected.units,
      actualUnits: evidenceItems.map((item) => item.unit ?? ""),
      symbolicUnitWaiver
    });
    if (comparison.equivalent && unitMatches) {
      matchedMethod = [...new Set(comparison.comparisons.map((item) => item.method))].join("+") || "collection_match";
      return true;
    }
    return false;
  });

  return {
    status: matched ? "equivalent" : "not_equivalent",
    method: matched ? matchedMethod : "not_equivalent",
    conflict: false,
    actualAnswers,
    referenceAnswers,
    attempts
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
}): GradingResult {
  const reviewReasons = new Set<string>();
  const deductions = input.appliedDeductions ?? [];

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
    const localAuditComputation = auditFinalAnswer(subquestion.finalAnswers, finalEvidenceItems);
    const localAuditConflict = (finalAnswerStatus === "correct" && localAuditComputation.status === "not_equivalent")
      || (finalAnswerStatus === "incorrect" && localAuditComputation.status === "equivalent");
    const localFinalAnswerAudit: LocalFinalAnswerAudit = {
      status: localAuditComputation.status,
      method: localAuditComputation.method,
      conflict: localAuditConflict,
      actualAnswers: localAuditComputation.actualAnswers,
      referenceAnswers: localAuditComputation.referenceAnswers
    };
    if (finalAnswerStatus === "uncertain") {
      reviewReasons.add(`${subquestion.title}最终答案待复核：${finalAnswerJudgement.reason}`);
    }

    // System invariant: a teacher-model "correct" decision always grants full credit.
    // Process auditing still runs and remains visible, but its findings cannot deduct.
    const grantsFullCredit = finalAnswerStatus === "correct";
    if (input.operationId) {
      logEvent(input.operationId, "equivalence", "final_answer_authority_decision", `${subquestion.title}：教师模型判定最终答案为${finalAnswerStatus}`, {
        subquestionId: subquestion.id,
        teacherStatus: finalAnswerStatus,
        teacherReason: finalAnswerJudgement.reason,
        teacherConfidence: finalAnswerJudgement.confidence,
        teacherEvidenceLineIds: finalAnswerJudgement.evidenceLineIds,
        decisionSource: finalAnswerDecisionSource,
        localAuditStatus: localFinalAnswerAudit.status,
        localAuditMethod: localFinalAnswerAudit.method,
        localAuditAttempts: localAuditComputation.attempts,
        conflict: localAuditConflict,
        grantsFullCredit,
        legacyRubricPolicyIgnored: subquestion.finalAnswerPolicy
      }, localAuditConflict || finalAnswerStatus === "uncertain" ? "warning" : finalAnswerStatus === "correct" ? "success" : "info");
    }

    const pointDecisions = subquestion.scorePoints.map((point) => {
      const modelDecision = input.decisions.find(
        (item) => item.subquestionId === subquestion.id && item.pointId === point.id
      );
      const decision = modelDecision ?? {
        subquestionId: subquestion.id,
        pointId: point.id,
        status: "insufficient_evidence" as const,
        evidenceLineIds: [],
        evidenceQuote: "",
        reason: "模型未返回该评分点的判断",
        confidence: 0,
        requiresReview: true,
        reviewReason: "评分点缺少判断结果"
      };
      const requiresReview = decision.requiresReview || decision.status === "insufficient_evidence";
      const scoringDisposition = grantsFullCredit
        ? "not_deducted_by_final_answer" as const
        : decision.status === "satisfied"
          ? "awarded" as const
          : decision.status === "not_satisfied"
            ? "not_awarded" as const
            : "uncertain_no_deduction" as const;
      if (requiresReview) reviewReasons.add(decision.reviewReason || `${point.title}需要复核`);
      return {
        ...decision,
        requiresReview,
        scoringDisposition,
        maxScore: point.score,
        awardedScore: grantsFullCredit || decision.status === "satisfied" || decision.status === "insufficient_evidence" || decision.status === "not_required" ? point.score : 0
      };
    });

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
    const auditDeductions = uniqueDeductions.map((deduction) => ({
      ...deduction,
      deductedScore: grantsFullCredit ? 0 : deduction.deductedScore,
      scoringDisposition: grantsFullCredit ? "not_deducted_by_final_answer" as const : "awarded" as const
    }));
    const subDeductions = grantsFullCredit ? [] : auditDeductions;

    const processScore = pointDecisions.reduce((sum, item) => sum + item.awardedScore, 0);
    const deductionTotal = subDeductions.reduce((sum, item) => sum + item.deductedScore, 0);
    const scoreBeforeDeduction = grantsFullCredit
      ? subquestion.maxScore
      : processScore;
    const score = Math.max(0, Math.min(subquestion.maxScore, scoreBeforeDeduction - deductionTotal));
    if (input.operationId) {
      logEvent(input.operationId, "scoring", "subquestion_score", `${subquestion.title}：${score}/${subquestion.maxScore}分`, {
        subquestionId: subquestion.id,
        finalAnswerStatus,
        teacherReason: finalAnswerJudgement.reason,
        teacherConfidence: finalAnswerJudgement.confidence,
        decisionSource: finalAnswerDecisionSource,
        localAuditStatus: localFinalAnswerAudit.status,
        localAuditConflict,
        grantsFullCredit,
        processScore,
        appliedDeduction: deductionTotal,
        processPointsOverridden: grantsFullCredit,
        processAuditExecuted: true,
        uncertainPoints: pointDecisions.filter((item) => item.status === "insufficient_evidence").length
      }, "success");
    }

    return {
      id: subquestion.id,
      title: subquestion.title,
      score,
      maxScore: subquestion.maxScore,
      finalAnswerStatus,
      finalAnswerReason: finalAnswerJudgement.reason,
      finalAnswerConfidence: finalAnswerJudgement.confidence,
      finalAnswerDecisionSource,
      finalAnswerEvidenceLineIds: finalAnswerJudgement.evidenceLineIds,
      studentFinalAnswer: finalAnswerJudgement.studentAnswer,
      referenceFinalAnswer: finalAnswerJudgement.referenceAnswer,
      localFinalAnswerAudit,
      processAuditSummary: {
        totalPoints: pointDecisions.length,
        satisfied: pointDecisions.filter((item) => item.status === "satisfied").length,
        notSatisfied: pointDecisions.filter((item) => item.status === "not_satisfied").length,
        uncertain: pointDecisions.filter((item) => item.status === "insufficient_evidence").length,
        reviewRequired: pointDecisions.filter((item) => item.requiresReview).length
      },
      decisions: pointDecisions,
      deductions: subDeductions,
      auditDeductions
    };
  });

  const allDecisions = subquestions.flatMap((item) => item.decisions);
  const traceable = allDecisions.filter((item) => item.evidenceLineIds.length > 0 || item.status === "not_satisfied").length;
  const automatic = allDecisions.filter((item) => !item.requiresReview).length;
  const ambiguityCount = input.evidence.ambiguities.filter((item) => item.scoreImpact !== "none").length;
  const score = subquestions.reduce((sum, item) => sum + item.score, 0);

  return {
    id: input.id,
    studentId: input.studentId,
    fileName: input.fileName,
    score,
    maxScore: input.rubric.totalScore,
    status: reviewReasons.size > 0 ? "needs_review" : "completed",
    reviewReasons: [...reviewReasons],
    evidence: input.evidence,
    subquestions,
    metrics: {
      ruleCoverage: allDecisions.length ? allDecisions.filter((item) => item.status).length / allDecisions.length : 1,
      evidenceTraceability: allDecisions.length ? traceable / allDecisions.length : 1,
      autoDecisionRate: allDecisions.length ? automatic / allDecisions.length : 1,
      ambiguityRate: input.evidence.lines.length ? ambiguityCount / input.evidence.lines.length : 0,
      durationMs: input.durationMs
    },
    modelName: input.modelName,
    rubricVersion: input.rubric.version,
    gradingEngineVersion: GRADING_ENGINE_VERSION,
    teacherJudgementVersion: input.teacherJudgementVersion ?? TEACHER_JUDGEMENT_VERSION,
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason
  };
}
