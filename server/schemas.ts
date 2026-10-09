import { z } from "zod";
import { FINAL_ANSWER_SIGN_POLICIES } from "../shared/types.js";
import type { Rubric } from "../shared/types.js";

const scorePointSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string(),
  score: z.number().nonnegative(),
  type: z.enum(["formula", "substitution", "result", "text"]),
  expected: z.string(),
  commonResponses: z.array(z.string()).default([]),
  alternativeMethods: z.array(z.string()).default([]),
  acceptedEquivalents: z.array(z.string()).default([])
});

const answerLineSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string(),
  latex: z.string().optional(),
  region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  status: z.enum(["active", "crossed_out", "uncertain"]),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(z.string()).default([])
});

const answerAmbiguitySchema = z.object({
  lineId: z.string().optional(),
  reason: z.string(),
  scoreImpact: z.enum(["none", "possible", "certain"])
});

const finalAnswerRuleSchema = z.object({
  expression: z.string(),
  unit: z.string().optional(),
  label: z.string().optional(),
  signPolicy: z.enum(FINAL_ANSWER_SIGN_POLICIES).optional(),
  positiveDirection: z.string().optional(),
  subject: z.string().optional(),
  signConvention: z.string().optional()
});

export const rubricSchema = z.object({
  title: z.string().trim().min(1),
  recognizedQuestionText: z.string().default(""),
  version: z.number().int().positive().default(1),
  status: z.enum(["draft", "saved", "locked"]).default("draft"),
  questionType: z.enum(["large", "small"]).default("large"),
  totalScore: z.number().nonnegative(),
  subquestions: z.array(z.object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    maxScore: z.number().nonnegative(),
    finalAnswerPolicy: z.enum(["full_credit", "process_required"]),
    finalAnswers: z.array(finalAnswerRuleSchema),
    scorePoints: z.array(scorePointSchema),
    deductions: z.array(z.object({
      id: z.string().trim().min(1),
      reason: z.string(),
      deduct: z.number().nonnegative(),
      exclusiveGroup: z.string().trim().min(1)
    })).default([])
  })),
  warnings: z.array(z.string()).default([])
});

export const evidenceSchema = z.object({
  lines: z.array(answerLineSchema),
  finalAnswers: z.array(z.object({
    subquestionId: z.string(),
    lineId: z.string(),
    expression: z.string(),
    unit: z.string().optional(),
    confidence: z.number().min(0).max(1)
  })),
  ambiguities: z.array(answerAmbiguitySchema).default([])
});

export const studentAnswerReconstructionSchema = z.object({
  lines: z.array(answerLineSchema),
  ambiguities: z.array(answerAmbiguitySchema).default([]),
  status: z.enum(["clear", "review"]),
  reviewReasons: z.array(z.string()).default([])
});

const finalAnswerJudgementItemSchema = z.object({
  subquestionId: z.string(),
  status: z.enum(["correct", "incorrect", "missing", "uncertain"]),
  answerPresence: z.enum(["no_effective_answer", "probable_answer", "confirmed_answer", "unreadable_answer", "image_unreliable"]).optional(),
  evidenceLineIds: z.array(z.string()),
  studentAnswer: z.string(),
  referenceAnswer: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  decisionSource: z.enum(["teacher_model", "unreadable_local_review", "local_numeric_review"]).optional()
});

export const finalAnswerJudgementsSchema = z.object({
  finalAnswerJudgements: z.array(finalAnswerJudgementItemSchema)
});

const largeQuestionAnswerTriageItemSchema = z.object({
  subquestionId: z.string().trim().min(1),
  blockIds: z.array(z.string().trim().min(1)),
  status: z.enum(["correct", "incorrect", "missing", "uncertain"]),
  answerPresence: z.enum(["no_effective_answer", "probable_answer", "confirmed_answer", "unreadable_answer", "image_unreliable"]).optional(),
  studentAnswer: z.string(),
  coordinate: z.array(z.number()).length(4).nullable().optional().default(null),
  confidence: z.number().min(0).max(1),
  reason: z.string()
}).strict();

const largeQuestionAnswerTriageTranscriptionLineSchema = z.object({
  blockId: z.string().trim().min(1),
  text: z.string(),
  latex: z.string(),
  status: z.enum(["active", "crossed_out", "uncertain"]),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(z.string()).default([])
}).strict();

const largeQuestionAnswerTriageTranscriptionSchema = z.object({
  lines: z.array(largeQuestionAnswerTriageTranscriptionLineSchema)
}).strict();

/**
 * The first large-question call binds a subquestion to PaddleOCR blocks,
 * judges the final answer, and verifies the full OCR-block transcription.
 * It must not return point scores, deductions, or a review plan.
 */
export const largeQuestionAnswerTriageSchema = z.object({
  answers: z.array(largeQuestionAnswerTriageItemSchema),
  transcription: largeQuestionAnswerTriageTranscriptionSchema
}).strict();

export type LargeQuestionAnswerTriage = z.infer<typeof largeQuestionAnswerTriageSchema>;

