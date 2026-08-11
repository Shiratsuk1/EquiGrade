import { afterEach, describe, expect, it, vi } from "vitest";
import { GENERIC_ADAPTER_MANIFEST } from "./manifests.js";
import { createGenericAdapter } from "./genericAdapter.js";
import { DEFAULT_GRADING_SELECTORS } from "./selectors.js";

type FakeNode = {
  dataset: Record<string, string>;
  querySelector: ReturnType<typeof vi.fn>;
};

function node(children: Record<string, FakeNode | null> = {}, dataset: Record<string, string> = {}): FakeNode {
  return {
    dataset,
    querySelector: vi.fn((selector: string) => children[selector] ?? null)
  };
}

function installPage({
  card,
  image,
  scoreInput = node(),
  submit = node(),
  next = node()
}: {
  card: FakeNode | null;
  image?: FakeNode | null;
  scoreInput?: FakeNode | null;
  submit?: FakeNode | null;
  next?: FakeNode | null;
}) {
  const documentQuerySelector = vi.fn((selector: string) => {
    if (selector === DEFAULT_GRADING_SELECTORS.answerCard) return card;
    if (selector === DEFAULT_GRADING_SELECTORS.answerImage) return image ?? null;
    if (selector === DEFAULT_GRADING_SELECTORS.scoreInput) return scoreInput;
    if (selector === DEFAULT_GRADING_SELECTORS.submitButton) return submit;
    if (selector === DEFAULT_GRADING_SELECTORS.nextButton) return next;
    return null;
  });
  vi.stubGlobal("document", { querySelector: documentQuerySelector, title: "测试页" });
  return { documentQuerySelector };
}

function adapter() {
  return createGenericAdapter(GENERIC_ADAPTER_MANIFEST, DEFAULT_GRADING_SELECTORS);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generic adapter answer-page safety", () => {
  it("does not treat a page-wide image as a student answer without an answer card", async () => {
    const unrelatedImage = node();
    const { documentQuerySelector } = installPage({ card: null, image: unrelatedImage });

    const result = await adapter().preflight();

    expect(result.ok).toBe(false);
    expect(result.capabilities.answerImage).toBe(false);
    expect(result.issues).toContain("未找到当前答卷容器");
    expect(documentQuerySelector.mock.calls.some(([selector]) => selector === DEFAULT_GRADING_SELECTORS.answerImage)).toBe(false);
    await expect(adapter().getCurrentAnswer()).rejects.toThrow("未找到当前答卷容器");
  });

  it("does not fall back to a page-wide image when the card has no answer media", async () => {
    const card = node({}, { pageKey: "student-001" });
    const { documentQuerySelector } = installPage({ card, image: node() });

    const result = await adapter().preflight();

    expect(result.ok).toBe(false);
    expect(result.capabilities.answerImage).toBe(false);
    expect(documentQuerySelector.mock.calls.some(([selector]) => selector === DEFAULT_GRADING_SELECTORS.answerImage)).toBe(false);
  });

  it("accepts a normal grading page only when the answer has a stable page key and all controls exist", async () => {
    const image = node();
    const card = node({ [DEFAULT_GRADING_SELECTORS.answerImage]: image }, { pageKey: "student-001" });
    installPage({ card, image: node() });

    const result = await adapter().preflight();

    expect(result).toEqual({
      ok: true,
      issues: [],
      capabilities: { answerImage: true, scoreInput: true, submit: true, next: true },
      pageKey: "student-001"
    });
  });

  it("rejects a card without a stable page key even when its image and controls exist", async () => {
    const image = node();
    const card = node({ [DEFAULT_GRADING_SELECTORS.answerImage]: image });
    installPage({ card });

    const result = await adapter().preflight();

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("当前答卷缺少稳定页面标识");
    await expect(adapter().getCurrentAnswer()).rejects.toThrow("当前答卷缺少稳定页面标识");
  });

  it("fails the whole preflight when a required grading control is missing", async () => {
    const image = node();
    const card = node({ [DEFAULT_GRADING_SELECTORS.answerImage]: image }, { pageKey: "student-001" });
    installPage({ card, submit: null });

    const result = await adapter().preflight();

    expect(result.ok).toBe(false);
    expect(result.capabilities).toEqual({ answerImage: true, scoreInput: true, submit: false, next: true });
    expect(result.issues).toContain("未找到提交按钮");
  });
});

describe("generic answer selector", () => {
  it("does not contain a bare page-wide img fallback", () => {
    expect(DEFAULT_GRADING_SELECTORS.answerImage).not.toMatch(/(?:^|,\s*)img(?:$|,)/);
  });
});
