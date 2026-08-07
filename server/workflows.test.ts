import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfigInput, Rubric } from "../shared/types.js";

vi.mock("./modelClient.js", () => ({ callStructured: vi.fn() }));

import { callStructured } from "./modelClient.js";
import { gradeStudentAnswer } from "./workflows.js";

const config: ModelConfigInput = {
  name: "test",
  baseUrl: "https://example.test/v1",
  apiKey: "test",
  visionModel: "teacher-vision",
  textModel: "teacher-text",
  timeoutMs: 1000,
  maxRetries: 0,
  maxConcurrency: 1,
  maxOutputTokens: 4096,
  supportsJsonSchema: true,
  supportsJsonObject: true,
  supportsBase64Images: true,
  enabled: true
};

const rubric: Rubric = {
  title: "测试题",
  recognizedQuestionText: "求结果",
  version: 1,
  status: "locked",
  totalScore: 2,
  warnings: [],
  subquestions: [{
    id: "Q1",
    title: "第一问",
    maxScore: 2,
    finalAnswerPolicy: "process_required",
    finalAnswers: [{ expression: "x=2", tolerance: 0 }],
    scorePoints: [
      { id: "P1", title: "公式", description: "列式", score: 1, type: "formula", expected: "x=1+1" },
      { id: "P2", title: "结果", description: "结果", score: 1, type: "result", expected: "x=2" }
    ],
    deductions: []
  }]
};

const extractionResponse = {
  data: {
    lines: [{ id: "L1", text: "x=2", status: "active", confidence: 0.99, alternatives: [] }],
    finalAnswers: [{ subquestionId: "Q1", lineId: "L1", expression: "x=2", unit: "", confidence: 0.99 }],
    ambiguities: []
  },
  durationMs: 10,
  outputMode: "json_schema"
};

const commentaryResponse = {
  data: {
    overallComment: "能够完成主要公式列写，结果仍有一处需要改进。",
    strengths: ["公式列写清晰"],
    lostPoints: [],
    auditConcerns: [],
    reviewItems: [],
    basedOnDecisionIds: ["Q1:P1", "Q1:P2"]
  },
  durationMs: 8,
  outputMode: "json_schema"
};

