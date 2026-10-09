import { describe, expect, it } from "vitest";
import { summarizeGradingReliability, summarizeReviewSignals } from "./reviewSignals.js";
import type { GradingResult } from "./types.js";

describe("review signal summary", () => {
  it("counts low-confidence evidence across the record without changing the score", () => {
    const result = {
      score: 2,
      reviewReasons: ["关键数字需要核对"],
      evidence: {
        lines: [
          { id: "L1", text: "x=2", status: "active", confidence: 0.59 },
          { id: "L2", text: "y=3", status: "active", confidence: 0.6 }
        ],
        finalAnswers: [],
        ambiguities: []
      },
      subquestions: [{
        id: "Q1",
        title: "第一问",
        score: 2,
        maxScore: 2,
        finalAnswerStatus: "uncertain",
        finalAnswerConfidence: 0.4,
        decisions: [{
          subquestionId: "Q1",
          pointId: "P1",
          status: "unreadable",
          evidenceLineIds: ["L1"],
          evidenceQuote: "x=?",
          reason: "数字不清",
          confidence: 0.5,
          requiresReview: true,
          awardedScore: 0,
          maxScore: 1
        }],
        deductions: []
      }]
    } as unknown as GradingResult;

    expect(summarizeReviewSignals(result)).toEqual({
      lowConfidenceLines: 1,
      lowConfidenceFinalAnswers: 1,
      lowConfidenceDecisions: 1,
      totalLowConfidence: 3,
      reviewReasons: 1
    });
    expect(result.score).toBe(2);
  });

  it("reports a completed, traceable final-answer decision without inventing a confidence score", () => {
    const result = {
      status: "completed",
      score: 2,
      maxScore: 2,
      reviewReasons: [],
      gradingPipeline: "large_question",
      evidence: {
        lines: [{ id: "L1", text: "x=2", status: "active", confidence: 0.98 }],
        finalAnswers: [],
        ambiguities: []
      },
      metrics: { ruleCoverage: 1, evidenceTraceability: 1, autoDecisionRate: 1, ambiguityRate: 0, durationMs: 10 },
      subquestions: [{
        id: "Q1",
        title: "第一问",
        score: 2,
        maxScore: 2,
        finalAnswerStatus: "correct",
        finalAnswerConfidence: 0.98,
        finalAnswerDecisionSource: "teacher_model",
        finalAnswerEvidenceLineIds: ["L1"],
        decisions: [{
          subquestionId: "Q1",
          pointId: "P1",
          status: "not_present",
          evidenceLineIds: [],
          evidenceQuote: "",
          reason: "最终答案正确，直接满分",
          confidence: 0.98,
          requiresReview: false,
          awardedScore: 2,
          maxScore: 2,
          decisionSource: "final_answer_authority",
          scoringDisposition: "not_deducted_by_final_answer"
        }],
        deductions: []
      }]
    } as unknown as GradingResult;

    const summary = summarizeGradingReliability(result);
    expect(summary.level).toBe("reliable");
    expect(summary.finalAnswers).toMatchObject({
      total: 1,
      conclusive: 1,
      traceable: 1,
      missing: 0,
      uncertain: 0,
      missingEvidence: 0,
      bySource: { teacherModel: 1, visualReview: 0, missingTeacherJudgement: 0 }
    });
    expect(summary.processAudit.points).toBe(0);
    expect(summary.processAudit.excludedByFinalAnswerAuthority).toBe(1);
    expect(summary.directFullCreditSubquestions).toBe(1);
    expect(summary.attentionItems).toContainEqual(expect.objectContaining({ tone: "info" }));
  });

  it("keeps unresolved reviews and missing evidence visible as hard review signals", () => {
    const result = {
      status: "needs_review",
      score: 0,
      maxScore: 2,
      reviewReasons: ["局部笔迹仍无法确认"],
      gradingPipeline: "large_question",
      evidence: {
        lines: [{ id: "L1", text: "x=?", status: "uncertain", confidence: 0.4 }],
        finalAnswers: [],
        ambiguities: []
      },
      metrics: { ruleCoverage: 1, evidenceTraceability: 0, autoDecisionRate: 0, ambiguityRate: 1, durationMs: 10 },
      directVisualReviewAudit: {
        reviewRequired: true,
        reviewItems: [{ reviewId: "R1", blockId: "B1", criterionId: "Q1:final", target: "最终答案", recognized: "?", candidates: [], reason: "不清", scoreEffect: {} }],
        results: [{ reviewId: "R1", result: "uncertain", certainty: "uncertain", reason: "仍不清" }],
        initialScore: 0,
        initialSubquestionScores: [],
        durationMs: 10
      },
      subquestions: [{
        id: "Q1",
        title: "第一问",
        score: 0,
        maxScore: 2,
        finalAnswerStatus: "uncertain",
        finalAnswerConfidence: 0,
        finalAnswerDecisionSource: "visual_local_review",
        finalAnswerEvidenceLineIds: [],
        decisions: [{
          subquestionId: "Q1",
          pointId: "P1",
          status: "unreadable",
          evidenceLineIds: [],
          evidenceQuote: "",
          reason: "无法辨认",
          confidence: 0,
          requiresReview: true,
          awardedScore: 0,
          maxScore: 2,
          decisionSource: "large_question_point_review",
          scoringDisposition: "not_awarded"
        }],
        deductions: []
      }]
    } as unknown as GradingResult;

    const summary = summarizeGradingReliability(result);
    expect(summary.level).toBe("review");
    expect(summary.visualReview).toEqual({ triggered: 1, resolved: 0, unresolved: 1 });
    expect(summary.pendingReviewItems).toBe(2);
    expect(summary.attentionItems).toEqual(expect.arrayContaining([
      { tone: "warning", text: "局部笔迹仍无法确认" },
      { tone: "warning", text: "1 项局部视觉复核未得到明确结论。" }
    ]));
  });

  it("does not treat an unaudited not-present decision as traceable or reliable", () => {
    const result = {
      status: "completed",
      score: 0,
      maxScore: 2,
      reviewReasons: [],
      gradingPipeline: "large_question",
      evidence: {
        lines: [{ id: "L1", text: "过程仍在答卷上", status: "active", confidence: 0.98 }],
        finalAnswers: [],
        ambiguities: []
      },
      subquestions: [{
        id: "Q1",
        title: "第一问",
        score: 0,
        maxScore: 2,
        finalAnswerStatus: "incorrect",
        finalAnswerConfidence: 0.98,
        finalAnswerDecisionSource: "teacher_model",
        finalAnswerEvidenceLineIds: ["L1"],
        decisions: [{
          subquestionId: "Q1",
          pointId: "P1",
          status: "not_present",
          evidenceLineIds: [],
          evidenceQuote: "",
          reason: "没有找到对应过程",
          confidence: 0.98,
          requiresReview: false,
          awardedScore: 0,
          maxScore: 2,
          decisionSource: "model"
        }],
        deductions: []
      }]
    } as unknown as GradingResult;

    const summary = summarizeGradingReliability(result);
    expect(summary.level).toBe("review");
    expect(summary.processAudit).toMatchObject({
      points: 1,
      traceablePoints: 0,
      missingEvidencePoints: 1,
      unauditedNotPresent: 1,
      syntheticMissing: 0
    });
    expect(summary.pendingReviewItems).toBe(1);
    expect(summary.riskSignals.missingEvidence).toBe(1);
    expect(summary.attentionItems).toContainEqual(expect.objectContaining({
      text: "有 1 个“未作答”判定没有缺失审验证据，不能视为已确认未作答。"
    }));
  });

  it("keeps synthetic missing rows out of process ratios while exposing them as a review risk", () => {
    const result = {
      status: "needs_review",
      score: 0,
      maxScore: 2,
      reviewReasons: ["评分点缺少判断结果"],
      gradingPipeline: "large_question",
      evidence: { lines: [], finalAnswers: [], ambiguities: [] },
      subquestions: [{
        id: "Q1",
        title: "第一问",
        score: 0,
        maxScore: 2,
        finalAnswerStatus: "uncertain",
        finalAnswerDecisionSource: "missing_teacher_judgement",
        finalAnswerEvidenceLineIds: [],
        decisions: [{
          subquestionId: "Q1",
          pointId: "P1",
          status: "not_present",
          evidenceLineIds: [],
          evidenceQuote: "",
          reason: "系统补齐",
          confidence: 0,
          requiresReview: true,
          awardedScore: 0,
          maxScore: 2,
          decisionSource: "synthetic_missing"
        }],
        deductions: []
      }]
    } as unknown as GradingResult;

    const summary = summarizeGradingReliability(result);
    expect(summary.level).toBe("review");
    expect(summary.processAudit).toMatchObject({
      points: 0,
      traceablePoints: 0,
      missingEvidencePoints: 0,
      syntheticMissing: 1,
      excludedByFinalAnswerAuthority: 0
    });
    expect(summary.finalAnswers).toMatchObject({
      conclusive: 0,
      traceable: 0,
      missingEvidence: 0,
      bySource: { missingTeacherJudgement: 1 }
    });
    expect(summary.attentionItems).toContainEqual(expect.objectContaining({
      text: "有 1 个评分点由系统补齐缺失判断，未计入过程追溯率。"
    }));
  });
});
