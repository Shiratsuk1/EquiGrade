import { afterEach, describe, expect, it, vi } from "vitest";
import { extractAnswerImage } from "./imageExtractor.js";
import { RUIYA_ADAPTER_MANIFEST } from "./manifests.js";
import { createRuiyaAdapter } from "./ruiyaAdapter.js";
import type { ScoreWritePayload } from "./types.js";

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
};

type FakeDocument = {
  title: string;
  baseURI: string;
  location: { pathname: string };
  defaultView: { getComputedStyle: () => { display: string; visibility: string } };
  body: FakeElement;
  querySelector: ReturnType<typeof vi.fn>;
  querySelectorAll: ReturnType<typeof vi.fn>;
};

function installPage() {
  const documentQuerySelector = vi.fn();
  const documentQuerySelectorAll = vi.fn((selector: string) => selector === "#panelKey input.ipt_score, #panelKey input[type='text']" ? [scoreInput] : []);
  const fakeDocument = {
    title: "睿芽考试服务云平台",
    baseURI: "https://ruiya.onlyets.com/mark/v6/view/task-token",
    location: { pathname: "/mark/v6/view/task-token" },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    body: null as unknown as FakeElement,
    querySelector: documentQuerySelector,
    querySelectorAll: documentQuerySelectorAll
  } as FakeDocument;
  const element = (options: Partial<FakeElement> = {}) => ({
    id: "",
    className: "",
    classList: { contains: () => false },
    dataset: {},
    type: "text",
    value: "",
    max: "",
    placeholder: "",
    title: "",
    disabled: false,
    textContent: "",
    parentElement: null,
    ownerDocument: fakeDocument,
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    getAttribute: vi.fn(() => null),
    dispatchEvent: vi.fn(() => true),
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    closest: vi.fn(() => null),
    click: vi.fn(),
    ...options
  }) as FakeElement;
  const form = element();
  const card = element();
  const image = element({ currentSrc: "https://alimarkpic.onlyets.com/pic2z/ruiya/answer.png", dataset: { stu: "student-1", sbj: "subject-1" } });
  const scoreField = element({ className: "panel-item-input", textContent: "9（1） <= 2" });
  const scoreInput = element({ id: "txt35797", value: "", parentElement: scoreField });
  const submit = element({ id: "submitMark", type: "button" });
  const hiddenStudent = element({ id: "hdMarkPic", value: "student-1", type: "hidden" });
  const hiddenQuestion = element({ value: "marking-1", type: "hidden" });
  const marked = element({ id: "lblMarked", textContent: "17" });
  const header = element({ textContent: "计划量: 208 已阅 : 17" });
  const subject = element({ id: "lblSub", textContent: "学科：物理" });
  const topic = element({ textContent: "9.1（多评）" });
  const topicGroup = element({ querySelector: vi.fn(() => topic) });
  const answerPanel = element({ id: "notationSpan" });
  const cardSpan = element({ id: "CardSpan" });
  const panelKey = element({ id: "panelKey" });
  const inputPrototype = {};
  Object.defineProperty(inputPrototype, "value", {
    configurable: true,
    set(this: FakeElement, value: string) { this.value = value; }
  });
  Object.assign(fakeDocument.defaultView as unknown as Record<string, unknown>, {
    HTMLInputElement: { prototype: inputPrototype },
    Event: class { constructor(_type: string, _init?: unknown) {} }
  });
  const imageElement = image as FakeElement;
  const selectorMap: Record<string, FakeElement | null> = {
    "#formMark": form,
    "#CardSpan": cardSpan,
    "#notationSpan": answerPanel,
    "#imageFullScreen": imageElement,
    "#panelKey": panelKey,
    "#hdMarkPic": hiddenStudent,
    "input[name='input-rpe-title']": hiddenQuestion,
    "#submitMark": submit,
    "#lblMarked": marked,
    header,
    "#lblSub": subject,
    ".btn-group .dropdown-toggle": topicGroup,
    "#span_mt_pwd": null,
    "#stuPaper": null,
    "#lblUnMarked": null,
    "#tecMessageModel": null,
    "#alertSpan": null,
    "#msgSpan": null,
    "#tecMessageModel .modal-body": null
  };
  documentQuerySelector.mockImplementation((selector: string) => selectorMap[selector] ?? null);
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  return { fakeDocument, image, scoreField, scoreInput, submit, selectorMap, element };
}

afterEach(() => {
  vi.mocked(extractAnswerImage).mockReset();
  vi.unstubAllGlobals();
});