const responsesAgentTranscriptionLineSchema = z.object({
  id: z.string().trim().min(1),
  subquestionId: z.string(),
  text: z.string(),
  latex: z.string(),
  region: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  status: z.enum(["active", "crossed_out", "uncertain"]),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(z.string()),
  sourceImageId: z.string().trim().min(1),
  sourceToolCallIds: z.array(z.string())
}).strict();

const responsesAgentTranscriptionSchema = z.object({
  lines: z.array(responsesAgentTranscriptionLineSchema),
  ambiguities: z.array(z.object({
    lineId: z.string(),
    reason: z.string(),
    scoreImpact: z.enum(["none", "possible", "certain"])
  }).strict())
}).strict();

const responsesAgentFinalAnswerSchema = z.object({
  subquestionId: z.string().trim().min(1),
  status: z.enum(["correct", "incorrect", "missing", "uncertain"]),
  answerPresence: z.enum(["no_effective_answer", "probable_answer", "confirmed_answer", "unreadable_answer", "image_unreliable"]).optional(),
  evidenceLineIds: z.array(z.string()),
  studentAnswer: z.string(),
  referenceAnswer: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  decisionSource: z.literal("teacher_model")
}).strict();

const responsesAgentDecisionSchema = z.object({
  subquestionId: z.string().trim().min(1),
  pointId: z.string().trim().min(1),
  status: z.enum(["satisfied", "not_satisfied", "not_present", "unreadable", "insufficient_evidence"]),
  evidenceLineIds: z.array(z.string()),
  evidenceQuote: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  requiresReview: z.boolean(),
  awardedScore: z.number().nonnegative()
}).strict();

const responsesAgentDeductionSchema = z.object({
  subquestionId: z.string().trim().min(1),
  ruleId: z.string().trim().min(1),
  evidenceLineIds: z.array(z.string()),
  reason: z.string(),
  confidence: z.number().min(0).max(1)
}).strict();

const responsesAgentReviewItemSchema = z.object({
  id: z.string().trim().min(1),
  subquestionId: z.string(),
  kind: z.enum(["readability", "conflict", "missing_evidence", "tool_failure"]),
  region: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  reason: z.string()
}).strict();

/** Final strict payload for the stateless, tool-capable large-question Agent. */
export const responsesAgentGradeSchema = z.object({
  transcription: responsesAgentTranscriptionSchema,
  finalAnswerJudgements: z.array(responsesAgentFinalAnswerSchema),
  decisions: z.array(responsesAgentDecisionSchema),
  appliedDeductions: z.array(responsesAgentDeductionSchema),
  review_required: z.boolean(),
  review_items: z.array(responsesAgentReviewItemSchema),
  final_basis: z.array(z.string())
}).strict();

export type ResponsesAgentGrade = z.infer<typeof responsesAgentGradeSchema>;

const responsesAgentVerifierConflictSchema = z.object({
  subquestionId: z.string().trim().min(1),
  /** Strict Responses schemas require every property; use null when the
   * conflict concerns a subquestion final answer rather than a point. */
  pointId: z.string().trim().min(1).nullable(),
  kind: z.enum(["final_answer", "score_point", "evidence"]),
  primaryStatus: z.string().trim().min(1),
  verifierStatus: z.string().trim().min(1),
  evidenceLineIds: z.array(z.string()),
  reason: z.string().trim().min(1)
}).strict();

/** Fresh-context advisory review for high-risk teacher-Agent decisions. */
export const responsesAgentVerifierSchema = z.object({
  verdict: z.enum(["agree", "conflict", "uncertain"]),
  review_required: z.boolean(),
  summary: z.string(),
  conflicts: z.array(responsesAgentVerifierConflictSchema)
}).strict();

export type ResponsesAgentVerifier = z.infer<typeof responsesAgentVerifierSchema>;

export const processJudgementSchema = z.object({
  decisions: z.array(z.object({
    subquestionId: z.string(),
    pointId: z.string(),
    status: z.enum(["satisfied", "not_satisfied", "not_present", "unreadable", "insufficient_evidence"]),
    evidenceLineIds: z.array(z.string()),
    evidenceQuote: z.string(),
    reason: z.string(),
    confidence: z.number().min(0).max(1),
    requiresReview: z.boolean(),
    awardedScore: z.number().nonnegative().optional().nullable().transform((value) => value ?? undefined),
    reviewReason: z.string().optional()
  })),
  appliedDeductions: z.array(z.object({
    subquestionId: z.string(),
    ruleId: z.string(),
    evidenceLineIds: z.array(z.string()),
    reason: z.string(),
    confidence: z.number().min(0).max(1)
  })).default([])
});

const directVisualReviewPlanItemSchema = z.object({
  review_id: z.string().trim().min(1),
  block_id: z.string().trim().min(1),
  criterion_id: z.string().trim().min(1),
  target: z.string(),
  recognized: z.string(),
  candidates: z.array(z.string()).min(2),
  reason: z.string(),
  score_effect: z.array(z.object({
    candidate: z.string(),
    score: z.number()
  })).min(2)
});

const directVisualReviewPlanSchema = z.object({
  review_required: z.boolean().default(false),
  review_items: z.array(directVisualReviewPlanItemSchema).default([])
});

