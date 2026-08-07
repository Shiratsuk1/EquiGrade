export type DecisionStatus = "satisfied" | "not_satisfied" | "insufficient_evidence" | "not_required";
export type FinalAnswerStatus = "correct" | "incorrect" | "missing" | "uncertain";
export type ScoringDisposition = "awarded" | "not_awarded" | "not_deducted_by_final_answer" | "uncertain_no_deduction";

export interface FinalAnswerRule {
  expression: string;
  unit?: string;
  tolerance?: number;
  label?: string;
}

export interface ScorePoint {
  id: string;
  title: string;
  description: string;
  score: number;
  type: "formula" | "substitution" | "result" | "text";
  expected: string;
  equivalents?: string[];
}

export interface DeductionRule {
  id: string;
  reason: string;
  deduct: number;
  exclusiveGroup: string;
}

export interface SubquestionRubric {
  id: string;
  title: string;
  maxScore: number;
  finalAnswerPolicy: "full_credit" | "process_required";
  finalAnswers: FinalAnswerRule[];
  scorePoints: ScorePoint[];
  deductions: DeductionRule[];
}

export interface Rubric {
  title: string;
  recognizedQuestionText: string;
  version: number;
  status: "draft" | "locked";
  totalScore: number;
  subquestions: SubquestionRubric[];
  warnings: string[];
}

export interface AnswerLine {
  id: string;
  text: string;
  latex?: string;
  region?: [number, number, number, number];
  status: "active" | "crossed_out" | "uncertain";
  confidence: number;
  alternatives?: string[];
}

export interface FinalAnswerEvidence {
  subquestionId: string;
  lineId: string;
  expression: string;
  unit?: string;
  confidence: number;
}

export interface AnswerEvidence {
  lines: AnswerLine[];
  finalAnswers: FinalAnswerEvidence[];
  ambiguities: Array<{
    lineId?: string;
    reason: string;
    scoreImpact: "none" | "possible" | "certain";
  }>;
}

export interface RubricDecision {
  subquestionId: string;
  pointId: string;
  status: DecisionStatus;
  evidenceLineIds: string[];
  evidenceQuote: string;
  reason: string;
  confidence: number;
  requiresReview: boolean;
  reviewReason?: string;
  scoringDisposition?: ScoringDisposition;
}

export interface AppliedDeduction {
  subquestionId: string;
  ruleId: string;
  evidenceLineIds: string[];
  reason: string;
  confidence: number;
}

export interface FinalAnswerJudgement {
  subquestionId: string;
  status: FinalAnswerStatus;
  evidenceLineIds: string[];
  studentAnswer: string;
  referenceAnswer: string;
  reason: string;
  confidence: number;
}

export interface LocalFinalAnswerAudit {
  status: "equivalent" | "not_equivalent" | "not_available";
  method: string;
  conflict: boolean;
  actualAnswers: string[];
  referenceAnswers: string[];
}

export interface TeacherCommentaryLossPoint {
  subquestionId: string;
  pointId: string;
  scoreLost: number;
  reason: string;
  evidenceLineIds: string[];
}

export interface TeacherCommentaryAuditConcern {
  subquestionId: string;
  pointId?: string;
  kind: "confirmed_issue" | "uncertain_evidence";
  reason: string;
  evidenceLineIds: string[];
}

export interface TeacherCommentary {
  overallComment: string;
  strengths: string[];
  lostPoints: TeacherCommentaryLossPoint[];
  auditConcerns: TeacherCommentaryAuditConcern[];
  reviewItems: string[];
  basedOnDecisionIds: string[];
  status: "completed" | "fallback";
  modelName?: string;
  version: string;
}

export interface ProcessAuditSummary {
  totalPoints: number;
  satisfied: number;
  notSatisfied: number;
  uncertain: number;
  reviewRequired: number;
}

export interface SubquestionResult {
  id: string;
  title: string;
  score: number;
  maxScore: number;
  finalAnswerStatus: FinalAnswerStatus;
  finalAnswerReason?: string;
  finalAnswerConfidence?: number;
  finalAnswerDecisionSource?: "teacher_model" | "missing_teacher_judgement";
  finalAnswerEvidenceLineIds?: string[];
  studentFinalAnswer?: string;
  referenceFinalAnswer?: string;
  localFinalAnswerAudit?: LocalFinalAnswerAudit;
  processAuditSummary?: ProcessAuditSummary;
  decisions: Array<RubricDecision & { awardedScore: number; maxScore: number }>;
  deductions: Array<AppliedDeduction & { deductedScore: number; scoringDisposition?: ScoringDisposition }>;
  auditDeductions?: Array<AppliedDeduction & { deductedScore: number; scoringDisposition: ScoringDisposition }>;
}

export interface GradingResult {
  id: string;
  studentId: string;
  fileName: string;
  score: number;
  maxScore: number;
  status: "completed" | "needs_review" | "failed";
  reviewReasons: string[];
  evidence: AnswerEvidence;
  subquestions: SubquestionResult[];
  metrics: {
    ruleCoverage: number;
    evidenceTraceability: number;
    autoDecisionRate: number;
    ambiguityRate: number;
    durationMs: number;
  };
  modelName: string;
  rubricVersion: number;
  gradingEngineVersion?: string;
  teacherJudgementVersion?: string;
  teacherCommentary?: TeacherCommentary;
  previousResultId?: string;
  regradedAt?: string;
  regradeReason?: string;
}

export interface ModelConfigInput {
  name: string;
  baseUrl: string;
  apiKey?: string;
  visionModel: string;
  textModel: string;
  timeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
  maxOutputTokens: number;
  supportsJsonSchema: boolean;
  supportsJsonObject: boolean;
  supportsBase64Images: boolean;
  enabled: boolean;
}

export interface PublicModelConfig extends Omit<ModelConfigInput, "apiKey"> {
  id: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  updatedAt: string;
}

export type SystemLogLevel = "info" | "warning" | "error" | "success";
export type SystemLogStatus = "started" | "progress" | "completed" | "failed";

export interface SystemLogEntry {
  id: string;
  operationId: string;
  timestamp: string;
  level: SystemLogLevel;
  status: SystemLogStatus;
  scope: "rubric" | "grading" | "equivalence" | "scoring" | "storage" | "model" | "system";
  step: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ActiveOperation {
  id: string;
  scope: SystemLogEntry["scope"];
  label: string;
  step: string;
  startedAt: string;
  updatedAt: string;
  details?: Record<string, unknown>;
}

export interface SystemLogSnapshot {
  activeOperations: ActiveOperation[];
  entries: SystemLogEntry[];
  serverTime: string;
}

export interface SavedAsset {
  id: string;
  fileName: string;
  mimeType: string;
  url: string;
}

export interface GradingTemplateSummary {
  id: string;
  title: string;
  totalScore: number;
  createdAt: string;
  updatedAt: string;
  gradingCount: number;
  questionImageCount: number;
  referenceImageCount: number;
}

export interface GradingTemplateDetail extends GradingTemplateSummary {
  questionText: string;
  referenceText: string;
  rubric: Rubric;
  questionImages: SavedAsset[];
  referenceImages: SavedAsset[];
  records: GradingHistoryRecord[];
}

export interface GradingHistoryRecord {
  id: string;
  createdAt: string;
  answerImage: SavedAsset;
  result: GradingResult;
}
