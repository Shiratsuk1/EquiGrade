import { extractAnswerImage } from "./imageExtractor.js";
import type { AdapterManifest, AdapterSelectors, SiteAdapter } from "./types.js";

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function query<T extends Element>(selector: string, scope: ParentNode = document) {
  return scope.querySelector<T>(selector);
}

function pageElements(selectors: AdapterSelectors) {
  const card = query<HTMLElement>(selectors.answerCard);
  const scope: ParentNode = card ?? document;
  const image = query<HTMLImageElement>(selectors.answerImage, scope) ?? query<HTMLImageElement>(selectors.answerImage);
  const scoreInput = query<HTMLInputElement>(selectors.scoreInput);
  const submit = query<HTMLElement>(selectors.submitButton);
  const next = query<HTMLElement>(selectors.nextButton);
  const previous = selectors.previousButton ? query<HTMLElement>(selectors.previousButton) : null;
  return { card, image, scoreInput, submit, next, previous };
}

function clickElement(element: HTMLElement | null, missingMessage: string) {
  if (!element) throw new Error(missingMessage);
  element.click();
}

function setInputValue(input: HTMLInputElement, value: number | string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("无法访问网页评分输入框");
  setter.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
}

function inputMaximum(input: HTMLInputElement) {
  const values = [input.max, input.dataset.maxScore, input.placeholder];
  for (const value of values) {
    const match = String(value ?? "").match(/(?:满分)?\s*(\d+(?:\.\d+)?)/);
    const maximum = match ? Number(match[1]) : Number.NaN;
    if (Number.isFinite(maximum)) return maximum;
  }
  return undefined;
}

function manifestMatches(manifest: AdapterManifest, url: URL) {
  return manifest.matchPatterns.some((pattern) => {
    const expression = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*");
    return new RegExp(`^${expression}$`, "i").test(url.href);
  });
}