const directVisionTranscriptionLineSchema = z.object({
  block_id: z.string().trim().min(1),
  text: z.string(),
  latex: z.string().optional(),
  status: z.enum(["active", "crossed_out", "uncertain"]),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(z.string()).default([])
});

const directVisionTranscriptionSchema = z.object({
  lines: z.array(directVisionTranscriptionLineSchema).default([])
});

export const directVisionGradeCoreSchema = z.object({
  evidence: evidenceSchema,
  transcription: directVisionTranscriptionSchema.optional(),
  finalAnswerJudgements: finalAnswerJudgementsSchema.shape.finalAnswerJudgements,
  decisions: processJudgementSchema.shape.decisions,
  appliedDeductions: processJudgementSchema.shape.appliedDeductions,
  ...directVisualReviewPlanSchema.shape
});

const compactPointJudgementBaseSchema = z.object({
  pointKey: z.string().trim().min(1),
  evidenceLineIds: z.array(z.string()).default([]),
  reason: z.string(),
  confidence: z.number().min(0).max(1)
}).strict();

const compactSatisfiedPointJudgementSchema = compactPointJudgementBaseSchema;

const compactNotSatisfiedPointJudgementSchema = compactPointJudgementBaseSchema.extend({
  awardedScore: z.number().nonnegative()
}).strict();

const compactUnreadablePointJudgementSchema = compactPointJudgementBaseSchema;

export const compactDirectVisionGradeSchema = z.object({
  evidence: evidenceSchema,
  transcription: directVisionTranscriptionSchema.optional(),
  finalAnswerJudgements: finalAnswerJudgementsSchema.shape.finalAnswerJudgements,
  pointJudgements: z.object({
    satisfied: z.array(compactSatisfiedPointJudgementSchema).default([]),
    notSatisfied: z.array(compactNotSatisfiedPointJudgementSchema).default([]),
    notPresent: z.array(z.string().trim().min(1)).default([]),
    unreadable: z.array(compactUnreadablePointJudgementSchema).default([])
  }),
  appliedDeductions: processJudgementSchema.shape.appliedDeductions,
  ...directVisualReviewPlanSchema.shape
});

export type CompactDirectVisionGrade = z.infer<typeof compactDirectVisionGradeSchema>;

export type DirectVisualReviewPlanItem = z.infer<typeof directVisualReviewPlanItemSchema>;

export const directVisualReviewSchema = z.object({
  reviews: z.array(z.object({
    review_id: z.string().trim().min(1),
    result: z.string(),
    certainty: z.enum(["clear", "uncertain", "insufficient_visual_evidence"]),
    reason: z.string().default("")
  })).default([])
});

export const directVisualReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reviews"],
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["review_id", "result", "certainty", "reason"],
        properties: {
          review_id: { type: "string" },
          result: { type: "string" },
          certainty: { type: "string", enum: ["clear", "uncertain", "insufficient_visual_evidence"] },
          reason: { type: "string" }
        }
      }
    }
  }
} as const;

const largeQuestionPointReviewDecisionSchema = z.object({
  pointId: z.string().trim().min(1),
  status: z.enum(["satisfied", "not_satisfied", "not_present", "unreadable"]),
  evidenceBlockIds: z.array(z.string().trim().min(1)),
  evidenceQuote: z.string().default(""),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  awardedScore: z.number().nonnegative().nullable().default(null)
}).strict();

const largeQuestionPointReviewDeductionSchema = z.object({
  ruleId: z.string().trim().min(1),
  evidenceBlockIds: z.array(z.string().trim().min(1)),
  evidenceQuote: z.string().default(""),
  reason: z.string(),
  confidence: z.number().min(0).max(1)
}).strict();

const largeQuestionPointReviewItemSchema = z.object({
  subquestionId: z.string().trim().min(1),
  decisions: z.array(largeQuestionPointReviewDecisionSchema),
  appliedDeductions: z.array(largeQuestionPointReviewDeductionSchema).default([])
}).strict();

/** Point review is only sent for subquestions whose first final-answer read is not safe. */
export const largeQuestionPointReviewSchema = z.object({
  reviews: z.array(largeQuestionPointReviewItemSchema)
}).strict();

export type LargeQuestionPointReview = z.infer<typeof largeQuestionPointReviewSchema>;

const teacherCommentaryLossPointSchema = z.object({
  subquestionId: z.string(),
  pointId: z.string(),
  scoreLost: z.number().nonnegative(),
  reason: z.string(),
  evidenceLineIds: z.array(z.string())
});

const teacherCommentaryAuditConcernSchema = z.object({
  subquestionId: z.string(),
  pointId: z.string().optional(),
  kind: z.enum(["confirmed_issue", "uncertain_evidence"]),
  reason: z.string(),
  evidenceLineIds: z.array(z.string())
});

export const teacherCommentarySchema = z.object({
  overallComment: z.string(),
  strengths: z.array(z.string()).default([]),
  lostPoints: z.array(teacherCommentaryLossPointSchema).default([]),
  auditConcerns: z.array(teacherCommentaryAuditConcernSchema).default([]),
  reviewItems: z.array(z.string()).default([]),
  basedOnDecisionIds: z.array(z.string()).default([])
});

