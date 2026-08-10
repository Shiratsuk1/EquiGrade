import { extractAnswerImage } from "./imageExtractor.js";
import { ZHIXUE_ADAPTER_MANIFEST } from "./manifests.js";
import type { ScoreWritePayload, SiteAdapter } from "./types.js";
import { buildZhixueScorePlan, matchesZhixueUrl, type ZhixueScoreField } from "./zhixueLogic.js";

type SubmissionSignal = "acknowledged" | "changed" | "progressed";

type SubmissionProbe = {
  previousPageKey?: string;
  promise: Promise<SubmissionSignal>;
};

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function inputWindow(input: HTMLInputElement) {
  return input.ownerDocument.defaultView;
}

function isRendered(element: Element) {
  const view = element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect();
  const style = view?.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style?.display !== "none" && style?.visibility !== "hidden";
}

function collectDocuments(root: Document) {
  const documents: Document[] = [];
  const seen = new Set<Document>();
  const visit = (current: Document) => {
    if (seen.has(current)) return;
    seen.add(current);
    documents.push(current);
    current.querySelectorAll<HTMLIFrameElement>("iframe").forEach((frame) => {
      try {
        if (frame.contentDocument?.documentElement) visit(frame.contentDocument);
      } catch {
        // Cross-origin frames are outside this adapter's control boundary.
      }
    });
  };
  visit(root);
  return documents;
}

function gradingDocument() {
  return collectDocuments(document).find((candidate) => (
    candidate.querySelector("#topicImgContent")
    && (candidate.querySelector(".scorearea, #scoreareaDiv") || candidate.querySelector("input[id^='txt_marking_'], #totalScore"))
  ));
}

function answerCard(doc: Document) {
  return doc.querySelector<HTMLElement>("#topicImgContent .score_content")
    ?? doc.querySelector<HTMLElement>("#topicImgContent");
}

function answerImage(doc: Document) {
  const scope = doc.querySelector("#topicImgContent") ?? doc;
  const preferred = scope.querySelector<HTMLImageElement>("img.enhance-definition-bright");
  if (preferred?.naturalWidth && preferred.naturalHeight) return preferred;
  return Array.from(scope.querySelectorAll<HTMLImageElement>("img"))
    .filter((image) => image.naturalWidth >= 200 && image.naturalHeight >= 200)
    .sort((left, right) => {
      const visibleDelta = Number(isRendered(right)) - Number(isRendered(left));
      if (visibleDelta) return visibleDelta;
      return right.naturalWidth * right.naturalHeight - left.naturalWidth * left.naturalHeight;
    })[0] ?? null;
}

function scoreArea(doc: Document) {
  return doc.querySelector(".scorearea") ?? doc.querySelector("#scoreareaDiv") ?? doc.body;
}

function usableScoreInputs(doc: Document) {
  return Array.from(doc.querySelectorAll<HTMLInputElement>("input"))
    .filter((input) => ["", "text", "number", "tel"].includes(input.type.toLowerCase()))
    .filter((input) => isRendered(input) && !input.disabled);
}

function directScoreInputSemantics(input: HTMLInputElement) {
  return [
    input.id,
    input.name,
    input.placeholder,
    input.getAttribute("aria-label"),
    input.getAttribute("title"),
    input.className
  ].filter(Boolean).join(" ");
}

function totalScoreInput(doc: Document) {
  const inputs = usableScoreInputs(doc);
  const preferredIds = ["txt_marking_all", "totalScore"];
  for (const id of preferredIds) {
    const exact = inputs.find((input) => input.id === id);
    if (exact) return exact;
  }
  const semantic = inputs.filter((input) => /(?:最终)?总分|满分\s*\d|marking[_-]?all|total[_-]?score/i.test(directScoreInputSemantics(input)));
  if (semantic.length === 1) return semantic[0];
  const scopes = [doc.querySelector("#scoreareaDiv"), doc.querySelector(".scorearea")].filter((scope): scope is Element => Boolean(scope));
  const scoped = inputs.filter((input) => scopes.some((scope) => scope.contains(input)));
  if (scoped.length === 1) return scoped[0];
  const contextual = inputs.filter((input) => /(?:最终)?总分|满分\s*\d/i.test(input.parentElement?.textContent ?? ""));
  if (contextual.length === 1) return contextual[0];
  return inputs.length === 1 ? inputs[0] : null;
}

function scoreInputDiagnostics(doc: Document) {
  const inputs = usableScoreInputs(doc);
  if (!inputs.length) return "评分区没有可见文本输入框";
  return inputs.slice(0, 6).map((input) => {
    const identity = input.id || input.name || "无ID";
    const hint = input.placeholder || input.getAttribute("aria-label") || input.title || "无提示";
    return `${identity}[${hint}]`;
  }).join("、");
}

