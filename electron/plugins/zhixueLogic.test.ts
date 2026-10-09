import { describe, expect, it } from "vitest";
import type { ScoreWritePayload } from "./types.js";
import {
  buildZhixueScorePlan,
  isZhixuePromptOrLoading,
  isZhixueStaticUiImageUrl,
  matchesZhixueUrl,
  parseMarkingProgress
} from "./zhixueLogic.js";

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

describe("isZhixueStaticUiImageUrl", () => {
  it("identifies Zhixue static UI and prompt illustrations", () => {
    expect(isZhixueStaticUiImageUrl("https://static.zhixue.com/webmarking/mErl3fpkE/static/img/intellTip.f409616.png")).toBe(true);
    expect(isZhixueStaticUiImageUrl("https://static.zhixue.com/webmarking/mErl3fpkE/static/img/guide.92bb0f2.png")).toBe(true);
    expect(isZhixueStaticUiImageUrl("https://static.zhixue.com/static-web-exam-list/1.0.0.1073/assets/emptyImg-SJJ2bESW.png")).toBe(true);
    expect(isZhixueStaticUiImageUrl("https://cdn-oss-hz.zhixue.com/container/oss_banner/a87a712a8e7041df8bd03fadb549fb84.jpg")).toBe(true);
    expect(isZhixueStaticUiImageUrl("https://static.zhixue.com/static-teacher-web/home.png")).toBe(true);
  });

  it("permits real student answer sheet images and mock URLs", () => {
    expect(isZhixueStaticUiImageUrl("https://zhixue-sc.oss-cn-hangzhou.aliyuncs.com/scDV2dv_marking/scanFile/2026/09/25/AfterCorrect_oss_8e37f7d1.jpg")).toBe(false);
    expect(isZhixueStaticUiImageUrl("https://zhixue.oss-cn-hangzhou.aliyuncs.com/container/oss_3b155e8b-df15-4114-8bab-196a5517cdd8.png")).toBe(false);
    expect(isZhixueStaticUiImageUrl("data:image/png;base64,mock")).toBe(false);
    expect(isZhixueStaticUiImageUrl("blob:http://localhost/12345")).toBe(false);
    expect(isZhixueStaticUiImageUrl(undefined)).toBe(false);
    expect(isZhixueStaticUiImageUrl("")).toBe(false);
  });
});

describe("isZhixuePromptOrLoading", () => {
  it("detects benchmark calibration tip container and buttons", () => {
    const docWithTip = {
      querySelector: (sel: string) => sel.includes("img_Tip") ? ({ id: "img_Tip" } as unknown as Element) : null
    };
    expect(isZhixuePromptOrLoading(docWithTip, () => true)).toBe("智学网正在搜集定标试卷，尚未加载有效学生答卷");

    const docWithContinue = {
      querySelector: (sel: string) => sel.includes("continueMark") ? ({ id: "continueMark" } as unknown as Element) : null
    };
    expect(isZhixuePromptOrLoading(docWithContinue, () => true)).toBe("智学网正在搜集定标试卷，尚未加载有效学生答卷");
  });

  it("detects image loading indicator", () => {
    const doc = {
      querySelector: (sel: string) => sel.includes("img_loading") ? ({ id: "img_loading" } as unknown as Element) : null
    };
    expect(isZhixuePromptOrLoading(doc, () => true)).toBe("智学网学生作答原图正在加载中");
  });

  it("detects image load error message", () => {
    const doc = {
      querySelector: (sel: string) => sel.includes("img-tip-div") ? ({ className: "img-tip-div" } as unknown as Element) : null
    };
    expect(isZhixuePromptOrLoading(doc, () => true)).toBe("智学网答卷图片显示失败，请在网页中刷新重试");
  });

  it("detects hidden student answer container", () => {
    const container = { id: "img_containter" } as unknown as Element;
    const doc = {
      querySelector: (sel: string) => sel.includes("img_containter") ? container : null
    };
    expect(isZhixuePromptOrLoading(doc, (el) => el !== container)).toBe("智学网学生作答区域当前处于隐藏状态，尚未就绪");
  });

  it("returns undefined when student paper is ready and rendered", () => {
    const container = { id: "img_containter" } as unknown as Element;
    const doc = {
      querySelector: (sel: string) => sel.includes("img_containter") ? container : null
    };
    expect(isZhixuePromptOrLoading(doc, () => true)).toBeUndefined();
  });
});