export const directVisionGradeSchema = directVisionGradeCoreSchema.extend({
  teacherCommentary: teacherCommentarySchema
});

export const processJudgementWithCommentarySchema = processJudgementSchema.extend({
  teacherCommentary: teacherCommentarySchema
});

export const smallQuestionGradeSchema = z.object({
  finalAnswerJudgements: finalAnswerJudgementsSchema.shape.finalAnswerJudgements,
  decisions: processJudgementSchema.shape.decisions,
  appliedDeductions: processJudgementSchema.shape.appliedDeductions,
  teacherCommentary: teacherCommentarySchema
});

export const smallQuestionDisputeArbitrationItemSchema = z.object({
  subquestionId: z.string(),
  confirmedStatus: z.enum(["correct", "incorrect", "uncertain"]),
  studentHandwrittenEvidence: z.string().default(""),
  overridesInitialJudgement: z.boolean(),
  reason: z.string(),
  confidence: z.number().min(0).max(1)
}).strict();

export const smallQuestionDisputeArbitrationSchema = z.object({
  arbitrations: z.array(smallQuestionDisputeArbitrationItemSchema).default([])
}).strict();

export type SmallQuestionDisputeArbitration = z.infer<typeof smallQuestionDisputeArbitrationSchema>;

const unreadableLocalReviewItemSchema = z.object({
  subquestionId: z.string(),
  pointId: z.string(),
  status: z.enum(["satisfied", "not_satisfied", "not_present", "unreadable"]),
  evidenceLineIds: z.array(z.string()).default([]),
  evidenceQuote: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  requiresReview: z.boolean()
});

export const unreadableLocalReviewSchema = z.object({
  reviews: z.array(unreadableLocalReviewItemSchema).default([]),
  finalAnswers: z.array(z.object({
    subquestionId: z.string(),
    status: z.enum(["correct", "incorrect", "missing", "uncertain"]),
    evidenceLineIds: z.array(z.string()).default([]),
    studentAnswer: z.string(),
    reason: z.string(),
    confidence: z.number().min(0).max(1),
    requiresReview: z.boolean(),
    decisionSource: z.literal("unreadable_local_review").optional()
  })).default([])
});

export type UnreadableLocalReview = z.infer<typeof unreadableLocalReviewSchema>;

export const unreadableLocalReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reviews", "finalAnswers"],
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "pointId", "status", "evidenceLineIds", "evidenceQuote", "reason", "confidence", "requiresReview"],
        properties: {
          subquestionId: { type: "string" },
          pointId: { type: "string" },
          status: { type: "string", enum: ["satisfied", "not_satisfied", "not_present", "unreadable"] },
          evidenceLineIds: { type: "array", items: { type: "string" } },
          evidenceQuote: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number" },
          requiresReview: { type: "boolean" }
        }
      }
    },
    finalAnswers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "status", "evidenceLineIds", "studentAnswer", "reason", "confidence", "requiresReview"],
        properties: {
          subquestionId: { type: "string" },
          status: { type: "string", enum: ["correct", "incorrect", "missing", "uncertain"] },
          evidenceLineIds: { type: "array", items: { type: "string" } },
          studentAnswer: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number" },
          requiresReview: { type: "boolean" }
        }
      }
    }
  }
} as const;

export const localNumericAnswerReviewSchema = z.object({
  reviews: z.array(z.object({
    subquestionId: z.string(),
    observedAnswer: z.string(),
    numericTokens: z.array(z.string()).default([]),
    status: z.enum(["readable", "unreadable"]),
    confidence: z.number().min(0).max(1),
    reason: z.string()
  })).default([])
});

export const localNumericAnswerReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reviews"],
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "observedAnswer", "numericTokens", "status", "confidence", "reason"],
        properties: {
          subquestionId: { type: "string" },
          observedAnswer: { type: "string" },
          numericTokens: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["readable", "unreadable"] },
          confidence: { type: "number" },
          reason: { type: "string" }
        }
      }
    }
  }
} as const;

export function validateRubricTotals<T extends z.infer<typeof rubricSchema>>(rubric: T): T {
  const warnings = [...rubric.warnings];
  const subquestionTotal = rubric.subquestions.reduce((sum, item) => sum + item.maxScore, 0);
  if (subquestionTotal !== rubric.totalScore) {
    warnings.push(`小问满分合计 ${subquestionTotal} 分，与总分 ${rubric.totalScore} 分不一致`);
  }
  for (const subquestion of rubric.subquestions) {
    const pointTotal = subquestion.scorePoints.reduce((sum, item) => sum + item.score, 0);
    if (pointTotal !== subquestion.maxScore) {
      warnings.push(`${subquestion.title}的评分点合计 ${pointTotal} 分，与小问满分 ${subquestion.maxScore} 分不一致`);
    }
  }
  return { ...rubric, warnings };
}

