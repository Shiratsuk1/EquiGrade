import { describe, expect, it } from "vitest";
import { pipelineFixtureRubric } from "../server/pipelineFixtureData.js";
import { buildPipelineScoreAlignment } from "./pipelineSetup.js";

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
