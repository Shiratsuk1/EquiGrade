import { describe, expect, it } from "vitest";
import { assertSameAnswer, canCommitGradingResult, commitFailureMessage, failureRequiresPause } from "./pipelineSafety.js";
import type { ExtractedAnswer } from "./types.js";

const answer: ExtractedAnswer = {
  pageKey: "sha256:one",
  sourcePageKey: "zhixue:one",
  imageDataUrl: "data:image/png;base64,AA==",
  imageHash: "one",
  imageMimeType: "image/png",
  imageBytes: 1,
  imageSource: "test"
};

describe("pipeline commit safety", () => {
  it("rejects a changed page or image before score writing", () => {
    expect(() => assertSameAnswer(answer, { ...answer, imageHash: "two" })).toThrow("答卷图像已经变化");
    expect(() => assertSameAnswer(answer, { ...answer, sourcePageKey: "zhixue:two" })).toThrow("阅卷页面已经切换");
    expect(() => assertSameAnswer({ ...answer, pageToken: "page-one" }, { ...answer, pageToken: "page-two" })).toThrow("答卷实例已经变化");
    expect(() => assertSameAnswer(answer, { ...answer })).not.toThrow();
  });

  it("requires a pause after any write or submit action starts", () => {
    expect(failureRequiresPause("untouched")).toBe(false);
    expect(failureRequiresPause("write_started")).toBe(true);
    expect(failureRequiresPause("score_written")).toBe(true);
    expect(failureRequiresPause("submit_started")).toBe(true);
    expect(commitFailureMessage("submit_started", "timeout")).toContain("保存状态无法确认");
  });

  it("allows a valid review-marked result to continue to score writing", () => {
    expect(canCommitGradingResult({ status: "needs_review", score: 6, maxScore: 16 })).toBe(true);
    expect(canCommitGradingResult({ status: "needs_review", score: 6, maxScore: 16, scoreResolved: false })).toBe(true);
    expect(canCommitGradingResult({ status: "completed", score: 16, maxScore: 16 })).toBe(true);
    expect(canCommitGradingResult({ status: "failed", score: 6, maxScore: 16 })).toBe(false);
    expect(canCommitGradingResult({ status: "needs_review", score: 17, maxScore: 16 })).toBe(false);
  });
});