export function assertRubricIntegrity(rubric: Rubric): void {
  const errors: string[] = [];
  const subquestionIds = new Set<string>();
  const subquestionTotal = rubric.subquestions.reduce((sum, item) => sum + item.maxScore, 0);

  if (rubric.subquestions.length === 0) {
    errors.push("至少需要一个小题");
  }
  if (Math.abs(subquestionTotal - rubric.totalScore) > 1e-9) {
    errors.push(`小题满分合计 ${subquestionTotal} 分，与总分 ${rubric.totalScore} 分不一致`);
  }

  for (const subquestion of rubric.subquestions) {
    if (subquestionIds.has(subquestion.id)) {
      errors.push(`小题ID重复：${subquestion.id}`);
    }
    subquestionIds.add(subquestion.id);

    const pointIds = new Set<string>();
    const pointTotal = subquestion.scorePoints.reduce((sum, item) => sum + item.score, 0);
    if (Math.abs(pointTotal - subquestion.maxScore) > 1e-9) {
      errors.push(`${subquestion.title}的评分点合计 ${pointTotal} 分，与小题满分 ${subquestion.maxScore} 分不一致`);
    }
    if (subquestion.maxScore > 0 && subquestion.scorePoints.length === 0) {
      errors.push(`${subquestion.title}没有评分点，但小题满分大于0`);
    }
    for (const point of subquestion.scorePoints) {
      if (pointIds.has(point.id)) {
        errors.push(`${subquestion.title}的评分点ID重复：${point.id}`);
      }
      pointIds.add(point.id);
    }

    const deductionIds = new Set<string>();
    for (const deduction of subquestion.deductions) {
      if (deductionIds.has(deduction.id)) {
        errors.push(`${subquestion.title}的扣分规则ID重复：${deduction.id}`);
      }
      deductionIds.add(deduction.id);
    }
  }

  if (errors.length > 0) {
    throw new Error(`评分标准校验失败：${errors.join("；")}`);
  }
}

export const rubricJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "recognizedQuestionText", "version", "status", "questionType", "totalScore", "subquestions", "warnings"],
  properties: {
    title: { type: "string" },
    recognizedQuestionText: { type: "string" },
    version: { type: "number" },
    status: { type: "string", enum: ["draft"] },
    questionType: { type: "string", enum: ["large", "small"] },
    totalScore: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
    subquestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "maxScore", "finalAnswerPolicy", "finalAnswers", "scorePoints", "deductions"],
        properties: {
          id: { type: "string" }, title: { type: "string" }, maxScore: { type: "number" },
          finalAnswerPolicy: { type: "string", enum: ["full_credit", "process_required"] },
          finalAnswers: { type: "array", items: { type: "object", additionalProperties: false, required: ["expression", "unit", "label", "signPolicy", "positiveDirection", "subject", "signConvention"], properties: { expression: { type: "string" }, unit: { type: "string" }, label: { type: "string" }, signPolicy: { type: "string", enum: [...FINAL_ANSWER_SIGN_POLICIES] }, positiveDirection: { type: "string" }, subject: { type: "string" }, signConvention: { type: "string" } } } },
          scorePoints: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "description", "score", "type", "expected", "commonResponses", "alternativeMethods", "acceptedEquivalents"], properties: { id: { type: "string" }, title: { type: "string" }, description: { type: "string" }, score: { type: "number" }, type: { type: "string", enum: ["formula", "substitution", "result", "text"] }, expected: { type: "string" }, commonResponses: { type: "array", items: { type: "string" } }, alternativeMethods: { type: "array", items: { type: "string" } }, acceptedEquivalents: { type: "array", items: { type: "string" } } } } },
          deductions: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "reason", "deduct", "exclusiveGroup"], properties: { id: { type: "string" }, reason: { type: "string" }, deduct: { type: "number" }, exclusiveGroup: { type: "string" } } } }
        }
      }
    }
  }
} as const;

const answerLineJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "text", "latex", "region", "status", "confidence", "alternatives"],
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    latex: { type: "string" },
    region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
    status: { type: "string", enum: ["active", "crossed_out", "uncertain"] },
    confidence: { type: "number" },
    alternatives: { type: "array", items: { type: "string" } }
  }
} as const;

const answerAmbiguityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lineId", "reason", "scoreImpact"],
  properties: {
    lineId: { type: "string" },
    reason: { type: "string" },
    scoreImpact: { type: "string", enum: ["none", "possible", "certain"] }
  }
} as const;

export const studentAnswerReconstructionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lines", "ambiguities", "status", "reviewReasons"],
  properties: {
    lines: { type: "array", items: answerLineJsonSchema },
    ambiguities: { type: "array", items: answerAmbiguityJsonSchema },
    status: { type: "string", enum: ["clear", "review"] },
    reviewReasons: { type: "array", items: { type: "string" } }
  }
} as const;

