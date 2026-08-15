import { describe, expect, it } from "vitest";
import type { GradingResult } from "../shared/types.js";
import { countCurrentGradingResults, matchesStoredRecordId, normalizeLegacyReviewState, normalizeUploadedFileName, shouldDeleteAnswerAsset } from "./historyStore.js";

describe("normalizeUploadedFileName", () => {
  it("repairs UTF-8 filenames decoded as Latin-1", () => {
    const mojibake = Buffer.from("学生答卷.png", "utf8").toString("latin1");
    expect(normalizeUploadedFileName(mojibake)).toBe("学生答卷.png");
  });

  it("preserves filenames that are already valid Unicode", () => {
    expect(normalizeUploadedFileName("学生答卷.png")).toBe("学生答卷.png");
  });

  it("does not corrupt genuine non-UTF-8 Latin-1 names", () => {
    expect(normalizeUploadedFileName("résumé.png")).toBe("résumé.png");
  });
});

describe("countCurrentGradingResults", () => {
  it("counts a regrade chain as one current answer", () => {
    expect(countCurrentGradingResults([
      { id: "result-v2", previousResultId: "result-v1" },
      { id: "result-v1" }
    ])).toBe(1);
  });

  it("keeps unrelated answers separate", () => {
    expect(countCurrentGradingResults([{ id: "answer-a" }, { id: "answer-b" }])).toBe(2);
  });
});

describe("history deletion safety", () => {
  const record: { id: string; result: { id: string } } = {
    id: "record-id",
    result: { id: "result-id" }
  };

  it("matches both the storage record id and the result id", () => {
    expect(matchesStoredRecordId(record, new Set(["record-id"]))).toBe(true);
    expect(matchesStoredRecordId(record, new Set(["result-id"]))).toBe(true);
    expect(matchesStoredRecordId(record, new Set(["other"]))).toBe(false);
  });

  it("only removes an answer image after its last record reference is gone", () => {
    expect(shouldDeleteAnswerAsset("answer-shared.png", [{ answerImage: { diskName: "answer-shared.png" } as { diskName: string } }])).toBe(false);
    expect(shouldDeleteAnswerAsset("answer-shared.png", [{ answerImage: { diskName: "answer-other.png" } as { diskName: string } }])).toBe(true);
  });
});