describe("睿芽云页面适配器", () => {
  it("requires a loaded student image and stable answer identity", async () => {
    const page = installPage();
    const target = createRuiyaAdapter();
    const result = await target.preflight();

    expect(result).toEqual({
      ok: true,
      issues: [],
      capabilities: { answerImage: true, scoreInput: true, submit: true, next: true, skip: false },
      pageKey: expect.stringMatching(/^ruiya:/),
      questionLabel: "学科：物理"
    });
    expect(target.currentQuestionLabel?.()).toBe("学科：物理");
    expect(target.manifest).toBe(RUIYA_ADAPTER_MANIFEST);

    vi.mocked(extractAnswerImage).mockResolvedValue({
      dataUrl: "data:image/png;base64,AA==",
      mimeType: "image/png",
      sha256: "a".repeat(64),
      source: "test",
      bytes: 1
    });
    const answer = await target.getCurrentAnswer();
    expect(answer.sourcePageKey).toMatch(/^ruiya:/);
    expect(answer.pageToken).toMatch(/^ruiya-page-/);
    expect(extractAnswerImage).toHaveBeenCalledWith({ card: expect.anything(), image: page.image });
  });

  it("does not accept the server-rendered page before a student image is loaded", async () => {
    const page = installPage();
    page.image.currentSrc = "";
    page.image.getAttribute.mockReturnValue(null);
    const result = await createRuiyaAdapter().preflight();

    expect(result.ok).toBe(false);
    expect(result.capabilities.answerImage).toBe(false);
    expect(result.issues).toContain("未找到睿芽云当前学生答卷原图");
  });

  it("accepts multiple visible final score fields for multi-question pages", async () => {
    const page = installPage();
    page.fakeDocument.querySelectorAll.mockReturnValue([
      page.scoreInput,
      { ...page.scoreInput, id: "txt-second" }
    ]);

    const target = createRuiyaAdapter();
    const result = await target.preflight();
    const inspection = await target.inspectSetup();

    expect(result.ok).toBe(true);
    expect(result.capabilities.scoreInput).toBe(true);
    expect(inspection.scoreFields).toHaveLength(2);
    expect(inspection.fullScore).toBe(4);
  });

  it("writes ordered subquestion totals to every field and rolls them back", async () => {
    const page = installPage();
    const secondField = page.element({ className: "panel-item-input", textContent: "9（2） <= 2" });
    const secondInput = { ...page.scoreInput, id: "txt-second", parentElement: secondField };
    page.fakeDocument.querySelectorAll.mockReturnValue([page.scoreInput, secondInput]);
    const payload: ScoreWritePayload = {
      score: 3,
      maxScore: 4,
      segments: [
        { id: "9-1", title: "9（1）", score: 1, maxScore: 2, points: [] },
        { id: "9-2", title: "9（2）", score: 2, maxScore: 2, points: [] }
      ]
    };

    const result = await createRuiyaAdapter().testScoreWrite(payload);

    expect(result).toMatchObject({
      supported: true,
      rolledBack: true,
      total: 3,
      fieldValues: [
        { id: "txt35797", value: 1, maxScore: 2 },
        { id: "txt-second", value: 2, maxScore: 2 }
      ]
    });
    expect(page.scoreInput.value).toBe("");
    expect(secondInput.value).toBe("");
  });

  it("writes same-maximum fields according to their labels, even when the DOM order is swapped", async () => {
    const page = installPage();
    const firstField = page.element({ className: "panel-item-input", textContent: "9（1） <= 2" });
    const secondField = page.element({ className: "panel-item-input", textContent: "9（2） <= 2" });
    const firstInput = { ...page.scoreInput, id: "txt-first", parentElement: firstField };
    const secondInput = { ...page.scoreInput, id: "txt-second", parentElement: secondField };
    page.fakeDocument.querySelectorAll.mockReturnValue([secondInput, firstInput]);
    const payload: ScoreWritePayload = {
      score: 3,
      maxScore: 4,
      segments: [
        { id: "9-1", title: "9（1）", score: 1, maxScore: 2, points: [] },
        { id: "9-2", title: "9（2）", score: 2, maxScore: 2, points: [] }
      ]
    };

    const result = await createRuiyaAdapter().testScoreWrite(payload);

    expect(result.fieldValues).toEqual([
      { id: "txt-second", value: 2, maxScore: 2 },
      { id: "txt-first", value: 1, maxScore: 2 }
    ]);
  });

  it("rejects a multi-field write when a field has no stable subquestion label", async () => {
    const page = installPage();
    const secondField = page.element({ className: "panel-item-input", textContent: "<= 2" });
    const secondInput = { ...page.scoreInput, id: "txt-second", parentElement: secondField };
    page.scoreField.textContent = "<= 2";
    page.fakeDocument.querySelectorAll.mockReturnValue([page.scoreInput, secondInput]);
    const payload: ScoreWritePayload = {
      score: 3,
      maxScore: 4,
      segments: [
        { id: "9-1", title: "9（1）", score: 1, maxScore: 2, points: [] },
        { id: "9-2", title: "9（2）", score: 2, maxScore: 2, points: [] }
      ]
    };

    await expect(createRuiyaAdapter().writeScore(payload)).rejects.toThrow("缺少可稳定提取的小问标签");
  });

  it("rejects a field whose visible label names more than one subquestion", async () => {
    const page = installPage();
    const secondField = page.element({ className: "panel-item-input", textContent: "9（2） <= 2" });
    const secondInput = { ...page.scoreInput, id: "txt-second", parentElement: secondField };
    page.scoreField.textContent = "9（1）或 9（2） <= 2";
    page.fakeDocument.querySelectorAll.mockReturnValue([page.scoreInput, secondInput]);
    const payload: ScoreWritePayload = {
      score: 3,
      maxScore: 4,
      segments: [
        { id: "9-1", title: "9（1）", score: 1, maxScore: 2, points: [] },
        { id: "9-2", title: "9（2）", score: 2, maxScore: 2, points: [] }
      ]
    };

    await expect(createRuiyaAdapter().writeScore(payload)).rejects.toThrow("歧义映射");
  });

  it("confirms submission only when explicit feedback and every field readback match", async () => {
    const page = installPage();
    const feedback = page.element({ textContent: "" });
    page.selectorMap["#alertSpan"] = feedback;
    const target = createRuiyaAdapter();
    const payload: ScoreWritePayload = { score: 1, maxScore: 2, segments: [] };
    await target.writeScore(payload);
    page.submit.click.mockImplementation(() => { feedback.textContent = "保存成功"; });
    await target.submitScore(payload);
    await expect(target.verifySubmission(payload)).resolves.toBeUndefined();
  });

  it("keeps page, token, and image identity checks around submission verification", async () => {
    const page = installPage();
    const feedback = page.element({ textContent: "" });
    page.selectorMap["#alertSpan"] = feedback;
    vi.mocked(extractAnswerImage).mockResolvedValue({
      dataUrl: "data:image/png;base64,AA==",
      mimeType: "image/png",
      sha256: "a".repeat(64),
      source: "test",
      bytes: 1
    });
    const target = createRuiyaAdapter();
    const answer = await target.getCurrentAnswer();
    const payload: ScoreWritePayload = {
      score: 1,
      maxScore: 2,
      segments: [],
      expectedPageKey: answer.sourcePageKey,
      expectedPageToken: answer.pageToken,
      expectedImageHash: answer.imageHash
    };
    await target.writeScore(payload);
    page.submit.click.mockImplementation(() => { feedback.textContent = "保存成功"; });
    await target.submitScore(payload);
    await expect(target.verifySubmission(payload)).resolves.toBeUndefined();
    expect(extractAnswerImage).toHaveBeenCalledTimes(4);
  });

  it("rejects a feedback score that conflicts with the written payload", async () => {
    const page = installPage();
    const feedback = page.element({ textContent: "" });
    page.selectorMap["#alertSpan"] = feedback;
    const target = createRuiyaAdapter();
    const payload: ScoreWritePayload = { score: 1, maxScore: 2, segments: [] };
    await target.writeScore(payload);
    page.submit.click.mockImplementation(() => { feedback.textContent = "保存成功，得分：2分"; });
    await target.submitScore(payload);
    await expect(target.verifySubmission(payload)).rejects.toThrow("页面反馈分数与待写分数不一致");
  });

  it("does not treat a page change and relative +N feedback as a successful save", async () => {
    const page = installPage();
    const feedback = page.element({ textContent: "" });
    page.selectorMap["#alertSpan"] = feedback;
    const target = createRuiyaAdapter();
    const payload: ScoreWritePayload = { score: 1, maxScore: 2, segments: [] };
    await target.writeScore(payload);
    page.submit.click.mockImplementation(() => {
      feedback.textContent = "+1分";
      page.selectorMap["#hdMarkPic"]!.value = "student-2";
    });
    await target.submitScore(payload);
    await expect(target.verifySubmission(payload)).rejects.toThrow("保存状态不确定");
  });

  it("rejects a page without a visible score field", async () => {
    const page = installPage();
    page.fakeDocument.querySelectorAll.mockReturnValue([]);

    const result = await createRuiyaAdapter().preflight();

    expect(result.ok).toBe(false);
    expect(result.capabilities.scoreInput).toBe(false);
    expect(result.issues.some((issue) => issue.includes("未找到睿芽云最终分数框"))).toBe(true);
  });

  it("does not treat a generic submission dialog as batch completion", async () => {
    const page = installPage();
    page.selectorMap["#tecMessageModel"] = page.selectorMap["#formMark"];
    page.selectorMap["#tecMessageModel .modal-body"] = page.selectorMap["#formMark"];
    page.selectorMap["#tecMessageModel .modal-body"]!.textContent = "保存成功";

    const inspection = await createRuiyaAdapter().inspectSetup();

    expect(inspection.batchComplete).toBe(false);
  });

  it("recognizes only an explicit completion dialog as batch completion", async () => {
    const page = installPage();
    page.selectorMap["#tecMessageModel"] = page.selectorMap["#formMark"];
    page.selectorMap["#tecMessageModel .modal-body"] = page.selectorMap["#formMark"];
    page.selectorMap["#tecMessageModel .modal-body"]!.textContent = "任务量已全部完成";

    const inspection = await createRuiyaAdapter().inspectSetup();

    expect(inspection.batchComplete).toBe(true);
  });
});
