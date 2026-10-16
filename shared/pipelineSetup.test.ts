import { describe, expect, it } from "vitest";
import { pipelineFixtureRubric } from "../server/pipelineFixtureData.js";
import { buildPipelineScoreAlignment, parseQuestionNumber, verifyQuestionAlignment } from "./pipelineSetup.js";

describe("buildPipelineScoreAlignment", () => {
  it("matches a single total field", () => {
    const result = buildPipelineScoreAlignment(pipelineFixtureRubric, [
      { id: "total", label: "总分", maxScore: 18 }
    ]);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("total");
  });

  it("blocks a single total field when the webpage maximum differs from the locked rubric total", () => {
    const rubric = { ...pipelineFixtureRubric, totalScore: 16 };
    const result = buildPipelineScoreAlignment(rubric, [
      { id: "total", label: "最终总分", maxScore: 18 }
    ]);

    expect(result).toMatchObject({
      ok: false,
      source: "total",
      rows: [{
        targetId: "total",
        targetLabel: "最终总分",
        targetMaxScore: 18,
        sourceId: rubric.title,
        sourceLabel: "模板总分",
        sourceMaxScore: 16,
        matched: false
      }]
    });
    expect(result.issues).toEqual(["网页满分 18 与评分标准总分 16 不一致"]);
    expect(result.issues.join(" ")).not.toMatch(/小问|评分点|数量|顺序/);
  });

  it("matches rubric subquestions by ordered maxima", () => {
    const result = buildPipelineScoreAlignment(pipelineFixtureRubric, [5, 5, 3, 5].map((maxScore, index) => ({
      id: `field-${index + 1}`,
      label: `评分栏 ${index + 1}`,
      maxScore
    })));
    expect(result.ok).toBe(true);
    expect(result.source).toBe("subquestions");
  });

  it("matches atomic score points by ordered maxima", () => {
    const maxima = pipelineFixtureRubric.subquestions.flatMap((item) => item.scorePoints.map((point) => point.score));
    const result = buildPipelineScoreAlignment(pipelineFixtureRubric, maxima.map((maxScore, index) => ({
      id: `field-${index + 1}`,
      label: `评分栏 ${index + 1}`,
      maxScore
    })));
    expect(result.ok).toBe(true);
    expect(result.source).toBe("points");
  });

  it("blocks missing maxima and mismatched structures", () => {
    expect(buildPipelineScoreAlignment(pipelineFixtureRubric, [
      { id: "unknown", label: "未知评分栏" }
    ]).ok).toBe(false);
    expect(buildPipelineScoreAlignment(pipelineFixtureRubric, Array.from({ length: 9 }, (_, index) => ({
      id: `field-${index + 1}`,
      label: `评分栏 ${index + 1}`,
      maxScore: 2
    })))).toMatchObject({ ok: false });
  });
});

describe("parseQuestionNumber and verifyQuestionAlignment", () => {
  it("parses Arabic and Chinese question numerals correctly", () => {
    expect(parseQuestionNumber("第12题")).toBe(12);
    expect(parseQuestionNumber("第 12 题")).toBe(12);
    expect(parseQuestionNumber("第12题 实验题")).toBe(12);
    expect(parseQuestionNumber("共3题 第12题")).toBe(12);
    expect(parseQuestionNumber("第12题 (共3题)")).toBe(12);
    expect(parseQuestionNumber("第 16 题 · 竖直圆轨道综合题")).toBe(16);
    expect(parseQuestionNumber("12. (1) 3.80")).toBe(12);
    expect(parseQuestionNumber("12. 实验题")).toBe(12);
    expect(parseQuestionNumber("12、动力学")).toBe(12);
    expect(parseQuestionNumber("题号: 12")).toBe(12);
    expect(parseQuestionNumber("题号：12")).toBe(12);
    expect(parseQuestionNumber("T12")).toBe(12);
    expect(parseQuestionNumber("Q12")).toBe(12);

    expect(parseQuestionNumber("第一题")).toBe(1);
    expect(parseQuestionNumber("第十题")).toBe(10);
    expect(parseQuestionNumber("第十一题")).toBe(11);
    expect(parseQuestionNumber("第十二题")).toBe(12);
    expect(parseQuestionNumber("第十三题")).toBe(13);
    expect(parseQuestionNumber("第十六题")).toBe(16);
    expect(parseQuestionNumber("第二十题")).toBe(20);
    expect(parseQuestionNumber("第二十三题")).toBe(23);

    // Non-question numbers should not be falsely extracted
    expect(parseQuestionNumber("共3题")).toBeUndefined();
    expect(parseQuestionNumber("满分6分")).toBeUndefined();
    expect(parseQuestionNumber("（20分）")).toBeUndefined();
    expect(parseQuestionNumber("高一物理电线杆运输减速与加速相对滑动问题")).toBeUndefined();
    expect(parseQuestionNumber("")).toBeUndefined();
    expect(parseQuestionNumber(undefined)).toBeUndefined();
  });

  it("blocks fatal cross-question mismatch when question numbers differ", () => {
    // 真实复盘场景：网页为第12题，工作台选了第13题
    const result = verifyQuestionAlignment({
      pageQuestionLabel: "第12题",
      rubricTitle: "第13题 实验题"
    });
    expect(result.ok).toBe(false);
    expect(result.extractedPageNumber).toBe(12);
    expect(result.extractedRubricNumber).toBe(13);
    expect(result.issues[0]).toContain("第 12 题");
    expect(result.issues[0]).toContain("第 13 题");
    expect(result.issues[0]).toContain("题号不一致！为杜绝串题误判，已阻止批改");
  });

  it("passes when question numbers match", () => {
    const result = verifyQuestionAlignment({
      pageQuestionLabel: "第12题",
      rubricTitle: "第12题 实验题"
    });
    expect(result.ok).toBe(true);
    expect(result.extractedPageNumber).toBe(12);
    expect(result.extractedRubricNumber).toBe(12);
    expect(result.issues).toHaveLength(0);
  });

  it("passes when rubric has no explicit question number", () => {
    const result = verifyQuestionAlignment({
      pageQuestionLabel: "第 16 题 · 竖直圆轨道综合题",
      rubricTitle: "竖直圆轨道综合题"
    });
    expect(result.ok).toBe(true);
    expect(result.extractedPageNumber).toBe(16);
    expect(result.extractedRubricNumber).toBeUndefined();
    expect(result.issues).toHaveLength(0);
  });

  it("passes when page label is undefined or missing", () => {
    const result = verifyQuestionAlignment({
      pageQuestionLabel: undefined,
      rubricTitle: "第13题 实验题"
    });
    expect(result.ok).toBe(true);
    expect(result.extractedPageNumber).toBeUndefined();
    expect(result.extractedRubricNumber).toBe(13);
    expect(result.issues).toHaveLength(0);
  });
});

