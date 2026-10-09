import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractAnswerImage } from "./imageExtractor.js";
import { ZHIXUE_ADAPTER_MANIFEST } from "./manifests.js";
import type { ScoreWritePayload } from "./types.js";
import { createZhixueAdapter } from "./zhixueAdapter.js";

vi.mock("./imageExtractor.js", () => ({ extractAnswerImage: vi.fn() }));

type FakeElement = {
  id: string;
  className: string;
  classList: { contains: (value: string) => boolean };
  dataset: Record<string, string>;
  type: string;
  value: string;
  max: string;
  placeholder: string;
  title: string;
  disabled: boolean;
  textContent: string;
  currentSrc?: string;
  src?: string;
  naturalWidth: number;
  naturalHeight: number;
  parentElement: FakeElement | null;
  ownerDocument: FakeDocument;
  querySelector: ReturnType<typeof vi.fn>;
  querySelectorAll: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  getAttribute: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
  getBoundingClientRect: () => { width: number; height: number };
  closest: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  contains: (other: FakeElement | null) => boolean;
};

type FakeDocument = {
  title: string;
  baseURI: string;
  location: { pathname: string };
  defaultView: {
    getComputedStyle: () => { display: string; visibility: string };
    HTMLInputElement: { prototype: Record<string, unknown> };
    Event: new (type: string, init?: unknown) => unknown;
  };
  body: FakeElement;
  documentElement: FakeElement;
  querySelector: ReturnType<typeof vi.fn>;
  querySelectorAll: ReturnType<typeof vi.fn>;
};

