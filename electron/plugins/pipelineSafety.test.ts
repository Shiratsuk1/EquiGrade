import { describe, expect, it } from "vitest";
import { assertSameAnswer, commitFailureMessage, failureRequiresPause } from "./pipelineSafety.js";
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
});
