import { describe, expect, it } from "vitest";
import { normalizeFinalAnswerJudgement } from "./finalAnswerNormalization.js";

function judgement(overrides: Partial<Parameters<typeof normalizeFinalAnswerJudgement>[0]> = {}) {
  return {
    subquestionId: "1",
    status: "uncertain" as const,
    evidenceLineIds: [],
    studentAnswer: "",
    referenceAnswer: "2 m/s",
    reason: "线条不清晰，字迹过于模糊，疑似存在痕迹",
    confidence: 0.2,
    ...overrides
  };
}

describe("final answer presence normalization", () => {
  it("turns vague unreadable claims without answer evidence into missing", () => {
    const result = normalizeFinalAnswerJudgement(judgement());
    expect(result.judgement.status).toBe("missing");
    expect(result.judgement.answerPresence).toBe("no_effective_answer");
    expect(result.judgement.studentAnswer).toBe("");
    expect(result.judgement.evidenceLineIds).toEqual([]);
    expect(result.reasons).toContain("vague_unreadable_without_candidate_evidence");
  });

  it("keeps a genuinely located but unreadable answer reviewable", () => {
    const result = normalizeFinalAnswerJudgement(judgement({
      evidenceLineIds: ["L1"],
      studentAnswer: "6?",
      reason: "连续数字笔画存在，但无法区分 6 或 8"
    }));
    expect(result.judgement.status).toBe("uncertain");
    expect(result.judgement.answerPresence).toBe("unreadable_answer");
    expect(result.judgement.evidenceLineIds).toEqual(["L1"]);
  });

  it("does not accept incorrect without a locatable answer", () => {
    const result = normalizeFinalAnswerJudgement(judgement({ status: "incorrect", reason: "未读到正确结果" }));
    expect(result.judgement.status).toBe("missing");
    expect(result.reasons).toContain("incorrect_without_answer_evidence");
  });

  it("preserves explicit non-answer artifact classifications", () => {
    const result = normalizeFinalAnswerJudgement(judgement({
      answerPresence: "no_effective_answer",
      status: "uncertain",
      evidenceLineIds: ["shadow"],
      studentAnswer: "扫描阴影"
    }));
    expect(result.judgement.status).toBe("missing");
    expect(result.judgement.evidenceLineIds).toEqual([]);
  });
});