function installZhixuePage() {
  const documentQuerySelector = vi.fn();
  const documentQuerySelectorAll = vi.fn();

  const fakeDocument = {
    title: "智学网 · 个人阅卷",
    baseURI: "https://www.zhixue.com/htm-container-web/index.html#/marking/personal",
    location: { pathname: "/htm-container-web/index.html" },
    defaultView: {
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      HTMLInputElement: { prototype: {} },
      Event: class {
        constructor(readonly type: string, readonly init?: unknown) {}
      }
    },
    body: null as unknown as FakeElement,
    documentElement: null as unknown as FakeElement,
    querySelector: documentQuerySelector,
    querySelectorAll: documentQuerySelectorAll
  } as FakeDocument;

  const element = (options: Partial<FakeElement> = {}) => {
    const el = {
      id: "",
      className: "",
      classList: {
        contains: (cls: string) => el.className.split(/\s+/).includes(cls)
      },
      dataset: {},
      type: "text",
      value: "",
      max: "",
      placeholder: "",
      title: "",
      disabled: false,
      textContent: "",
      naturalWidth: 800,
      naturalHeight: 1200,
      parentElement: null,
      ownerDocument: fakeDocument,
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
      addEventListener: vi.fn(),
      getAttribute: vi.fn((name: string) => {
        if (name === "aria-disabled") return el.disabled ? "true" : null;
        if (name === "title") return el.title || null;
        return null;
      }),
      dispatchEvent: vi.fn(() => true),
      getBoundingClientRect: () => ({ width: 800, height: 1200 }),
      closest: vi.fn(() => null),
      click: vi.fn(),
      focus: vi.fn(),
      contains: (other: FakeElement | null) => other === el || other?.parentElement === el,
      ...options
    } as FakeElement;
    return el;
  };

  const body = element({ textContent: "" });
  fakeDocument.body = body;
  fakeDocument.documentElement = body;

  const card = element({ id: "topicImgContent" });
  const scoreContent = element({ className: "score_content", parentElement: card });
  const image = element({
    className: "enhance-definition-bright",
    currentSrc: "https://zhixue-sc.oss-cn-hangzhou.aliyuncs.com/answer-1.jpg",
    parentElement: scoreContent
  });
  card.querySelector = vi.fn((sel: string) => {
    for (const part of sel.split(",").map((s) => s.trim())) {
      if (part.includes("enhance-definition-bright") || part === "img") return image;
      if (part.includes("score_content")) return scoreContent;
    }
    return null;
  });
  card.querySelectorAll = vi.fn((sel: string) => {
    if (sel.includes("img")) return [image];
    return [];
  });

  const topic = element({ id: "currentTopic", textContent: "第 16 题 · 竖直圆轨道综合题" });
  const scoreAreaDiv = element({ id: "scoreareaDiv", className: "scorearea", textContent: "满分 18 分" });
  const scoreInput = element({
    id: "txt_marking_all",
    type: "number",
    placeholder: "满分 18 分",
    parentElement: scoreAreaDiv
  });
  const submit = element({ id: "bnt_save", textContent: "保存分数" });
  const next = element({ title: "下一份", className: "unnext", textContent: "下一份" });
  const prev = element({ title: "上一份", className: "unprev", textContent: "上一份" });
  const progressSpan = element({ className: "nvatool", textContent: "初评已阅量 1 / 任务量 10" });
  let activeToast: FakeElement | null = null;

  const inputPrototype = fakeDocument.defaultView.HTMLInputElement.prototype;
  Object.defineProperty(inputPrototype, "value", {
    configurable: true,
    set(this: FakeElement, val: string) {
      this.value = val;
    }
  });

  const selectorMap: Record<string, FakeElement | null> = {
    "#topicImgContent": card,
    "#topicImgContent .score_content": scoreContent,
    "#currentTopic": topic,
    "#scoreareaDiv": scoreAreaDiv,
    ".scorearea": scoreAreaDiv,
    "#txt_marking_all": scoreInput,
    "#totalScore": null,
    "#bnt_save": submit,
    "[data-grading-submit]": submit,
    "a[title='下一份']": next,
    "[data-grading-next]": next,
    "a[title='上一份']": prev,
    "[data-grading-prev]": prev,
    ".auto_choose .el-switch": null,
    "[data-auto-submit][role='switch']": null
  };

  documentQuerySelector.mockImplementation((selector: string) => {
    for (const part of selector.split(",").map((s) => s.trim())) {
      if (selectorMap[part]) return selectorMap[part];
      if (part === "input[id^='txt_marking_']" && scoreInput.id.startsWith("txt_marking_")) return scoreInput;
      if (part === "#scoreareaDiv" || part === ".scorearea") return scoreAreaDiv;
      if (part === "#topicImgContent") return card;
      if (part.includes("score_content")) return scoreContent;
      if (part === "#bnt_save" || part === "[data-grading-submit]") return submit;
      if (part.includes("下一份") || part === "[data-grading-next]" || part.includes("btn_next") || part.includes("next_btn")) return next;
      if (part.includes("上一份") || part.includes("btn_prev") || part.includes("prev_btn")) return prev;
      if (part === "img.enhance-definition-bright" || part === "img") return image;
      if (part === "#currentTopic") return topic;
      if (part === "#txt_marking_all") return scoreInput;
    }
    return selectorMap[selector] ?? null;
  });

  documentQuerySelectorAll.mockImplementation((selector: string) => {
    if (selector === "iframe") return [];
    if (selector.includes("input")) return [scoreInput];
    if (selector.includes(".el-message--success") || selector.includes(".el-message__content") || selector.includes("scoreTip")) {
      return activeToast ? [activeToast] : [];
    }
    if (selector.includes(".marking_left_title") || selector.includes(".nvatool") || selector.includes("#topicImgContent")) {
      return [progressSpan];
    }
    if (selector.includes("a, button")) return [prev, next, submit];
    if (selector.includes("img")) return [image];
    return [];
  });

  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("window", { setTimeout, clearTimeout });

  return {
    fakeDocument,
    card,
    scoreContent,
    image,
    topic,
    scoreAreaDiv,
    scoreInput,
    submit,
    next,
    prev,
    progressSpan,
    selectorMap,
    setToast(t: FakeElement | null) {
      activeToast = t;
    },
    element
  };
}