export const evidenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lines", "finalAnswers", "ambiguities"],
  properties: {
    lines: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text", "latex", "region", "status", "confidence", "alternatives"], properties: { id: { type: "string" }, text: { type: "string" }, latex: { type: "string" }, region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 }, status: { type: "string", enum: ["active", "crossed_out", "uncertain"] }, confidence: { type: "number" }, alternatives: { type: "array", items: { type: "string" } } } } },
    finalAnswers: { type: "array", items: { type: "object", additionalProperties: false, required: ["subquestionId", "lineId", "expression", "unit", "confidence"], properties: { subquestionId: { type: "string" }, lineId: { type: "string" }, expression: { type: "string" }, unit: { type: "string" }, confidence: { type: "number" } } } },
    ambiguities: { type: "array", items: { type: "object", additionalProperties: false, required: ["lineId", "reason", "scoreImpact"], properties: { lineId: { type: "string" }, reason: { type: "string" }, scoreImpact: { type: "string", enum: ["none", "possible", "certain"] } } } }
  }
} as const;

const finalAnswerJudgementJsonItem = {
  type: "object",
  additionalProperties: false,
  required: ["subquestionId", "status", "answerPresence", "evidenceLineIds", "studentAnswer", "referenceAnswer", "reason", "confidence"],
  properties: {
    subquestionId: { type: "string" },
    status: { type: "string", enum: ["correct", "incorrect", "missing", "uncertain"] },
    answerPresence: { type: "string", enum: ["no_effective_answer", "probable_answer", "confirmed_answer", "unreadable_answer", "image_unreliable"] },
    evidenceLineIds: { type: "array", items: { type: "string" } },
    studentAnswer: { type: "string" },
    referenceAnswer: { type: "string" },
    reason: { type: "string" },
    confidence: { type: "number" }
  }
} as const;

export const finalAnswerJudgementsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["finalAnswerJudgements"],
  properties: {
    finalAnswerJudgements: { type: "array", items: finalAnswerJudgementJsonItem }
  }
} as const;

export const largeQuestionAnswerTriageJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answers", "transcription"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "blockIds", "status", "answerPresence", "studentAnswer", "coordinate", "confidence", "reason"],
        properties: {
          subquestionId: { type: "string" },
          blockIds: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["correct", "incorrect", "missing", "uncertain"] },
          answerPresence: { type: "string", enum: ["no_effective_answer", "probable_answer", "confirmed_answer", "unreadable_answer", "image_unreliable"] },
          studentAnswer: { type: "string" },
          coordinate: {
            type: ["array", "null"],
            items: { type: "number", minimum: 0, maximum: 1000 },
            minItems: 4,
            maxItems: 4,
            description: "该小问最终答案在预处理答卷图上的 0..1000 归一化矩形边界框 [x1, y1, x2, y2]；未作答或未找到填 null"
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" }
        }
      }
    },
    transcription: {
      type: "object",
      additionalProperties: false,
      required: ["lines"],
      properties: {
        lines: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["blockId", "text", "latex", "status", "confidence", "alternatives"],
            properties: {
              blockId: { type: "string" },
              text: { type: "string" },
              latex: { type: "string" },
              status: { type: "string", enum: ["active", "crossed_out", "uncertain"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              alternatives: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    }
  }
} as const;

const responsesAgentTranscriptionLineJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "subquestionId", "text", "latex", "region", "status", "confidence", "alternatives", "sourceImageId", "sourceToolCallIds"],
  properties: {
    id: { type: "string" },
    subquestionId: { type: "string" },
    text: { type: "string" },
    latex: { type: "string" },
    region: { type: "array", items: { type: "number", minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 },
    status: { type: "string", enum: ["active", "crossed_out", "uncertain"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    alternatives: { type: "array", items: { type: "string" } },
    sourceImageId: { type: "string" },
    sourceToolCallIds: { type: "array", items: { type: "string" } }
  }
} as const;

export const responsesAgentGradeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["transcription", "finalAnswerJudgements", "decisions", "appliedDeductions", "review_required", "review_items", "final_basis"],
  properties: {
    transcription: {
      type: "object",
      additionalProperties: false,
      required: ["lines", "ambiguities"],
      properties: {
        lines: { type: "array", items: responsesAgentTranscriptionLineJsonSchema },
        ambiguities: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["lineId", "reason", "scoreImpact"],
            properties: {
              lineId: { type: "string" },
              reason: { type: "string" },
              scoreImpact: { type: "string", enum: ["none", "possible", "certain"] }
            }
          }
        }
      }
    },
    finalAnswerJudgements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "status", "answerPresence", "evidenceLineIds", "studentAnswer", "referenceAnswer", "reason", "confidence", "decisionSource"],
        properties: {
          subquestionId: { type: "string" },
          status: { type: "string", enum: ["correct", "incorrect", "missing", "uncertain"] },
          answerPresence: { type: "string", enum: ["no_effective_answer", "probable_answer", "confirmed_answer", "unreadable_answer", "image_unreliable"] },
          evidenceLineIds: { type: "array", items: { type: "string" } },
          studentAnswer: { type: "string" },
          referenceAnswer: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          decisionSource: { type: "string", enum: ["teacher_model"] }
        }
      }
    },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "pointId", "status", "evidenceLineIds", "evidenceQuote", "reason", "confidence", "requiresReview", "awardedScore"],
        properties: {
          subquestionId: { type: "string" },
          pointId: { type: "string" },
          status: { type: "string", enum: ["satisfied", "not_satisfied", "not_present", "unreadable", "insufficient_evidence"] },
          evidenceLineIds: { type: "array", items: { type: "string" } },
          evidenceQuote: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          requiresReview: { type: "boolean" },
          awardedScore: { type: "number", minimum: 0 }
        }
      }
    },
    appliedDeductions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "ruleId", "evidenceLineIds", "reason", "confidence"],
        properties: {
          subquestionId: { type: "string" },
          ruleId: { type: "string" },
          evidenceLineIds: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    },
    review_required: { type: "boolean" },
    review_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "subquestionId", "kind", "region", "reason"],
        properties: {
          id: { type: "string" },
          subquestionId: { type: "string" },
          kind: { type: "string", enum: ["readability", "conflict", "missing_evidence", "tool_failure"] },
          region: { type: ["array", "null"], items: { type: "number", minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 },
          reason: { type: "string" }
        }
      }
    },
    final_basis: { type: "array", items: { type: "string" } }
  }
} as const;