function totalMaximum(doc: Document) {
  const input = totalScoreInput(doc);
  const source = [scoreArea(doc)?.textContent, input?.placeholder, input?.getAttribute("aria-label"), input?.title]
    .filter(Boolean).join(" ");
  const match = source.match(/满分\s*(\d+(?:\.\d+)?)\s*分?/);
  const value = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const view = inputWindow(input);
  const setter = view && Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.set;
  if (!view || !setter) throw new Error("无法访问智学网分数输入框");
  setter.call(input, value);
  input.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new view.Event("change", { bubbles: true, composed: true }));
  input.dispatchEvent(new view.Event("blur", { bubbles: true, composed: true }));
}

function pageFingerprint(doc: Document) {
  const image = answerImage(doc);
  const topic = doc.querySelector("#currentTopic")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const source = `${image?.currentSrc || image?.src || ""}|${topic}`;
  if (!source.replace("|", "")) return undefined;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `zhixue:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function markingProgress(doc: Document) {
  const text = Array.from(doc.querySelectorAll<HTMLElement>(".marking_left_title, .nvatool, #topicImgContent"))
    .map((element) => element.textContent ?? "")
    .join(" ");
  const match = text.match(/(?:已阅量\s*\/\s*任务量|初评已阅量\s*\/\s*任务量)[^\d]*(\d+)\s*\/\s*(\d+)/);
  if (!match) return undefined;
  return { completed: Number(match[1]), total: Number(match[2]) };
}

function batchComplete(doc: Document) {
  const progress = markingProgress(doc);
  if (progress && progress.total > 0 && progress.completed >= progress.total) return true;
  return /(任务量已全部完成|本题的当前任务量已完成)/.test(doc.body?.textContent ?? "");
}

function enabledNext(doc: Document) {
  const next = doc.querySelector<HTMLElement>("a[title='下一份']");
  if (!next) return null;
  const className = typeof next.className === "string" ? next.className : "";
  if (/unnext|disabled/i.test(className) || next.getAttribute("aria-disabled") === "true") return null;
  return next;
}

function enabledPageControl(doc: Document, title: "上一份" | "下一份") {
  const control = doc.querySelector<HTMLElement>(`a[title='${title}']`);
  if (!control) return null;
  const className = typeof control.className === "string" ? control.className : "";
  if (/disabled/i.test(className) || control.getAttribute("aria-disabled") === "true") return null;
  if (title === "下一份" && /unnext/i.test(className)) return null;
  if (title === "上一份" && /unprev|unprevious/i.test(className)) return null;
  return control;
}

function autoSubmitState(doc: Document) {
  const control = doc.querySelector<HTMLElement>(".auto_choose .el-switch, [data-auto-submit][role='switch']");
  if (!control) return undefined;
  const checkbox = control.querySelector<HTMLInputElement>("input[type='checkbox']");
  return control.classList.contains("is-checked")
    || control.getAttribute("aria-checked") === "true"
    || checkbox?.checked === true;
}

function currentQuestionLabel(doc: Document) {
  const candidates = [
    doc.querySelector<HTMLElement>("#currentTopic"),
    doc.querySelector<HTMLElement>(".topic-item.active"),
    doc.querySelector<HTMLElement>(".marking_left_title [class*='active']"),
    doc.querySelector<HTMLElement>(".marking_left_title")
  ];
  return candidates
    .map((element) => element?.textContent?.replace(/\s+/g, " ").trim())
    .find((value) => value && value.length <= 80);
}

async function waitForPageChange(previousPageKey: string | undefined, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const doc = gradingDocument();
    if (doc) {
      if (batchComplete(doc)) return "completed" as const;
      const current = pageFingerprint(doc);
      if (previousPageKey && current && current !== previousPageKey) return "changed" as const;
    }
    await wait(150);
  }
  return undefined;
}

function submissionProbe(previousPageKey: string | undefined, previousProgress: ReturnType<typeof markingProgress>) {
  const deadline = Date.now() + 12_000;
  return new Promise<SubmissionSignal>((resolve, reject) => {
    const poll = () => {
      const doc = gradingDocument();
      if (doc) {
        const successText = Array.from(doc.querySelectorAll<HTMLElement>(
          ".el-message--success, .el-message__content, .topicTxt_errorTips, [class*='scoreTip']"
        )).some((element) => /(保存成功|自动提交成功)/.test(element.textContent ?? ""));
        if (successText) return resolve("acknowledged");

        const currentKey = pageFingerprint(doc);
        if (previousPageKey && currentKey && currentKey !== previousPageKey) return resolve("changed");

        const progress = markingProgress(doc);
        if (previousProgress && progress && progress.completed > previousProgress.completed) return resolve("progressed");
      }
      if (Date.now() >= deadline) return reject(new Error("智学网未返回明确的分数保存成功信号"));
      window.setTimeout(poll, 100);
    };
    poll();
  });
}

export function createZhixueAdapter(): SiteAdapter {
  let writtenPayload: ScoreWritePayload | undefined;
  let submittedPageKey: string | undefined;
  let pendingSubmission: SubmissionProbe | undefined;

  const applyScorePayload = async (payload: ScoreWritePayload, rollbackAfter: boolean) => {
    const doc = gradingDocument();
    if (!doc) throw new Error("智学网阅卷子页面已离线");
    const currentKey = pageFingerprint(doc);
    if (payload.expectedPageKey && currentKey !== payload.expectedPageKey) {
      throw new Error("写分前智学网页面标识已变化");
    }
    if (autoSubmitState(doc) === true) throw new Error("智学网自动提交已开启，请先关闭后再写入分数");
    const total = totalScoreInput(doc);
    if (!total) throw new Error("未找到可写入的智学网最终总分框");
    const targets = [total];
    const fields: ZhixueScoreField[] = [{ id: total.id, maxScore: totalMaximum(doc) }];
    const plan = buildZhixueScorePlan(payload, fields);
    const previousValues = targets.map((input) => input.value);
    let restored = false;
    const restore = async () => {
      targets.forEach((input, index) => setInputValue(input, previousValues[index]));
      await wait(180);
      targets.forEach((input, index) => {
        if (input.value !== previousValues[index]) throw new Error(`智学网分数框 ${input.id} 回滚失败`);
      });
      restored = true;
    };
    try {
      targets.forEach((input, index) => setInputValue(input, String(plan.values[index])));
      await wait(180);
      targets.forEach((input, index) => {
        if (Number(input.value) !== plan.values[index]) throw new Error(`智学网分数框 ${input.id} 写入校验失败`);
      });
      const result = {
        supported: true,
        rolledBack: rollbackAfter,
        fieldValues: targets.map((input, index) => ({
          id: input.id,
          value: plan.values[index],
          maxScore: fields[index].maxScore
        })),
        total: payload.score,
        message: rollbackAfter ? "最终总分写入校验成功，已恢复原值" : "最终总分写入校验成功"
      };
      if (rollbackAfter) await restore();
      else writtenPayload = payload;
      return result;
    } catch (error) {
      if (!restored) await restore().catch(() => undefined);
      throw error;
    }
  };

  return {
    manifest: ZHIXUE_ADAPTER_MANIFEST,
    matches: matchesZhixueUrl,
    async preflight() {
      const doc = gradingDocument();
      const image = doc ? answerImage(doc) : null;
      const total = doc ? totalScoreInput(doc) : null;
      const submit = doc?.querySelector<HTMLElement>("#bnt_save") ?? null;
      const next = doc?.querySelector<HTMLElement>("a[title='下一份']") ?? null;
      const capabilities = {
        answerImage: Boolean(image),
        scoreInput: Boolean(total),
        submit: Boolean(submit),
        next: Boolean(next)
      };
      const issues: string[] = [];
      if (!doc) issues.push("未找到智学网阅卷子页面");
      if (!capabilities.answerImage) issues.push("未找到智学网学生作答原图");
      if (!capabilities.scoreInput) issues.push(`未找到唯一的智学网最终总分框；${doc ? scoreInputDiagnostics(doc) : "阅卷子页面不可用"}`);
      if (!capabilities.submit && !(doc && batchComplete(doc))) issues.push("未找到智学网提交分数按钮");
      if (!capabilities.next && !(doc && batchComplete(doc))) issues.push("未找到智学网下一份控件");
      if (doc && autoSubmitState(doc) === true) issues.push("智学网自动提交已开启，请先关闭");
      return {
        ok: issues.length === 0,
        issues,
        capabilities,
        pageKey: doc ? pageFingerprint(doc) : undefined
      };
    },
    async inspectSetup() {
      const preflight = await this.preflight();
      const doc = gradingDocument();
      const total = doc ? totalScoreInput(doc) : null;
      const scoreFields = total ? [{
        id: total.id || "totalScore",
        label: "最终总分",
        maxScore: doc ? totalMaximum(doc) : undefined
      }] : [];
      const progress = doc ? markingProgress(doc) : undefined;
      const complete = Boolean(doc && batchComplete(doc));
      return {
        ok: preflight.ok,
        issues: preflight.issues,
        adapterId: ZHIXUE_ADAPTER_MANIFEST.id,
        adapterName: ZHIXUE_ADAPTER_MANIFEST.name,
        pageKey: preflight.pageKey,
        pageTitle: document.title || "智学网考试阅卷",
        questionLabel: doc ? currentQuestionLabel(doc) : undefined,
        fullScore: doc ? totalMaximum(doc) : undefined,
        scoreFields,
        autoSubmit: doc ? autoSubmitState(doc) : undefined,
        batchComplete: complete,
        progress,
        capabilities: preflight.capabilities
      };
    },
    async getCurrentAnswer() {
      const doc = gradingDocument();
      if (!doc) throw new Error("未找到智学网阅卷子页面");
      const card = answerCard(doc);
      const imageElement = answerImage(doc);
      if (!card || !imageElement) throw new Error("未找到智学网学生作答原图");
      const image = await extractAnswerImage({ card, image: imageElement });
      const sourcePageKey = pageFingerprint(doc);
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
      const doc = gradingDocument();
      if (!doc) throw new Error("智学网阅卷子页面已离线");
      if (autoSubmitState(doc) === true) throw new Error("智学网自动提交已开启，请先关闭后再测试写分");
      const input = totalScoreInput(doc);
      if (!input) throw new Error("未找到可写入的智学网最终总分框");
      const maximum = totalMaximum(doc);
      if (score !== undefined) {
        if (!Number.isFinite(score) || score < 0) throw new Error("测试分数必须是大于等于 0 的数字");
        if (maximum !== undefined && score > maximum) throw new Error(`测试分数不能超过网页满分 ${maximum}`);
      }
      writtenPayload = undefined;
      submittedPageKey = undefined;
      pendingSubmission = undefined;
      setInputValue(input, score === undefined ? "" : String(score));
      await wait(180);
      const matched = score === undefined ? input.value === "" : Number(input.value) === score;
      if (!matched) throw new Error(score === undefined ? "智学网总分框清空校验失败" : "智学网总分写入校验失败");
      return { fieldId: input.id || "totalScore", score };
    },
    async navigateForDiagnostic(direction) {
      const doc = gradingDocument();
      if (!doc) throw new Error("智学网阅卷子页面已离线");
      const previousPageKey = pageFingerprint(doc);
      const title = direction === "previous" ? "上一份" : "下一份";
      const control = enabledPageControl(doc, title);
      if (!control) throw new Error(`智学网${title}控件当前不可用`);
      writtenPayload = undefined;
      submittedPageKey = undefined;
      pendingSubmission = undefined;
      control.click();
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const current = gradingDocument();
        const pageKey = current ? pageFingerprint(current) : undefined;
        if (pageKey && pageKey !== previousPageKey) return { previousPageKey, pageKey };
        if (direction === "next" && current && batchComplete(current)) return { previousPageKey };
        await wait(150);
      }
      throw new Error(`智学网${title}答卷未加载`);
    },
    async writeScore(payload) {
      await applyScorePayload(payload, false);
    },
    async testScoreWrite(payload) {
      return applyScorePayload(payload, true);
    },
    async submitScore() {
      const doc = gradingDocument();
      const submit = doc?.querySelector<HTMLButtonElement>("#bnt_save");
      if (!doc || !submit) throw new Error("未找到智学网提交分数按钮");
      if (!writtenPayload) throw new Error("提交前尚未完成智学网分数写入校验");
      if (submit.disabled) throw new Error("智学网提交分数按钮当前不可用");
      submittedPageKey = pageFingerprint(doc);
      pendingSubmission = {
        previousPageKey: submittedPageKey,
        promise: submissionProbe(submittedPageKey, markingProgress(doc))
      };
      submit.click();
    },
    async verifySubmission(payload) {
      if (!writtenPayload || writtenPayload.score !== payload.score || writtenPayload.maxScore !== payload.maxScore) {
        throw new Error("智学网待校验分数与已写入分数不一致");
      }
      if (!pendingSubmission) throw new Error("智学网提交状态丢失");
      await pendingSubmission.promise;
      pendingSubmission = undefined;
      writtenPayload = undefined;
    },
    async goToNext() {
      const transition = await waitForPageChange(submittedPageKey, 2_500);
      if (transition || this.isBatchComplete()) return;
      const doc = gradingDocument();
      const next = doc ? enabledNext(doc) : null;
      if (!next) throw new Error("智学网未自动进入下一份，且回评下一份控件不可用");
      next.click();
    },
    async detectPageChange(previousPageKey) {
      const transition = await waitForPageChange(previousPageKey, 12_000);
      if (transition) return transition;
      throw new Error("智学网下一份答卷未加载");
    },
    isBatchComplete() {
      const doc = gradingDocument();
      return Boolean(doc && batchComplete(doc));
    },
    currentPageKey() {
      const doc = gradingDocument();
      return doc ? pageFingerprint(doc) : undefined;
    }
  };
}