beforeEach(() => {
  vi.mocked(extractAnswerImage).mockResolvedValue({
    dataUrl: "data:image/png;base64,mock",
    mimeType: "image/png",
    sha256: "a".repeat(64),
    source: "img.currentSrc",
    bytes: 1234
  });
});

afterEach(() => {
  vi.mocked(extractAnswerImage).mockReset();
  vi.unstubAllGlobals();
});

describe("智学网页面适配器", () => {
  it("passes preflight with required Zhixue DOM elements", async () => {
    installZhixuePage();
    const adapter = createZhixueAdapter();
    const result = await adapter.preflight();

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.capabilities).toEqual({
      answerImage: true,
      scoreInput: true,
      submit: true,
      next: true,
      skip: false
    });
    expect(result.pageKey).toMatch(/^zhixue:/);
    expect(adapter.manifest).toBe(ZHIXUE_ADAPTER_MANIFEST);
  });

  it("inspects setup returning questionLabel and scoreFields", async () => {
    installZhixuePage();
    const adapter = createZhixueAdapter();
    const setup = await adapter.inspectSetup();

    expect(setup.ok).toBe(true);
    expect(setup.adapterId).toBe("zhixue-grading");
    expect(setup.questionLabel).toBe("第 16 题 · 竖直圆轨道综合题");
    expect(setup.fullScore).toBe(18);
    expect(setup.scoreFields).toEqual([{ id: "txt_marking_all", label: "最终总分", maxScore: 18 }]);
    expect(setup.progress).toEqual({ completed: 1, total: 10 });
    expect(setup.batchComplete).toBe(false);
  });

  it("reads current answer image and computes fingerprint", async () => {
    installZhixuePage();
    const adapter = createZhixueAdapter();
    const answer = await adapter.getCurrentAnswer();

    expect(answer.imageHash).toBe("a".repeat(64));
    expect(answer.sourcePageKey).toMatch(/^zhixue:/);
    expect(answer.pageToken).toMatch(/^zhixue-page-1@0$/);
  });

  it("writes score to the total score input and verifies value", async () => {
    const page = installZhixuePage();
    const adapter = createZhixueAdapter();
    const payload: ScoreWritePayload = {
      score: 15,
      maxScore: 18,
      segments: []
    };

    await adapter.writeScore(payload);
    expect(page.scoreInput.value).toBe("15");
    expect(page.scoreInput.focus).toHaveBeenCalled();
    expect(page.scoreInput.dispatchEvent).toHaveBeenCalled();
  });

  it("testScoreWrite tests writing and restores the previous value", async () => {
    const page = installZhixuePage();
    page.scoreInput.value = "";
    const adapter = createZhixueAdapter();
    const payload: ScoreWritePayload = {
      score: 12,
      maxScore: 18,
      segments: []
    };

    const result = await adapter.testScoreWrite(payload);
    expect(result.supported).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(page.scoreInput.value).toBe("");
  });

  it("submits score and verifies submission when success toast appears", async () => {
    const page = installZhixuePage();
    const adapter = createZhixueAdapter();
    const payload: ScoreWritePayload = {
      score: 18,
      maxScore: 18,
      segments: []
    };

    await adapter.writeScore(payload);

    const toast = page.element({
      className: "el-message el-message--success",
      textContent: "保存成功"
    });
    page.setToast(toast);

    await adapter.submitScore(payload);
    expect(page.submit.click).toHaveBeenCalled();

    await expect(adapter.verifySubmission(payload)).resolves.toBeUndefined();
  });

  it("goToNext waits for next button to be enabled and clicks it", async () => {
    const page = installZhixuePage();
    const adapter = createZhixueAdapter();

    // Enable the next button after a short delay (simulating asynchronous save response)
    page.next.className = "unnext";
    setTimeout(() => {
      page.next.className = "btn_next";
    }, 100);

    await adapter.goToNext();
    expect(page.next.click).toHaveBeenCalled();
  });

  it("goToNext returns immediately if page automatically transitioned", async () => {
    const page = installZhixuePage();
    const adapter = createZhixueAdapter();
    const payload: ScoreWritePayload = { score: 18, maxScore: 18, segments: [] };
    await adapter.writeScore(payload);

    page.setToast(page.element({ className: "el-message--success", textContent: "保存成功" }));
    await adapter.submitScore(payload);

    // Simulate automatic page flip by changing the image src
    page.image.currentSrc = "https://zhixue-sc.oss-cn-hangzhou.aliyuncs.com/answer-2.jpg";

    await adapter.goToNext();
    // next button should NOT be clicked because the page already transitioned automatically
    expect(page.next.click).not.toHaveBeenCalled();
  });

  it("detectPageChange recognizes changed fingerprint", async () => {
    const page = installZhixuePage();
    const adapter = createZhixueAdapter();
    const previousKey = adapter.currentPageKey();

    // Change image src
    page.image.currentSrc = "https://zhixue-sc.oss-cn-hangzhou.aliyuncs.com/answer-next.jpg";

    expect(previousKey).toBeDefined();
    const transition = await adapter.detectPageChange(previousKey!);
    expect(transition).toBe("changed");
  });

  it("detects batch completion from page text", () => {
    const page = installZhixuePage();
    page.fakeDocument.body.textContent = "任务量已全部完成，辛苦啦！";
    const adapter = createZhixueAdapter();
    expect(adapter.isBatchComplete()).toBe(true);
  });

  it("rejects score write if answer image changes beforehand (stale answer guard)", async () => {
    const page = installZhixuePage();
    const adapter = createZhixueAdapter();
    const answer = await adapter.getCurrentAnswer();

    const payload: ScoreWritePayload = {
      score: 10,
      maxScore: 18,
      segments: [],
      expectedPageKey: answer.sourcePageKey,
      expectedPageToken: answer.pageToken,
      expectedImageHash: answer.imageHash
    };

    // Change page key before write
    page.image.currentSrc = "https://zhixue-sc.oss-cn-hangzhou.aliyuncs.com/answer-swapped.jpg";

    await expect(adapter.writeScore(payload)).rejects.toThrow("智学网页面已经切换");
  });

  it("blocks preflight and refuses extraction when Zhixue shows benchmark calibration prompt", async () => {
    const page = installZhixuePage();
    const tip = page.element({ id: "img_Tip", className: "marking_content_block" });
    const continueBtn = page.element({ id: "continueMark", textContent: "仍要阅卷" });
    page.selectorMap["#img_Tip"] = tip;
    page.selectorMap["#continueMark"] = continueBtn;

    const adapter = createZhixueAdapter();
    const result = await adapter.preflight();

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("智学网正在搜集定标试卷，尚未加载有效学生答卷");
    expect(result.capabilities.answerImage).toBe(false);
    expect(result.pageKey).toBeUndefined();

    await expect(adapter.getCurrentAnswer()).rejects.toThrow("智学网正在搜集定标试卷，尚未加载有效学生答卷");
  });

  it("refuses to extract Zhixue static UI / intellTip placeholder image as answer image", async () => {
    const page = installZhixuePage();
    // Simulate that the only image is the static UI illustration
    page.image.className = "";
    page.image.currentSrc = "https://static.zhixue.com/webmarking/mErl3fpkE/static/img/intellTip.f409616.png";

    const adapter = createZhixueAdapter();
    const result = await adapter.preflight();

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("未找到智学网学生作答原图");
    expect(result.capabilities.answerImage).toBe(false);

    await expect(adapter.getCurrentAnswer()).rejects.toThrow("未找到智学网学生作答原图");
  });
});