export const responsesAgentVerifierJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "review_required", "summary", "conflicts"],
  properties: {
    verdict: { type: "string", enum: ["agree", "conflict", "uncertain"] },
    review_required: { type: "boolean" },
    summary: { type: "string" },
    conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
          required: ["subquestionId", "pointId", "kind", "primaryStatus", "verifierStatus", "evidenceLineIds", "reason"],
          properties: {
            subquestionId: { type: "string" },
            pointId: { type: ["string", "null"] },
            kind: { type: "string", enum: ["final_answer", "score_point", "evidence"] },
            primaryStatus: { type: "string" },
            verifierStatus: { type: "string" },
            evidenceLineIds: { type: "array", items: { type: "string" } },
            reason: { type: "string" }
          }
      }
    }
  }
} as const;

export const largeQuestionPointReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reviews"],
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "decisions", "appliedDeductions"],
        properties: {
          subquestionId: { type: "string" },
          decisions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
                  required: ["pointId", "status", "evidenceBlockIds", "evidenceQuote", "reason", "confidence", "awardedScore"],

              properties: {
                pointId: { type: "string" },
                status: { type: "string", enum: ["satisfied", "not_satisfied", "not_present", "unreadable"] },
                evidenceBlockIds: { type: "array", items: { type: "string" } },
                evidenceQuote: { type: "string" },
                reason: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                awardedScore: { type: ["number", "null"], minimum: 0 }
              }
            }
          },
          appliedDeductions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["ruleId", "evidenceBlockIds", "evidenceQuote", "reason", "confidence"],
              properties: {
                ruleId: { type: "string" },
                evidenceBlockIds: { type: "array", items: { type: "string" } },
                evidenceQuote: { type: "string" },
                reason: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 }
              }
            }
          }
        }
      }
    }
  }
} as const;

export const processJudgementJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decisions", "appliedDeductions"],
  properties: {
    decisions: { type: "array", items: { type: "object", additionalProperties: false, required: ["subquestionId", "pointId", "status", "evidenceLineIds", "evidenceQuote", "reason", "confidence", "requiresReview", "awardedScore", "reviewReason"], properties: { subquestionId: { type: "string" }, pointId: { type: "string" }, status: { type: "string", enum: ["satisfied", "not_satisfied", "not_present", "unreadable", "insufficient_evidence"] }, evidenceLineIds: { type: "array", items: { type: "string" } }, evidenceQuote: { type: "string" }, reason: { type: "string" }, confidence: { type: "number" }, requiresReview: { type: "boolean" }, reviewReason: { type: "string" }, awardedScore: { type: ["number", "null"], minimum: 0 } } } },
    appliedDeductions: { type: "array", items: { type: "object", additionalProperties: false, required: ["subquestionId", "ruleId", "evidenceLineIds", "reason", "confidence"], properties: { subquestionId: { type: "string" }, ruleId: { type: "string" }, evidenceLineIds: { type: "array", items: { type: "string" } }, reason: { type: "string" }, confidence: { type: "number" } } } }
  }
} as const;

const directVisionGradeCoreJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["evidence", "transcription", "finalAnswerJudgements", "decisions", "appliedDeductions", "review_required", "review_items"],
  properties: {
    evidence: evidenceJsonSchema,
    transcription: {
      type: "object",
      additionalProperties: false,
      required: ["lines"],
      properties: {
        lines: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["block_id", "text", "latex", "status", "confidence", "alternatives"],
            properties: {
              block_id: { type: "string" },
              text: { type: "string" },
              latex: { type: "string" },
              status: { type: "string", enum: ["active", "crossed_out", "uncertain"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              alternatives: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    },
    finalAnswerJudgements: finalAnswerJudgementsJsonSchema.properties.finalAnswerJudgements,
    decisions: processJudgementJsonSchema.properties.decisions,
    appliedDeductions: processJudgementJsonSchema.properties.appliedDeductions,
    review_required: { type: "boolean" },
    review_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["review_id", "block_id", "criterion_id", "target", "recognized", "candidates", "reason", "score_effect"],
        properties: {
          review_id: { type: "string" },
          block_id: { type: "string" },
          criterion_id: { type: "string" },
          target: { type: "string" },
          recognized: { type: "string" },
          candidates: { type: "array", minItems: 2, items: { type: "string" } },
          reason: { type: "string" },
          score_effect: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["candidate", "score"],
              properties: {
                candidate: { type: "string" },
                score: { type: "number" }
              }
            }
          }
        }
      }
    }
  }
} as const;