describe("legacy review-state compatibility", () => {
  it("removes only stale review flags attached to clear model decisions", () => {
    const result = {
      id: "legacy-result",
      studentId: "网页答卷 zhixue:c05700c5",
      fileName: "answer.png",
      score: 12,
      maxScore: 20,
      status: "needs_review",
      reviewReasons: ["右端长度符号下标较潦草。"],
      evidence: { lines: [], finalAnswers: [], ambiguities: [] },
      subquestions: [{
        id: "11-1",
        title: "第一问",
        score: 8,
        maxScore: 8,
        finalAnswerStatus: "correct",
        processAuditSummary: { totalPoints: 1, satisfied: 1, notSatisfied: 0, uncertain: 0, reviewRequired: 1 },
        decisions: [{
          subquestionId: "11-1",
          pointId: "11-1-c",
          status: "satisfied",
          evidenceLineIds: ["L1"],
          evidenceQuote: "p0L1S/T=pL3S/T",
          reason: "状态方程正确",
          confidence: 0.95,
          requiresReview: true,
          reviewReason: "右端长度符号下标较潦草。",
          awardedScore: 2,
          maxScore: 2
        }],
        deductions: []
      }],
      metrics: { ruleCoverage: 1, evidenceTraceability: 1, autoDecisionRate: 1, ambiguityRate: 0, durationMs: 1 },
      modelName: "teacher",
      rubricVersion: 1,
      teacherCommentary: {
        overallComment: "批改完成",
        strengths: [],
        lostPoints: [],
        auditConcerns: [],
        reviewItems: ["右端长度符号下标较潦草。"],
        basedOnDecisionIds: ["11-1:11-1-c"],
        status: "completed",
        version: "teacher-commentary-v3"
      }
    } satisfies GradingResult;

    const normalized = normalizeLegacyReviewState(result);

    expect(normalized.status).toBe("completed");
    expect(normalized.reviewReasons).toEqual([]);
    expect(normalized.subquestions[0].decisions[0].requiresReview).toBe(false);
    expect(normalized.subquestions[0].decisions[0].reviewReason).toBeUndefined();
    expect(normalized.subquestions[0].processAuditSummary?.reviewRequired).toBe(0);
    expect(normalized.teacherCommentary?.reviewItems).toEqual([]);
  });

  it("preserves unreadable and independent integrity review reasons", () => {
    const result = {
      id: "real-review",
      studentId: "S",
      fileName: "answer.png",
      score: 0,
      maxScore: 2,
      status: "needs_review",
      reviewReasons: ["卷面仍无法辨认", "过程审验模型调用失败"],
      evidence: { lines: [], finalAnswers: [], ambiguities: [] },
      subquestions: [{
        id: "Q1", title: "第一问", score: 0, maxScore: 2, finalAnswerStatus: "missing",
        decisions: [{
          subquestionId: "Q1", pointId: "P1", status: "unreadable", evidenceLineIds: [], evidenceQuote: "",
          reason: "卷面仍无法辨认", confidence: 0.5, requiresReview: true, reviewReason: "卷面仍无法辨认", awardedScore: 0, maxScore: 2
        }],
        deductions: []
      }],
      metrics: { ruleCoverage: 1, evidenceTraceability: 0, autoDecisionRate: 0, ambiguityRate: 1, durationMs: 1 },
      modelName: "teacher",
      rubricVersion: 1
    } satisfies GradingResult;

    const normalized = normalizeLegacyReviewState(result);

    expect(normalized).toBe(result);
    expect(normalized.status).toBe("needs_review");
    expect(normalized.reviewReasons).toEqual(["卷面仍无法辨认", "过程审验模型调用失败"]);
    expect(normalized.subquestions[0].decisions[0].requiresReview).toBe(true);
  });

  it("keeps a shared reason when another unreadable point still requires review", () => {
    const sharedReason = "关键下标无法辨认";
    const result = {
      id: "shared-reason",
      studentId: "S",
      fileName: "answer.png",
      score: 1,
      maxScore: 2,
      status: "needs_review",
      reviewReasons: [sharedReason],
      evidence: { lines: [], finalAnswers: [], ambiguities: [] },
      subquestions: [{
        id: "Q1", title: "第一问", score: 1, maxScore: 2, finalAnswerStatus: "incorrect",
        decisions: [
          { subquestionId: "Q1", pointId: "P1", status: "satisfied", evidenceLineIds: [], evidenceQuote: "x=1", reason: "正确", confidence: 0.9, requiresReview: true, reviewReason: sharedReason, awardedScore: 1, maxScore: 1 },
          { subquestionId: "Q1", pointId: "P2", status: "unreadable", evidenceLineIds: [], evidenceQuote: "x=?", reason: sharedReason, confidence: 0.5, requiresReview: true, reviewReason: sharedReason, awardedScore: 0, maxScore: 1 }
        ],
        deductions: []
      }],
      metrics: { ruleCoverage: 1, evidenceTraceability: 0.5, autoDecisionRate: 0.5, ambiguityRate: 1, durationMs: 1 },
      modelName: "teacher",
      rubricVersion: 1
    } satisfies GradingResult;

    const normalized = normalizeLegacyReviewState(result);

    expect(normalized.status).toBe("needs_review");
    expect(normalized.reviewReasons).toEqual([sharedReason]);
    expect(normalized.subquestions[0].decisions.map((decision) => decision.requiresReview)).toEqual([false, true]);
  });
});
