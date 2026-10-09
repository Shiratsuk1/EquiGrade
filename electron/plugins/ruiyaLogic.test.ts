import { describe, expect, it } from "vitest";
import type { ScoreWritePayload } from "./types.js";
import { buildRuiyaScorePlan, isRuiyaBatchCompletionText, matchesRuiyaUrl, parseRuiyaProgress } from "./ruiyaLogic.js";

const payload: ScoreWritePayload = {
  score: 2,
  maxScore: 2,
  segments: [],
  expectedPageKey: "ruiya:page",
  expectedPageToken: "ruiya-page-1@0",
  expectedImageHash: "a".repeat(64)
};

describe("睿芽云站点逻辑", () => {
  it("matches the v6 single-question grading URL", () => {
    expect(matchesRuiyaUrl(new URL("https://ruiya.onlyets.com/mark/v6/view/06D1A36DED0224A761ACB3EF568FF7C1"))).toBe(true);
    expect(matchesRuiyaUrl(new URL("https://ruiya.onlyets.com/mark/v7/view/task-token"))).toBe(true);
  });

  it("rejects login, insecure, lookalike, and batch URLs", () => {
    expect(matchesRuiyaUrl(new URL("https://ruiya.onlyets.com/LoginOut.aspx"))).toBe(false);
    expect(matchesRuiyaUrl(new URL("http://ruiya.onlyets.com/mark/v6/view/task-token"))).toBe(false);
    expect(matchesRuiyaUrl(new URL("https://ruiya.onlyets.com.evil.example/mark/v6/view/task-token"))).toBe(false);
    expect(matchesRuiyaUrl(new URL("https://ruiya.onlyets.com/mark/v6/viewmore/task-token"))).toBe(false);
  });

  it("parses Ruiya's plan and marked counters", () => {
    expect(parseRuiyaProgress("计划量: 208 已阅 : 17 平均分: 1.8")).toEqual({ completed: 17, total: 208 });
    expect(parseRuiyaProgress("计划量 4 · 已阅量：1")).toEqual({ completed: 1, total: 4 });
    expect(parseRuiyaProgress("当前页面没有阅卷进度")).toBeUndefined();
  });

  it("only recognizes explicit batch-completion text", () => {
    expect(isRuiyaBatchCompletionText("保存成功")).toBe(false);
    expect(isRuiyaBatchCompletionText("提交成功")).toBe(false);
    expect(isRuiyaBatchCompletionText("任务量已全部完成")).toBe(true);
    expect(isRuiyaBatchCompletionText("已完成阅卷任务")).toBe(true);
  });

  it("writes only the single final score and validates the page maximum", () => {
    expect(buildRuiyaScorePlan(payload, [{ id: "txt-score", maxScore: 2 }])).toEqual({ source: "total", values: [2] });
    expect(buildRuiyaScorePlan(payload, [{ id: "txt-score" }])).toEqual({ source: "total", values: [2] });
    expect(() => buildRuiyaScorePlan(payload, [])).toThrow("没有可写分数框");
    expect(() => buildRuiyaScorePlan(payload, [{ id: "txt-score", maxScore: 3 }])).toThrow("与评分模板满分 2 不一致");
  });

  it("maps multiple Ruiya score boxes to ordered subquestion totals", () => {
    const multiPayload: ScoreWritePayload = {
      ...payload,
      score: 5,
      maxScore: 9,
      segments: [
        { id: "14-1", title: "14（1）", score: 2, maxScore: 3, points: [] },
        { id: "14-2", title: "14（2）", score: 3, maxScore: 3, points: [] },
        { id: "14-3", title: "14（3）", score: 0, maxScore: 3, points: [] }
      ]
    };
    expect(buildRuiyaScorePlan(multiPayload, [
      { id: "score-1", label: "14（1）", maxScore: 3 },
      { id: "score-2", label: "14（2）", maxScore: 3 },
      { id: "score-3", label: "14（3）", maxScore: 3 }
    ])).toMatchObject({ source: "subquestions", values: [2, 3, 0] });
  });

  it("maps same-maximum fields by subquestion identity instead of DOM order", () => {
    const multiPayload: ScoreWritePayload = {
      ...payload,
      score: 5,
      maxScore: 6,
      segments: [
        { id: "14-1", title: "14（1）", score: 2, maxScore: 3, points: [] },
        { id: "14-2", title: "14（2）", score: 3, maxScore: 3, points: [] }
      ]
    };
    expect(buildRuiyaScorePlan(multiPayload, [
      { id: "score-2", label: "14（2）", maxScore: 3 },
      { id: "score-1", label: "14（1）", maxScore: 3 }
    ])).toMatchObject({ source: "subquestions", values: [3, 2] });
  });

  it("matches part-only page labels to payload identities", () => {
    const multiPayload: ScoreWritePayload = {
      ...payload,
      score: 3,
      maxScore: 6,
      segments: [
        { id: "14-1", title: "14（1）", score: 1, maxScore: 3, points: [] },
        { id: "14-2", title: "14（2）", score: 2, maxScore: 3, points: [] }
      ]
    };
    expect(buildRuiyaScorePlan(multiPayload, [
      { id: "score-a", label: "（2）", maxScore: 3 },
      { id: "score-b", label: "（1）", maxScore: 3 }
    ])).toMatchObject({ values: [2, 1] });
  });

  it("accepts an explicit site segment identity when the label is unavailable", () => {
    const multiPayload: ScoreWritePayload = {
      ...payload,
      score: 3,
      maxScore: 6,
      segments: [
        { id: "q14-p1", title: "", score: 1, maxScore: 3, points: [] },
        { id: "q14-p2", title: "", score: 2, maxScore: 3, points: [] }
      ]
    };
    expect(buildRuiyaScorePlan(multiPayload, [
      { id: "score-a", identity: "q14-p2", maxScore: 3 },
      { id: "score-b", identity: "q14-p1", maxScore: 3 }
    ])).toMatchObject({ values: [2, 1] });
  });

  it("rejects an unsafe multi-box mapping", () => {
    const multiPayload: ScoreWritePayload = {
      ...payload,
      score: 5,
      maxScore: 9,
      segments: [
        { id: "14-1", title: "14（1）", score: 2, maxScore: 3, points: [] },
        { id: "14-2", title: "14（2）", score: 3, maxScore: 3, points: [] },
        { id: "14-3", title: "14（3）", score: 0, maxScore: 3, points: [] }
      ]
    };
    const fields = [
      { id: "score-1", label: "14（1）", maxScore: 3 },
      { id: "score-2", label: "14（2）", maxScore: 3 },
      { id: "score-3", label: "14（3）", maxScore: 3 }
    ];
    expect(() => buildRuiyaScorePlan(multiPayload, fields.slice(0, 2))).toThrow("已拒绝错位写分");
    expect(() => buildRuiyaScorePlan(multiPayload, [{ ...fields[0], maxScore: 2 }, fields[1], fields[2]])).toThrow("评分框“14（1）”满分");
    expect(() => buildRuiyaScorePlan({ ...multiPayload, score: 4 }, fields)).toThrow("各小问得分之和");
    expect(() => buildRuiyaScorePlan({ ...multiPayload, maxScore: 8 }, fields)).toThrow("各小问满分之和");
  });

  it("rejects missing, duplicate, ambiguous, and unmatched field labels", () => {
    const multiPayload: ScoreWritePayload = {
      ...payload,
      score: 3,
      maxScore: 6,
      segments: [
        { id: "14-1", title: "14（1）", score: 1, maxScore: 3, points: [] },
        { id: "14-2", title: "14（2）", score: 2, maxScore: 3, points: [] }
      ]
    };
    expect(() => buildRuiyaScorePlan(multiPayload, [
      { id: "a", maxScore: 3 },
      { id: "b", label: "14（2）", maxScore: 3 }
    ])).toThrow("缺少可稳定提取的小问标签");
    expect(() => buildRuiyaScorePlan(multiPayload, [
      { id: "a", label: "14（1）", maxScore: 3 },
      { id: "b", label: "14（1）", maxScore: 3 }
    ])).toThrow("身份重复");
    expect(() => buildRuiyaScorePlan(multiPayload, [
      { id: "a", label: "14（1）（2）", maxScore: 3 },
      { id: "b", label: "14（2）", maxScore: 3 }
    ])).toThrow("歧义映射");
    expect(() => buildRuiyaScorePlan(multiPayload, [
      { id: "a", label: "14（3）", maxScore: 3 },
      { id: "b", label: "14（2）", maxScore: 3 }
    ])).toThrow("无法对应模型小问");
  });
});
