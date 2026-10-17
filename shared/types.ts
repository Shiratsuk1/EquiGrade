export type DecisionStatus = "satisfied" | "not_satisfied" | "not_present" | "unreadable" | "insufficient_evidence" | "not_required";
export type FinalAnswerStatus = "correct" | "incorrect" | "missing" | "uncertain";
/** Whether the image contains a meaningful student-written answer. */
export type AnswerPresence = "no_effective_answer" | "probable_answer" | "confirmed_answer" | "unreadable_answer" | "image_unreliable";
export type ScoringDisposition = "awarded" | "partially_awarded" | "not_awarded" | "awarded_by_visual_review" | "not_awarded_by_visual_review" | "not_deducted_by_final_answer" | "not_deducted_by_score_floor" | "uncertain_no_deduction";
export type DecisionSource = "model" | "normalized_uncertain" | "synthetic_missing" | "final_answer_authority" | "large_question_point_review" | "unreadable_local_review" | "local_numeric_review" | "visual_local_review" | "small_question_risk_guard";

export const DEFAULT_UNREADABLE_REVIEW_THRESHOLD = 2;
export const DEFAULT_MODEL_TIMEOUT_MS = 300_000;
export const TEACHER_REASONING_EFFORTS = ["disabled", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type TeacherReasoningEffort = typeof TEACHER_REASONING_EFFORTS[number];
export const DEFAULT_TEACHER_REASONING_EFFORT: TeacherReasoningEffort = "disabled";
/** Responses Agent 的多模态长上下文请求默认使用低推理，避免兼容网关采用过重的隐式默认预算。 */
export const DEFAULT_RESPONSES_AGENT_REASONING_EFFORT: TeacherReasoningEffort = "low";
export const DEFAULT_REVIEW_REASONING_EFFORT: TeacherReasoningEffort = "low";
export const MAX_MODEL_SYSTEM_PROMPT_LENGTH = 20_000;
export const GRADING_MODES = ["vision_direct", "evidence_pipeline"] as const;
export type GradingMode = typeof GRADING_MODES[number];
export const DEFAULT_GRADING_MODE: GradingMode = "vision_direct";
/** Large-question workflow selector.  Kept separate from the legacy gradingMode compatibility field. */
export const LARGE_QUESTION_WORKFLOWS = ["staged", "responses_agent"] as const;
export type LargeQuestionWorkflow = typeof LARGE_QUESTION_WORKFLOWS[number];
export const DEFAULT_LARGE_QUESTION_WORKFLOW: LargeQuestionWorkflow = "staged";
export const STAGED_LAYOUT_ENGINES = ["paddleocr", "model_native"] as const;
export type StagedLayoutEngine = typeof STAGED_LAYOUT_ENGINES[number];
export const DEFAULT_STAGED_LAYOUT_ENGINE: StagedLayoutEngine = "model_native";
export const DEFAULT_RESPONSES_AGENT_TIMEOUT_MS = 300_000;
export const DEFAULT_RESPONSES_AGENT_MAX_OUTPUT_TOKENS = 12_000;
export const DEFAULT_RESPONSES_AGENT_MAX_TOOL_ROUNDS = 3;
export const DEFAULT_RESPONSES_AGENT_MAX_REGIONS = 6;
export const QUESTION_TYPES = ["large", "small"] as const;
export type QuestionType = typeof QUESTION_TYPES[number];
export const DEFAULT_QUESTION_TYPE: QuestionType = "large";

/**
 * Stable names for every model/API call in the grading system.  The route is
 * deliberately separate from the model name so the UI can change a service
 * without changing the grading workflow itself.
 */
export const MODEL_ROUTE_KEYS = [
  "rubric_structure_vision",
  "rubric_structure_text",
  "rubric_refinement",
  "large_question_answer_triage",
  "large_question_layout_detection",
  "large_question_responses_agent",
  "large_question_visual_review",
  "large_question_point_review",
  "small_question_blank_layout",
  "small_question_blind_transcription",
  "small_question_skeptic_assessment",
  "small_question_escalated_review",
  "small_question_reconstruction",
  "small_question_grading_vision",
  "small_question_grading_text",
  "legacy_direct_visual_grading",
  "legacy_evidence_extraction",
  "legacy_final_answer",
  "legacy_process_review",
  "legacy_unreadable_review",
  "legacy_numeric_review"
] as const;
export type ModelRouteKey = typeof MODEL_ROUTE_KEYS[number];
export type ModelRouteEndpoint = "teacher" | "review";
export const MODEL_SYSTEM_PROMPT_MODES = ["append", "replace"] as const;
export type ModelSystemPromptMode = typeof MODEL_SYSTEM_PROMPT_MODES[number];

export interface ModelRouteConfig {
  endpoint: ModelRouteEndpoint;
  model: string;
  reasoningEffort?: TeacherReasoningEffort;
  timeoutMs?: number;
  maxRetries?: number;
  maxOutputTokens?: number;
  /** Optional per-step prompt adjustment; an empty value keeps the built-in prompt. */
  systemPrompt?: string;
  systemPromptMode?: ModelSystemPromptMode;
}

export interface PaddleOcrConfigInput {
  jobUrl?: string;
  model?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  useDocOrientationClassify?: boolean;
  useDocUnwarping?: boolean;
  useChartRecognition?: boolean;
}

/** Configuration for the opt-in stateless Responses Agent large-question path. */
export interface ResponsesAgentConfigInput {
  baseUrl: string;
  apiKey?: string;
  model: string;
  reasoningEffort?: TeacherReasoningEffort;
  timeoutMs: number;
  maxOutputTokens: number;
  /** Maximum Responses turns that contain local-inspection tool calls. */
  maxToolRounds: number;
  /** Maximum unique normalized local regions returned to the model. */
  maxRegions: number;
  /** Extra semantic-risk escalation. Mandatory evidence and score safety checks are never disabled. */
  backendGuardrailsEnabled: boolean;
  /** The independent high-risk verifier is optional and never changes scores. */
  independentVerifierEnabled: boolean;
  verifierBaseUrl?: string;
  verifierApiKey?: string;
  verifierModel?: string;
  verifierReasoningEffort?: TeacherReasoningEffort;
}

/**
 * Describes how a signed physical quantity is interpreted when comparing a
 * student's final answer with a rubric answer.  The field is optional on
 * purpose: rubrics written by older releases remain valid and are handled
 * conservatively by the semantic comparator.
 */
export const FINAL_ANSWER_SIGN_POLICIES = [
  "unspecified",
  "fixed_convention",
  "direction_dependent",
  "role_reversal",
  "magnitude_only",
  "physically_signed"
] as const;
export type FinalAnswerSignPolicy = typeof FINAL_ANSWER_SIGN_POLICIES[number];

export interface FinalAnswerRule {
  expression: string;
  unit?: string;
  label?: string;
  /** How signs in this answer should be interpreted; absent for legacy rules. */
  signPolicy?: FinalAnswerSignPolicy;
  /** The declared positive direction, e.g. "向右为正" or "x轴正方向向右". */
  positiveDirection?: string;
  /** The physical quantity/agent described by the answer, e.g. "外力对系统做功". */
  subject?: string;
  /** Optional explanation of what the sign means in this rubric. */
  signConvention?: string;
}

export interface ScorePoint {
  id: string;
  title: string;
  description: string;
  score: number;
  type: "formula" | "substitution" | "result" | "text";
  expected: string;
  commonResponses?: string[];
  alternativeMethods?: string[];
  acceptedEquivalents?: string[];
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
  /** `locked` is accepted only for templates created by older releases. */
  status: "draft" | "saved" | "locked";
  questionType: QuestionType;
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

export interface StudentAnswerReconstruction {
  lines: AnswerLine[];
  ambiguities: Array<{
    lineId?: string;
    reason: string;
    scoreImpact: "none" | "possible" | "certain";
  }>;
  status: "clear" | "review";
  reviewReasons: string[];
}

export interface SmallQuestionBlankCropAudit {
  subquestionId: string;
  title: string;
  coordinate: [number, number, number, number] | null;
  hasAnswer: boolean;
  artifactFileName?: string;
  cropWidth?: number;
  cropHeight?: number;
}

export interface SmallQuestionBlankRecognitionAudit {
  subquestionId: string;
  blindTranscriber: {
    extractedAnswer: string;
    confidence: number;
    rawText?: string;
  };
  skepticAssessor: {
    extractedAnswer: string;
    status: FinalAnswerStatus;
    confidence: number;
    issues: string[];
    reason: string;
    riskPoints?: string[];
  };
  comparisonStatus: "consensus" | "discrepancy";
  escalatedReview?: {
    finalExtractedAnswer: string;
    status: FinalAnswerStatus;
    confidence: number;
    visualAnalysis: string;
    resolutionReason: string;
    riskPoints?: string[];
  };
  finalStatus: FinalAnswerStatus;
  finalAnswer: string;
  finalConfidence: number;
  finalRiskPoints?: string[];
  decisionSource: "consensus_ab" | "escalated_review_c" | "local_rule_override" | "blank_missing" | "skeptic_direct";
}

export interface SmallQuestionAudit {
  pipeline: "staged_vision_crops";
  layoutDurationMs: number;
  dualRecognitionDurationMs: number;
  escalatedReviewDurationMs: number;
  crops: SmallQuestionBlankCropAudit[];
  recognitions: SmallQuestionBlankRecognitionAudit[];
}

export interface PaddleOcrAudit {
  provider: "paddleocr" | "model_native";
  model: string;
  jobId: string;
  /** Indicates whether the audit came from PaddleOCR or a controlled replay. */
  source?: "live" | "cached_replay";
  rawJsonl: string;
  markdownText: string;
  durationMs: number;
  /** Dimensions reported by PaddleOCR for the image used by the job. */
  imageWidth?: number;
  imageHeight?: number;
  /** Stable, page-ordered projection of layout_det_res.boxes. */
  layoutBlocks?: PaddleOcrLayoutBlock[];
}

export interface PaddleOcrLayoutBlock {
  blockId: string;
  pageIndex: number;
  label: string;
  score: number;
  coordinate: [number, number, number, number];
  polygonPoints: Array<[number, number]>;
  order: number | null;
}

/** Teacher-verified transcription aligned to PaddleOCR's visual blocks. */
export interface OcrTranscriptionLine extends AnswerLine {
  blockId: string;
  blockLabel: string;
  ocrScore: number;
}

export interface OcrTranscription {
  lines: OcrTranscriptionLine[];
  blockCount: number;
  verifiedBlockCount: number;
  missingBlockIds: string[];
}

export interface DirectVisualReviewPlanItem {
  reviewId: string;
  blockId: string;
  criterionId: string;
  target: string;
  recognized: string;
  candidates: string[];
  reason: string;
  scoreEffect: Record<string, number>;
}

export interface DirectVisualReviewResult {
  reviewId: string;
  result: string;
  certainty: "clear" | "uncertain" | "insufficient_visual_evidence";
  reason: string;
}

export interface DirectVisualReviewAudit {
  reviewRequired: boolean;
  reviewItems: DirectVisualReviewPlanItem[];
  results: DirectVisualReviewResult[];
  initialScore: number;
  initialSubquestionScores: Array<{ subquestionId: string; score: number; maxScore: number }>;
  finalScore?: number;
  durationMs: number;
}

export type StudentAnswerImagePreprocessMode = "off" | "enhanced" | "dual";

export interface StudentAnswerImagePreprocessAudit {
  provider: "sharp";
  mode: StudentAnswerImagePreprocessMode;
  applied: boolean;
  inputMimeType: string;
  outputMimeType: string;
  inputBytes: number;
  outputBytes: number;
  width?: number;
  height?: number;
  geometryPreserved: boolean;
  operations: string[];
  fallbackReason?: string;
}

export interface ResponsesAgentImageAudit {
  inputMimeType: string;
  outputMimeType: "image/webp";
  inputBytes: number;
  outputBytes: number;
  width?: number;
  height?: number;
  quality: 90;
  grayscale: boolean;
  geometryPreserved: boolean;
  operations: string[];
  fallbackReason?: string;
}

export interface ResponsesAgentRegionAudit {
  regionId: string;
  kind: "tile" | "region";
  normalizedRegion: [number, number, number, number];
  pixelRegion: [number, number, number, number];
  imageSha256: string;
  mimeType: "image/webp";
  artifactFileName?: string;
  sourceToolCallIds: string[];
}

export interface ResponsesAgentToolCallAudit {
  callId?: string;
  /** Normalized audit category. Unknown provider/tool names must never be
   * presented as one of the supported inspection tools. */
  name: "inspect_page_tiles" | "inspect_page_region" | "unknown";
  /** Original function name when the provider returned an unsupported tool. */
  requestedName?: string;
  arguments: Record<string, unknown>;
  status: "completed" | "rejected" | "failed" | "deduplicated";
  resultSummary: string;
  regions: ResponsesAgentRegionAudit[];
  durationMs: number;
}

export interface ResponsesAgentRoundAudit {
  round: number;
  responseId?: string;
  status?: string;
  durationMs: number;
  outputItemTypes: string[];
  functionCallIds: string[];
  toolCalls: ResponsesAgentToolCallAudit[];
  rawResponse?: string;
}

export interface ResponsesAgentVerifierConflict {
  subquestionId: string;
  pointId?: string;
  kind: "final_answer" | "score_point" | "evidence";
  primaryStatus: string;
  verifierStatus: string;
  evidenceLineIds: string[];
  reason: string;
}

/** Independent, fresh-context high-risk review. It is advisory only and can
 * never alter the score produced by the teacher Agent or the backend engine. */
export interface ResponsesAgentVerifierAudit {
  status: "completed" | "failed" | "not_needed";
  model: string;
  baseUrl: string;
  responseId?: string;
  durationMs: number;
  verdict?: "agree" | "conflict" | "uncertain";
  reviewRequired: boolean;
  summary?: string;
  conflicts: ResponsesAgentVerifierConflict[];
  rawResponse?: string;
  error?: string;
}

/** Mandatory targeted visual recheck for an uncertain or unauditable primary
 * Responses Agent judgement. Unlike the optional verifier, this audit records
 * the recheck that may be applied back to the score-bearing judgement. */
export interface ResponsesAgentLocalReviewAudit {
  status: "completed" | "failed" | "not_needed";
  model: string;
  baseUrl: string;
  responseId?: string;
  durationMs: number;
  targetKeys: string[];
  reviewedKeys: string[];
  cropCount: number;
  cropArtifactFileNames: string[];
  results: Array<{
    key: string;
    subquestionId: string;
    pointId?: string;
    status: string;
    confidence: number;
    requiresReview: boolean;
  }>;
  rawResponse?: string;
  error?: string;
}

export interface ResponsesAgentAudit {
  provider: "openai_responses";
  workflow: "responses_agent";
  store: false;
  model: string;
  baseUrl: string;
  startedAt: string;
  durationMs: number;
  maxToolRounds: number;
  maxRegions: number;
  rounds: ResponsesAgentRoundAudit[];
  inputImages: Array<{
    label?: string;
    mimeType: "image/webp";
    sha256: string;
    bytes: number;
    role: "student" | "question" | "reference" | "grid";
    audit?: ResponsesAgentImageAudit;
    artifactFileName?: string;
  }>;
  transcriptionLineCount: number;
  finalAnswerCount: number;
  finalBasis: string[];
  reviewReasons: string[];
  /** Opaque provider reasoning item contents, if returned; never displayed as plaintext reasoning. */
  reasoningItemCount?: number;
  /** Backend-enforced local visual recheck for uncertain/unauditable items. */
  localReview?: ResponsesAgentLocalReviewAudit;
  independentVerifier?: ResponsesAgentVerifierAudit;
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
  /** Teacher-provided partial score for a point with explicit sub-scores. */
  awardedScore?: number;
  scoringDisposition?: ScoringDisposition;
  decisionSource?: DecisionSource;
  uncertainScore?: number;
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
  /** Kept separate from correctness so scanner artifacts cannot become “blurry answers”. */
  answerPresence?: AnswerPresence;
  evidenceLineIds: string[];
  studentAnswer: string;
  referenceAnswer: string;
  reason: string;
  confidence: number;
  decisionSource?: "teacher_model" | "unreadable_local_review" | "local_numeric_review" | "visual_local_review";
}

export interface AnswerPresenceAudit {
  classification: AnswerPresence;
  confidence: number;
  candidateRegions: Array<{
    region?: [number, number, number, number];
    reason: "connected_strokes" | "character_cluster" | "formula_structure" | "isolated_artifact" | "background_shadow" | "edge_shadow";
  }>;
  artifactReasons: string[];
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
  notPresent?: number;
  unreadable?: number;
  reviewRequired: number;
}

export interface SubquestionResult {
  id: string;
  title: string;
  score: number;
  maxScore: number;
  maximumPossibleScore?: number;
  uncertainScore?: number;
  finalAnswerStatus: FinalAnswerStatus;
  answerPresence?: AnswerPresence;
  finalAnswerReason?: string;
  finalAnswerConfidence?: number;
  finalAnswerDecisionSource?: "teacher_model" | "missing_teacher_judgement" | "unreadable_local_review" | "local_numeric_review" | "visual_local_review";
  finalAnswerEvidenceLineIds?: string[];
  studentFinalAnswer?: string;
  referenceFinalAnswer?: string;
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
  maximumPossibleScore?: number;
  /** Whether every score-affecting judgement is determinate enough for automatic write-back. */
  scoreResolved?: boolean;
  scoreResolutionReasons?: string[];
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
  gradingMode?: GradingMode;
  gradingPipeline?: "large_question" | "small_question_ocr" | "large_question_responses_agent" | "small_question_staged";
  ocrAudit?: PaddleOcrAudit;
  /** Full OCR-block transcription after one teacher-model verification pass. */
  ocrTranscription?: OcrTranscription;
  directVisualReviewAudit?: DirectVisualReviewAudit;
  imagePreprocessAudit?: StudentAnswerImagePreprocessAudit;
  answerPresenceAudit?: AnswerPresenceAudit;
  responsesAgentAudit?: ResponsesAgentAudit;
  smallQuestionAudit?: SmallQuestionAudit;
  rubricVersion: number;
  gradingEngineVersion?: string;
  teacherJudgementVersion?: string;
  reviewPolicy?: {
    unreadableScoreThreshold: number;
    unreadableAffectedScore: number;
    unreadableReviewTriggered: boolean;
  };
  teacherCommentary?: TeacherCommentary;
  previousResultId?: string;
  duplicateOfResultId?: string;
  regradedAt?: string;
  regradeReason?: string;
}

export interface ModelConfigInput {
  name: string;
  baseUrl: string;
  apiKey?: string;
  visionModel: string;
  textModel: string;
  reviewBaseUrl?: string;
  reviewApiKey?: string;
  reviewModel?: string;
  timeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
  maxOutputTokens: number;
  unreadableReviewThreshold: number;
  gradingMode?: GradingMode;
  /** New large-question selector; legacy gradingMode remains for compatibility. */
  largeQuestionWorkflow?: LargeQuestionWorkflow;
  /** Layout detection engine for the staged large-question workflow. Defaults to "paddleocr". */
  stagedLayoutEngine?: StagedLayoutEngine;
  teacherReasoningEffort?: TeacherReasoningEffort;
  reviewReasoningEffort?: TeacherReasoningEffort;
  /** Per-call API/model and parameter overrides. Omitted values inherit globals. */
  modelRoutes?: Partial<Record<ModelRouteKey, ModelRouteConfig>>;
  /** PaddleOCR transport settings; the access token remains server-side. */
  paddleOcr?: PaddleOcrConfigInput;
  responsesAgent?: ResponsesAgentConfigInput;
  /** 小题复核是否启用盲审 A 与终审 C（默认 true；若关闭则直接采信挑刺 B 结论，绕过 A 与 C） */
  smallQuestionBlindReviewEnabled?: boolean;
  supportsJsonSchema: boolean;
  supportsJsonObject: boolean;
  supportsBase64Images: boolean;
  enabled: boolean;
}

export interface PublicModelConfig extends Omit<ModelConfigInput, "apiKey" | "reviewApiKey" | "responsesAgent"> {
  id: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  reviewApiKeyMasked: string;
  hasReviewApiKey: boolean;
  responsesAgent?: Omit<ResponsesAgentConfigInput, "apiKey" | "verifierApiKey"> & {
    apiKeyMasked: string;
    hasApiKey: boolean;
    verifierApiKeyMasked: string;
    hasVerifierApiKey: boolean;
  };
  updatedAt: string;
}

export type SystemLogLevel = "info" | "warning" | "error" | "success";
export type SystemLogStatus = "started" | "progress" | "completed" | "failed";

export interface ModelCallLogDetails extends Record<string, unknown> {
  kind: "model_call";
  callId?: string;
  model: string;
  routeKey?: ModelRouteKey;
  configuration?: {
    name: string;
    baseUrl: string;
  };
  schemaName: string;
  outputMode: string;
  attempt: number;
  maxAttempts: number;
  durationMs?: number;
  errorClass?: "transport_failure" | "timeout" | "terminated" | "http_error" | "invalid_json" | "schema_mismatch" | "latex_protocol_error" | "missing_evidence" | "unknown";
  responseHeadersMs?: number;
  firstContentMs?: number;
  streamDurationMs?: number;
  outputChars?: number;
  streamEventCount?: number;
  streamContentMode?: "delta" | "message_snapshot" | "text";
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
  };
  request: {
    systemPrompt: string;
    userPrompt: string;
    images: Array<{
      label?: string;
      mimeType: string;
      bytes: number;
      sha256: string;
    }>;
    responseFormat?: Record<string, unknown>;
    reasoningEffort?: Exclude<TeacherReasoningEffort, "disabled">;
  };
  response?: {
    status: number;
    raw: string;
    content?: string;
  };
  error?: string;
}

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

export type ModelCallHistoryEntry = Omit<SystemLogEntry, "scope" | "step" | "details"> & {
  scope: "model";
  step: "model_call";
  details: ModelCallLogDetails;
};

export interface ActiveOperation {
  id: string;
  scope: SystemLogEntry["scope"];
  cancellable: boolean;
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

export type GradingArtifactCategory = "preprocessed_answer" | "material" | "ocr" | "model" | "result" | "agent_region";

/** 可从历史记录详情直接访问的单次批改产物。 */
export interface GradingArtifact {
  id: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  category: GradingArtifactCategory;
  url: string;
}

export interface GradingTemplateSummary {
  id: string;
  title: string;
  questionType: QuestionType;
  totalScore: number;
  builtIn?: boolean;
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
  rubricSnapshot?: Rubric;
  modelCallCount: number;
  modelCalls?: ModelCallHistoryEntry[];
  artifacts?: GradingArtifact[];
}

export interface LocalPipelineAnswer {
  id: string;
  studentId: string;
  fileName: string;
  mimeType: string;
  url: string;
}

export interface LocalPipelineTask {
  id: string;
  templateId: string;
  templateTitle: string;
  totalScore: number;
  createdAt: string;
  answers: LocalPipelineAnswer[];
}