const compactPointJudgementBaseJsonProperties = {
  pointKey: { type: "string" },
  evidenceLineIds: { type: "array", items: { type: "string" } },
  reason: { type: "string" },
  confidence: { type: "number" }
} as const;

const compactSatisfiedPointJudgementJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pointKey", "evidenceLineIds", "reason", "confidence"],
  properties: compactPointJudgementBaseJsonProperties
} as const;

const compactNotSatisfiedPointJudgementJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pointKey", "evidenceLineIds", "reason", "confidence", "awardedScore"],
  properties: {
    ...compactPointJudgementBaseJsonProperties,
    awardedScore: { type: "number", minimum: 0 }
  }
} as const;

const compactUnreadablePointJudgementJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pointKey", "evidenceLineIds", "reason", "confidence"],
  properties: compactPointJudgementBaseJsonProperties
} as const;

export const compactDirectVisionGradeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["evidence", "transcription", "finalAnswerJudgements", "pointJudgements", "appliedDeductions", "review_required", "review_items"],
  properties: {
    evidence: evidenceJsonSchema,
    transcription: directVisionGradeCoreJsonSchema.properties.transcription,
    finalAnswerJudgements: finalAnswerJudgementsJsonSchema.properties.finalAnswerJudgements,
    pointJudgements: {
      type: "object",
      additionalProperties: false,
      required: ["satisfied", "notSatisfied", "notPresent", "unreadable"],
      properties: {
        satisfied: { type: "array", items: compactSatisfiedPointJudgementJsonSchema },
        notSatisfied: { type: "array", items: compactNotSatisfiedPointJudgementJsonSchema },
        notPresent: { type: "array", items: { type: "string" } },
        unreadable: { type: "array", items: compactUnreadablePointJudgementJsonSchema }
      }
    },
    appliedDeductions: processJudgementJsonSchema.properties.appliedDeductions,
    review_required: { type: "boolean" },
    review_items: directVisionGradeCoreJsonSchema.properties.review_items
  }
} as const;

export const teacherCommentaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["overallComment", "strengths", "lostPoints", "auditConcerns", "reviewItems", "basedOnDecisionIds"],
  properties: {
    overallComment: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    lostPoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "pointId", "scoreLost", "reason", "evidenceLineIds"],
        properties: {
          subquestionId: { type: "string" }, pointId: { type: "string" }, scoreLost: { type: "number" },
          reason: { type: "string" }, evidenceLineIds: { type: "array", items: { type: "string" } }
        }
      }
    },
    auditConcerns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "pointId", "kind", "reason", "evidenceLineIds"],
        properties: {
          subquestionId: { type: "string" }, pointId: { type: "string" },
          kind: { type: "string", enum: ["confirmed_issue", "uncertain_evidence"] },
          reason: { type: "string" }, evidenceLineIds: { type: "array", items: { type: "string" } }
        }
      }
    },
    reviewItems: { type: "array", items: { type: "string" } },
    basedOnDecisionIds: { type: "array", items: { type: "string" } }
  }
} as const;

export const directVisionGradeJsonSchema = {
  ...directVisionGradeCoreJsonSchema,
  required: [...directVisionGradeCoreJsonSchema.required, "teacherCommentary"],
  properties: {
    ...directVisionGradeCoreJsonSchema.properties,
    teacherCommentary: teacherCommentaryJsonSchema
  }
} as const;

export const processJudgementWithCommentaryJsonSchema = {
  ...processJudgementJsonSchema,
  required: [...processJudgementJsonSchema.required, "teacherCommentary"],
  properties: {
    ...processJudgementJsonSchema.properties,
    teacherCommentary: teacherCommentaryJsonSchema
  }
} as const;

export const smallQuestionGradeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["finalAnswerJudgements", "decisions", "appliedDeductions", "teacherCommentary"],
  properties: {
    finalAnswerJudgements: finalAnswerJudgementsJsonSchema.properties.finalAnswerJudgements,
    decisions: processJudgementJsonSchema.properties.decisions,
    appliedDeductions: processJudgementJsonSchema.properties.appliedDeductions,
    teacherCommentary: teacherCommentaryJsonSchema
  }
} as const;

export const smallQuestionDisputeArbitrationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["arbitrations"],
  properties: {
    arbitrations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "confirmedStatus", "studentHandwrittenEvidence", "overridesInitialJudgement", "reason", "confidence"],
        properties: {
          subquestionId: { type: "string" },
          confirmedStatus: { type: "string", enum: ["correct", "incorrect", "uncertain"] },
          studentHandwrittenEvidence: { type: "string" },
          overridesInitialJudgement: { type: "boolean" },
          reason: { type: "string" },
          confidence: { type: "number" }
        }
      }
    }
  }
} as const;