describe("gradeStudentAnswer call sequence", () => {
  beforeEach(() => vi.mocked(callStructured).mockReset());

  it("audits every process point even when the teacher judgement is correct", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(extractionResponse)
      .mockResolvedValueOnce({
        data: { finalAnswerJudgements: [{ subquestionId: "Q1", status: "correct", evidenceLineIds: ["L1"], studentAnswer: "x=2", referenceAnswer: "x=2", reason: "答案一致", confidence: 0.99 }] },
        durationMs: 12,
        outputMode: "json_schema"
      })
      .mockResolvedValueOnce({
        data: {
          decisions: [
            { subquestionId: "Q1", pointId: "P1", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=1+1", reason: "公式正确", confidence: 0.98, requiresReview: false, reviewReason: "" },
            { subquestionId: "Q1", pointId: "P2", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=2", reason: "结果正确", confidence: 0.98, requiresReview: false, reviewReason: "" }
          ],
          appliedDeductions: []
        },
        durationMs: 14,
        outputMode: "json_schema"
      })
      .mockResolvedValueOnce(commentaryResponse);

    const { result } = await gradeStudentAnswer(config, {
      id: "all-correct", studentId: "S1", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: Buffer.from("image"), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(4);
    expect(vi.mocked(callStructured).mock.calls.map((call) => call[1].schemaName)).toEqual([
      "answer_evidence",
      "final_answer_judgements",
      "process_point_judgement",
      "teacher_commentary"
    ]);
    expect(result.score).toBe(2);
    expect(result.subquestions[0].decisions.every((item) => item.status === "satisfied")).toBe(true);
    expect(result.subquestions[0].decisions.every((item) => item.scoringDisposition === "not_deducted_by_final_answer")).toBe(true);
    expect(result.teacherCommentary?.status).toBe("completed");
  });

  it("audits process points after an incorrect final-answer judgement and generates commentary", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(extractionResponse)
      .mockResolvedValueOnce({
        data: { finalAnswerJudgements: [{ subquestionId: "Q1", status: "incorrect", evidenceLineIds: ["L1"], studentAnswer: "x=3", referenceAnswer: "x=2", reason: "结果不同", confidence: 0.99 }] },
        durationMs: 12,
        outputMode: "json_schema"
      })
      .mockResolvedValueOnce({
        data: {
          decisions: [
            { subquestionId: "Q1", pointId: "P1", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=1+1", reason: "公式正确", confidence: 0.98, requiresReview: false, reviewReason: "" },
            { subquestionId: "Q1", pointId: "P2", status: "not_satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=3", reason: "结果错误", confidence: 0.98, requiresReview: false, reviewReason: "" }
          ],
          appliedDeductions: []
        },
        durationMs: 14,
        outputMode: "json_schema"
      })
      .mockResolvedValueOnce(commentaryResponse);

    const { result } = await gradeStudentAnswer(config, {
      id: "incorrect", studentId: "S2", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: Buffer.from("image"), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(4);
    expect(vi.mocked(callStructured).mock.calls[2][1].schemaName).toBe("process_point_judgement");
    expect(vi.mocked(callStructured).mock.calls[3][1].schemaName).toBe("teacher_commentary");
    expect(result.score).toBe(1);
  });

  it("keeps the score and uses fallback commentary when commentary generation fails", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(extractionResponse)
      .mockResolvedValueOnce({
        data: { finalAnswerJudgements: [{ subquestionId: "Q1", status: "correct", evidenceLineIds: ["L1"], studentAnswer: "x=2", referenceAnswer: "x=2", reason: "答案一致", confidence: 0.99 }] },
        durationMs: 12,
        outputMode: "json_schema"
      })
      .mockResolvedValueOnce({
        data: {
          decisions: [
            { subquestionId: "Q1", pointId: "P1", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=1+1", reason: "公式正确", confidence: 0.98, requiresReview: false, reviewReason: "" },
            { subquestionId: "Q1", pointId: "P2", status: "insufficient_evidence", evidenceLineIds: ["L1"], evidenceQuote: "x=2", reason: "书写略有覆盖", confidence: 0.6, requiresReview: true, reviewReason: "需核对原卷" }
          ],
          appliedDeductions: []
        },
        durationMs: 14,
        outputMode: "json_schema"
      })
      .mockRejectedValueOnce(new Error("commentary unavailable"));

    const { result } = await gradeStudentAnswer(config, {
      id: "commentary-fallback", studentId: "S3", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: Buffer.from("image"), rubric
    });

    expect(result.score).toBe(2);
    expect(result.status).toBe("needs_review");
    expect(result.teacherCommentary?.status).toBe("fallback");
    expect(result.teacherCommentary?.auditConcerns).toHaveLength(1);
  });

  it("sanitizes commentary references against the actual scoring decisions", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(extractionResponse)
      .mockResolvedValueOnce({
        data: { finalAnswerJudgements: [{ subquestionId: "Q1", status: "incorrect", evidenceLineIds: ["L1"], studentAnswer: "x=3", referenceAnswer: "x=2", reason: "结果不同", confidence: 0.99 }] },
        durationMs: 12,
        outputMode: "json_schema"
      })
      .mockResolvedValueOnce({
        data: {
          decisions: [
            { subquestionId: "Q1", pointId: "P1", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=1+1", reason: "公式正确", confidence: 0.98, requiresReview: false, reviewReason: "" },
            { subquestionId: "Q1", pointId: "P2", status: "not_satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=3", reason: "结果错误", confidence: 0.98, requiresReview: false, reviewReason: "" }
          ],
          appliedDeductions: []
        },
        durationMs: 14,
        outputMode: "json_schema"
      })
      .mockResolvedValueOnce({
        data: {
          overallComment: "模型随意生成的总结",
          strengths: [],
          lostPoints: [
            { subquestionId: "Q1", pointId: "P2", scoreLost: 99, reason: "伪造原因", evidenceLineIds: ["fake"] },
            { subquestionId: "Q1", pointId: "UNKNOWN", scoreLost: 1, reason: "不存在", evidenceLineIds: [] }
          ],
          auditConcerns: [
            { subquestionId: "Q1", pointId: "P2", kind: "uncertain_evidence", reason: "伪造提醒", evidenceLineIds: ["fake"] },
            { subquestionId: "Q1", pointId: "UNKNOWN", kind: "confirmed_issue", reason: "不存在", evidenceLineIds: [] }
          ],
          reviewItems: ["模型新增的复核事项"],
          basedOnDecisionIds: ["Q1:P1", "Q1:P2", "Q1:UNKNOWN"]
        },
        durationMs: 8,
        outputMode: "json_schema"
      });

    const { result } = await gradeStudentAnswer(config, {
      id: "commentary-sanitize", studentId: "S4", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: Buffer.from("image"), rubric
    });

    expect(result.teacherCommentary?.lostPoints).toEqual([{
      subquestionId: "Q1",
      pointId: "P2",
      scoreLost: 1,
      reason: "结果错误",
      evidenceLineIds: ["L1"]
    }]);
    expect(result.teacherCommentary?.auditConcerns).toEqual([{
      subquestionId: "Q1",
      pointId: "P2",
      kind: "confirmed_issue",
      reason: "结果错误",
      evidenceLineIds: ["L1"]
    }]);
    expect(result.teacherCommentary?.basedOnDecisionIds).toEqual(["Q1:P1", "Q1:P2"]);
    expect(result.teacherCommentary?.reviewItems).toEqual(result.reviewReasons);
  });
});
