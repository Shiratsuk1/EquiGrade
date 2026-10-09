import { describe, expect, it } from "vitest";
import type { PaddleOcrAudit, PaddleOcrLayoutBlock } from "../shared/types.js";
import { usableOcrBlocks, hasExplicitMissingAudit } from "./largeQuestionGrading.js";

function block(
  blockId: string,
  label: string,
  coordinate: [number, number, number, number]
): PaddleOcrLayoutBlock {
  return {
    blockId,
    pageIndex: 0,
    label,
    score: 0.9,
    coordinate,
    polygonPoints: [],
    order: 0
  };
}

function audit(layoutBlocks: PaddleOcrLayoutBlock[]): PaddleOcrAudit {
  return {
    provider: "paddleocr",
    model: "test",
    jobId: "job",
    rawJsonl: "",
    markdownText: "",
    durationMs: 1,
    imageWidth: 100,
    imageHeight: 100,
    layoutBlocks
  };
}

describe("large-question OCR evidence blocks", () => {
  it("keeps valid header and table blocks because labels are only hints", () => {
    const result = usableOcrBlocks(audit([
      block("header-answer", "header", [1, 1, 30, 20]),
      block("table-answer", "table", [2, 25, 70, 80])
    ]));

    expect(result.map((item) => item.blockId)).toEqual(["header-answer", "table-answer"]);
  });

  it("rejects invalid, out-of-bounds, empty and duplicate evidence blocks", () => {
    const result = usableOcrBlocks(audit([
      block("valid", "text", [1, 1, 20, 20]),
      block("valid", "table", [30, 30, 50, 50]),
      block("reversed", "text", [20, 20, 10, 10]),
      block("outside", "text", [90, 90, 120, 120]),
      block("", "text", [1, 1, 20, 20])
    ]));

    expect(result.map((item) => item.blockId)).toEqual(["valid"]);
  });
});

describe("hasExplicitMissingAudit", () => {
  it("recognizes natural Chinese absence reasons with search scope", () => {
    expect(hasExplicitMissingAudit("检查整页答卷，学生未综合写出外力的大小范围 60 N<=F<=180 N。")).toBe(true);
    expect(hasExplicitMissingAudit("逐块检查整页答卷（block-02至block-03），学生仅在平衡方程中直接使用符号 kΔx，未发现单独计算弹簧伸长量及弹簧弹力 T=80 N 的过程。")).toBe(true);
    expect(hasExplicitMissingAudit("通读全卷，学生未单独列出支持力方程。")).toBe(true);
    expect(hasExplicitMissingAudit("遍历所有区块，未给出牛顿第二定律表达式。")).toBe(true);
    expect(hasExplicitMissingAudit("核对答卷各区块，未见相关推导过程。")).toBe(true);
  });

  it("rejects absence statements that lack explicit search scope or absence claim", () => {
    expect(hasExplicitMissingAudit("学生未综合写出外力的大小范围")).toBe(false);
    expect(hasExplicitMissingAudit("检查整页答卷，学生写出了 F=20N")).toBe(false);
    expect(hasExplicitMissingAudit("")).toBe(false);
  });
});