export function createGenericAdapter(manifest: AdapterManifest, selectors: AdapterSelectors): SiteAdapter {
  let submissionSnapshot: {
    pageKey?: string;
    submitted: boolean;
    disabled: boolean;
    batchComplete: boolean;
  } | undefined;
  return {
    manifest,
    matches: (url) => manifestMatches(manifest, url),
    async preflight() {
      const elements = pageElements(selectors);
      const capabilities = {
        answerImage: Boolean(elements.image || elements.card?.querySelector("canvas")),
        scoreInput: Boolean(elements.scoreInput),
        submit: Boolean(elements.submit),
        next: Boolean(elements.next)
      };
      const issues: string[] = [];
      if (!elements.card) issues.push("未找到当前答卷容器");
      if (!capabilities.answerImage) issues.push("未找到学生答卷图片或画布");
      if (!capabilities.scoreInput) issues.push("未找到分数输入框");
      if (!capabilities.submit) issues.push("未找到提交按钮");
      if (!capabilities.next) issues.push("未找到下一份按钮");
      return {
        ok: issues.length === 0,
        issues,
        capabilities,
        pageKey: elements.card?.dataset.pageKey
      };
    },
    async inspectSetup() {
      const preflight = await this.preflight();
      const elements = pageElements(selectors);
      const maxScore = elements.scoreInput ? inputMaximum(elements.scoreInput) : undefined;
      return {
        ok: preflight.ok,
        issues: preflight.issues,
        adapterId: manifest.id,
        adapterName: manifest.name,
        pageKey: preflight.pageKey,
        pageTitle: document.title || "目标阅卷页面",
        questionLabel: elements.card?.dataset.questionTitle,
        fullScore: maxScore,
        scoreFields: elements.scoreInput ? [{
          id: elements.scoreInput.id || "score",
          label: elements.scoreInput.dataset.label || "总分",
          maxScore
        }] : [],
        batchComplete: this.isBatchComplete(),
        capabilities: preflight.capabilities
      };
    },
    async getCurrentAnswer() {
      const elements = pageElements(selectors);
      if (!elements.card) throw new Error("未找到当前答卷容器");
      if (!elements.image && !elements.card.querySelector("canvas")) throw new Error("未找到可提取的学生作答图片");
      const image = await extractAnswerImage({ card: elements.card, image: elements.image });
      const sourcePageKey = elements.card.dataset.pageKey || undefined;
      return {
        pageKey: `sha256:${image.sha256}`,
        sourcePageKey,
        imageDataUrl: image.dataUrl,
        imageHash: image.sha256,
        imageMimeType: image.mimeType,
        imageBytes: image.bytes,
        imageSource: image.source
      };
    },
    async setDiagnosticScore(score) {
      const input = pageElements(selectors).scoreInput;
      if (!input) throw new Error("未找到分数输入框");
      if (score !== undefined) {
        const maximum = inputMaximum(input);
        if (!Number.isFinite(score) || score < 0) throw new Error("测试分数必须是大于等于 0 的数字");
        if (maximum !== undefined && score > maximum) throw new Error(`测试分数不能超过网页满分 ${maximum}`);
      }
      setInputValue(input, score === undefined ? "" : score);
      await wait(120);
      const matched = score === undefined ? input.value === "" : Number(input.value) === score;
      if (!matched) throw new Error(score === undefined ? "网页分数框清空校验失败" : "网页分数写入校验失败");
      return { fieldId: input.id || "score", score };
    },
    async navigateForDiagnostic(direction) {
      const elements = pageElements(selectors);
      const previousPageKey = this.currentPageKey();
      const control = direction === "previous" ? elements.previous : elements.next;
      clickElement(control, direction === "previous" ? "未找到上一份答卷按钮" : "未找到下一份答卷按钮");
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const pageKey = this.currentPageKey();
        if (pageKey && pageKey !== previousPageKey) return { previousPageKey, pageKey };
        if (direction === "next" && this.isBatchComplete()) return { previousPageKey };
        await wait(200);
      }
      throw new Error(direction === "previous" ? "上一份答卷未加载" : "下一份答卷未加载");
    },
    async writeScore(payload) {
      const currentKey = this.currentPageKey();
      if (payload.expectedPageKey && currentKey && payload.expectedPageKey !== currentKey) {
        throw new Error("写分前页面标识已变化");
      }
      const input = pageElements(selectors).scoreInput;
      if (!input) throw new Error("未找到分数输入框");
      setInputValue(input, payload.score);
      await wait(120);
      if (Number(input.value) !== payload.score) throw new Error("网页分数写入校验失败");
    },
    async testScoreWrite(payload) {
      const input = pageElements(selectors).scoreInput;
      if (!input) throw new Error("未找到分数输入框");
      const previous = input.value;
      try {
        setInputValue(input, payload.score);
        await wait(120);
        if (Number(input.value) !== payload.score) throw new Error("网页分数写入校验失败");
        return {
          supported: true,
          rolledBack: true,
          fieldValues: [{ id: input.id || "score", value: payload.score, maxScore: inputMaximum(input) }],
          total: payload.score,
          message: "分数写入与回读成功，已恢复原值"
        };
      } finally {
        setInputValue(input, previous);
      }
    },
    async submitScore() {
      const elements = pageElements(selectors);
      submissionSnapshot = {
        pageKey: this.currentPageKey(),
        submitted: elements.card?.dataset.gradingState === "submitted",
        disabled: elements.submit?.matches(":disabled") ?? false,
        batchComplete: this.isBatchComplete()
      };
      clickElement(elements.submit, "未找到提交分数按钮");
    },
    async verifySubmission(_payload) {
      await wait(350);
      if (!submissionSnapshot) throw new Error("网页提交前状态丢失");
      const elements = pageElements(selectors);
      const submitted = elements.card?.dataset.gradingState === "submitted";
      const disabled = elements.submit?.matches(":disabled") ?? false;
      const currentPageKey = this.currentPageKey();
      const positiveConfirmation = (!submissionSnapshot.submitted && submitted)
        || (!submissionSnapshot.disabled && disabled)
        || (!submissionSnapshot.batchComplete && this.isBatchComplete())
        || Boolean(submissionSnapshot.pageKey && currentPageKey && submissionSnapshot.pageKey !== currentPageKey);
      submissionSnapshot = undefined;
      if (!positiveConfirmation) {
        throw new Error("网页未确认分数已提交");
      }
    },
    async goToNext() {
      clickElement(pageElements(selectors).next, "未找到下一份答卷按钮");
    },
    async detectPageChange(previousPageKey) {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (this.isBatchComplete()) return "completed";
        const currentKey = this.currentPageKey();
        if (currentKey && currentKey !== previousPageKey) return "changed";
        if (!currentKey && previousPageKey.startsWith("sha256:")) {
          try {
            const answer = await this.getCurrentAnswer();
            if (answer.pageKey !== previousPageKey) return "changed";
          } catch {
            // React-driven target pages may briefly remove their contents.
          }
        }
        await wait(250);
      }
      throw new Error("下一份答卷未加载");
    },
    isBatchComplete() {
      return Boolean(query(selectors.batchComplete));
    },
    currentPageKey() {
      return pageElements(selectors).card?.dataset.pageKey || undefined;
    }
  };
}
