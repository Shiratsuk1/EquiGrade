import { describe, expect, it } from "vitest";
import type { ScoreWritePayload } from "./types.js";
import { buildZhixueScorePlan, matchesZhixueUrl, parseMarkingProgress } from "./zhixueLogic.js";

const payload: ScoreWritePayload = {
  score: 7,
  maxScore: 10,
  segments: [
    {
      id: "q1",
      title: "第一问",
      score: 3,
      maxScore: 4,
      points: [
        { id: "p1", score: 2, maxScore: 2 },
        { id: "p2", score: 1, maxScore: 2 }
      ]
    },
    {
      id: "q2",
      title: "第二问",
      score: 4,
      maxScore: 6,
      points: [
        { id: "p1", score: 1, maxScore: 2 },
        { id: "p2", score: 3, maxScore: 4 }
      ]
    }
  ]
};

describe("matchesZhixueUrl", () => {
  it("matches the authenticated container and marking application", () => {
    expect(matchesZhixueUrl(new URL("https://www.zhixue.com/htm-container-web/index.html?app-0=x"))).toBe(true);
    expect(matchesZhixueUrl(new URL("https://school.zhixue.com/webmarking/example/"))).toBe(true);
    expect(matchesZhixueUrl(new URL("https://zhixue.com/webmarking/example/"))).toBe(true);
    expect(matchesZhixueUrl(new URL("http://127.0.0.1:38123/zhixue-mock?embedded=1"))).toBe(true);
  });

  it("rejects insecure, unrelated, and lookalike URLs", () => {
    expect(matchesZhixueUrl(new URL("http://www.zhixue.com/webmarking/example/"))).toBe(false);
    expect(matchesZhixueUrl(new URL("https://www.zhixue.com/login.html"))).toBe(false);
    expect(matchesZhixueUrl(new URL("https://zhixue.com.evil.example/webmarking/example/"))).toBe(false);
    expect(matchesZhixueUrl(new URL("http://127.0.0.1:38123/mock-grading"))).toBe(false);
  });
});

describe("parseMarkingProgress", () => {
  it("parses the local mock progress format", () => {
    expect(parseMarkingProgress("初评已阅量 1 / 任务量 4")).toEqual({ completed: 1, total: 4 });
    expect(parseMarkingProgress("初评已阅量 0 / 任务量 4")).toEqual({ completed: 0, total: 4 });
    expect(parseMarkingProgress("任务量已全部完成 · 初评已阅量 4 / 任务量 4")).toEqual({ completed: 4, total: 4 });
  });

  it("parses the legacy zhixue layout with both numbers after the label", () => {
    expect(parseMarkingProgress("已阅量 / 任务量 1/4")).toEqual({ completed: 1, total: 4 });
  });

  it("returns undefined when no progress text is present", () => {
    expect(parseMarkingProgress("")).toBeUndefined();
    expect(parseMarkingProgress("当前没有进度信息")).toBeUndefined();
  });
});

describe("buildZhixueScorePlan", () => {
  it("uses the total score when the page exposes one matching field", () => {
    expect(buildZhixueScorePlan(payload, [{ id: "totalScore", maxScore: 10 }])).toEqual({
      source: "total",
      values: [7]
    });
  });

  it("keeps rubric breakdown details out of the web write plan", () => {
    expect(buildZhixueScorePlan(payload, [{ id: "totalScore" }])).toEqual({
      source: "total",
      values: [7]
    });
  });

  it("rejects missing, multiple, or mismatched total fields", () => {
    expect(() => buildZhixueScorePlan(payload, [])).toThrow("当前识别到 0 个");
    expect(() => buildZhixueScorePlan(payload, [
      { id: "totalScore", maxScore: 10 },
      { id: "unexpected", maxScore: 10 }
    ])).toThrow("当前识别到 2 个");
    expect(() => buildZhixueScorePlan(payload, [{ id: "totalScore", maxScore: 12 }])).toThrow("与评分模板满分 10 不一致");
  });
});
