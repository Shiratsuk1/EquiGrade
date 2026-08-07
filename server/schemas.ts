import { z } from "zod";

const scorePointSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  score: z.number().nonnegative(),
  type: z.enum(["formula", "substitution", "result", "text"]),
  expected: z.string(),
  equivalents: z.array(z.string()).optional().default([])
});

export const rubricSchema = z.object({
  title: z.string(),
  recognizedQuestionText: z.string().default(""),
  version: z.number().int().positive().default(1),
  status: z.enum(["draft", "locked"]).default("draft"),
  totalScore: z.number().nonnegative(),
  subquestions: z.array(z.object({
    id: z.string(),
    title: z.string(),
    maxScore: z.number().nonnegative(),
    finalAnswerPolicy: z.enum(["full_credit", "process_required"]),
    finalAnswers: z.array(z.object({
      expression: z.string(),
      unit: z.string().optional(),
      tolerance: z.number().nonnegative().optional().default(0),
      label: z.string().optional()
    })),
    scorePoints: z.array(scorePointSchema),
    deductions: z.array(z.object({
      id: z.string(),
      reason: z.string(),
      deduct: z.number().nonnegative(),
      exclusiveGroup: z.string()
    })).default([])
  })),
  warnings: z.array(z.string()).default([])
});

export const evidenceSchema = z.object({
  lines: z.array(z.object({
    id: z.string(),
    text: z.string(),
    latex: z.string().optional(),
    region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    status: z.enum(["active", "crossed_out", "uncertain"]),
    confidence: z.number().min(0).max(1),
    alternatives: z.array(z.string()).optional().default([])
  })),
  finalAnswers: z.array(z.object({
    subquestionId: z.string(),
    lineId: z.string(),
    expression: z.string(),
    unit: z.string().optional(),
    confidence: z.number().min(0).max(1)
  })),
  ambiguities: z.array(z.object({
    lineId: z.string().optional(),
    reason: z.string(),
    scoreImpact: z.enum(["none", "possible", "certain"])
  })).default([])
});

const finalAnswerJudgementItemSchema = z.object({
  subquestionId: z.string(),
  status: z.enum(["correct", "incorrect", "missing", "uncertain"]),
  evidenceLineIds: z.array(z.string()),
  studentAnswer: z.string(),
  referenceAnswer: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1)
});

export const finalAnswerJudgementsSchema = z.object({
  finalAnswerJudgements: z.array(finalAnswerJudgementItemSchema)
});

export const processJudgementSchema = z.object({
  decisions: z.array(z.object({
    subquestionId: z.string(),
    pointId: z.string(),
    status: z.enum(["satisfied", "not_satisfied", "insufficient_evidence"]),
    evidenceLineIds: z.array(z.string()),
    evidenceQuote: z.string(),
    reason: z.string(),
    confidence: z.number().min(0).max(1),
    requiresReview: z.boolean(),
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

export const rubricJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "recognizedQuestionText", "version", "status", "totalScore", "subquestions", "warnings"],
  properties: {
    title: { type: "string" },
    recognizedQuestionText: { type: "string" },
    version: { type: "number" },
    status: { type: "string", enum: ["draft"] },
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
          finalAnswers: { type: "array", items: { type: "object", additionalProperties: false, required: ["expression", "unit", "tolerance", "label"], properties: { expression: { type: "string" }, unit: { type: "string" }, tolerance: { type: "number" }, label: { type: "string" } } } },
          scorePoints: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "description", "score", "type", "expected", "equivalents"], properties: { id: { type: "string" }, title: { type: "string" }, description: { type: "string" }, score: { type: "number" }, type: { type: "string", enum: ["formula", "substitution", "result", "text"] }, expected: { type: "string" }, equivalents: { type: "array", items: { type: "string" } } } } },
          deductions: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "reason", "deduct", "exclusiveGroup"], properties: { id: { type: "string" }, reason: { type: "string" }, deduct: { type: "number" }, exclusiveGroup: { type: "string" } } } }
        }
      }
    }
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
  required: ["subquestionId", "status", "evidenceLineIds", "studentAnswer", "referenceAnswer", "reason", "confidence"],
  properties: {
    subquestionId: { type: "string" },
    status: { type: "string", enum: ["correct", "incorrect", "missing", "uncertain"] },
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

export const processJudgementJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decisions", "appliedDeductions"],
  properties: {
    decisions: { type: "array", items: { type: "object", additionalProperties: false, required: ["subquestionId", "pointId", "status", "evidenceLineIds", "evidenceQuote", "reason", "confidence", "requiresReview", "reviewReason"], properties: { subquestionId: { type: "string" }, pointId: { type: "string" }, status: { type: "string", enum: ["satisfied", "not_satisfied", "insufficient_evidence"] }, evidenceLineIds: { type: "array", items: { type: "string" } }, evidenceQuote: { type: "string" }, reason: { type: "string" }, confidence: { type: "number" }, requiresReview: { type: "boolean" }, reviewReason: { type: "string" } } } },
    appliedDeductions: { type: "array", items: { type: "object", additionalProperties: false, required: ["subquestionId", "ruleId", "evidenceLineIds", "reason", "confidence"], properties: { subquestionId: { type: "string" }, ruleId: { type: "string" }, evidenceLineIds: { type: "array", items: { type: "string" } }, reason: { type: "string" }, confidence: { type: "number" } } } }
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
