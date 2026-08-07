import { describe, expect, it } from "vitest";
import { countCurrentGradingResults, normalizeUploadedFileName } from "./historyStore.js";

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
