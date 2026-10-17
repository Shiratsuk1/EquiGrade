import { extractAnswerImage } from "./imageExtractor.js";
import { ZHIXUE_ADAPTER_MANIFEST } from "./manifests.js";
import { StaleAnswerError } from "./pipelineSafety.js";
import type { ScoreWritePayload, SiteAdapter } from "./types.js";
import {
  buildZhixueScorePlan,
  findZhixueExcellentControl,
  isZhixueExcellentControlActive,
  isZhixuePromptOrLoading,
  isZhixueStaticUiImageUrl,
  matchesZhixueUrl,
  parseMarkingProgress,
  type ZhixueScoreField
} from "./zhixueLogic.js";

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
  const realContainer = doc.querySelector<HTMLElement>("#img_containter, #img_container");
  if (realContainer && isRendered(realContainer)) return realContainer;
  return doc.querySelector<HTMLElement>("#topicImgContent .score_content")
    ?? doc.querySelector<HTMLElement>("#topicImgContent")
    ?? doc.body;
}

function findValidAnswerImageInScope(scope: ParentNode) {
  const preferred = scope.querySelector<HTMLImageElement>("img.enhance-definition-bright, img[data-grading-answer-image]");
  if (
    preferred
    && isRendered(preferred)
    && preferred.naturalWidth >= 100
    && preferred.naturalHeight >= 30
    && !isZhixueStaticUiImageUrl(preferred.currentSrc || preferred.src)
    && !preferred.closest?.("#img_Tip, #imgBoxTip, .img-tip-div, #img_loading, .img_loading")
  ) {
    return preferred;
  }

  return Array.from(scope.querySelectorAll<HTMLImageElement>("img"))
    .filter((image) => (
      image.naturalWidth >= 100
      && image.naturalHeight >= 30
      && isRendered(image)
      && !isZhixueStaticUiImageUrl(image.currentSrc || image.src)
      && !image.closest?.("#img_Tip, #imgBoxTip, .img-tip-div, #img_loading, .img_loading")
    ))
    .sort((left, right) => {
      const visibleDelta = Number(isRendered(right)) - Number(isRendered(left));
      if (visibleDelta) return visibleDelta;
      return right.naturalWidth * right.naturalHeight - left.naturalWidth * left.naturalHeight;
    })[0] ?? null;
}

function answerImage(doc: Document) {
  if (isZhixuePromptOrLoading(doc, isRendered)) return null;

  const realContainer = doc.querySelector<HTMLElement>("#img_containter, #img_container");
  if (realContainer && isRendered(realContainer)) {
    const candidate = findValidAnswerImageInScope(realContainer);
    if (candidate) return candidate;
  }

  const topicContent = doc.querySelector<HTMLElement>("#topicImgContent");
  if (topicContent) {
    const candidate = findValidAnswerImageInScope(topicContent);
    if (candidate) return candidate;
  }

  return findValidAnswerImageInScope(doc);
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
  input.focus?.();
  setter.call(input, value);
  input.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new view.Event("change", { bubbles: true, composed: true }));
  input.dispatchEvent(new view.Event("blur", { bubbles: true, composed: true }));
}

function isDisabled(element: HTMLElement | null) {
  if (!element) return true;
  const control = element as HTMLButtonElement | HTMLInputElement;
  const className = typeof element.className === "string" ? element.className : "";
  return control.disabled === true
    || element.getAttribute("aria-disabled") === "true"
    || /(?:^|\s)(?:unnext|unprev|unprevious|is-disabled|disabled)(?:\s|$)/i.test(className);
}

function findPageControl(doc: Document, direction: "previous" | "next") {
  const isNext = direction === "next";
  const title = isNext ? "下一份" : "上一份";
  const selectors = isNext
    ? ["a[title='下一份']", "[data-grading-next]", "a.next_btn", "a.btn_next", "button[title='下一份']"]
    : ["a[title='上一份']", "[data-grading-prev]", "[data-grading-previous]", "a.prev_btn", "a.btn_prev", "button[title='上一份']"];
  for (const selector of selectors) {
    const el = doc.querySelector<HTMLElement>(selector);
    if (el) return el;
  }
  const elements = Array.from(doc.querySelectorAll<HTMLElement>("a, button"));
  return elements.find((el) => {
    const text = (el.textContent ?? "").trim();
    const elTitle = el.getAttribute("title") ?? "";
    return elTitle === title || text === title || (isNext && text === "下一张") || (!isNext && text === "上一张");
  }) ?? null;
}

function enabledPageControl(doc: Document, title: "上一份" | "下一份") {
  const control = findPageControl(doc, title === "下一份" ? "next" : "previous");
  if (!control || isDisabled(control)) return null;
  return control;
}

function enabledNext(doc: Document) {
  return enabledPageControl(doc, "下一份");
}

async function setZhixueExcellentMark(doc: Document, checked: boolean = true): Promise<boolean> {
  const documents = collectDocuments(doc);
  let control: HTMLElement | null = null;
  for (const candidateDoc of documents) {
    control = findZhixueExcellentControl(candidateDoc, isRendered);
    if (control) break;
  }
  if (!control) return false;
  const currentlyActive = isZhixueExcellentControlActive(control);
  if (currentlyActive === checked) return true;

  if (typeof MouseEvent !== "undefined") {
    try {
      control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    } catch {
      // 容错处理
    }
  }
  control.click();
  await wait(120);
  return true;
}

function pageFingerprint(doc: Document) {
  if (isZhixuePromptOrLoading(doc, isRendered)) return undefined;
  const image = answerImage(doc);
  if (!image) return undefined;
  const topic = doc.querySelector("#currentTopic")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const source = `${image.currentSrc || image.src || ""}|${topic}`;
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
  return parseMarkingProgress(text);
}

function batchComplete(doc: Document) {
  const progress = markingProgress(doc);
  if (progress && progress.total > 0 && progress.completed >= progress.total) return true;
  const docs = collectDocuments(doc);
  return docs.some((d) => /(任务量已全部完成|本题的当前任务量已完成)/.test(d.body?.textContent ?? ""));
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
      const docs = collectDocuments(document);
      const successText = docs.some((candidateDoc) => Array.from(candidateDoc.querySelectorAll<HTMLElement>(
        ".el-message--success, .el-message__content, .topicTxt_errorTips, [class*='scoreTip']"
      )).some((element) => /(保存成功|自动提交成功)/.test(element.textContent ?? "")));
      if (successText) return resolve("acknowledged");

      const doc = gradingDocument();
      if (doc) {
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
  const pageTokens = new WeakMap<object, string>();
  const observedControls = new WeakSet<HTMLElement>();
  let pageTokenSequence = 0;
  let pageEpoch = 0;
  const pageTokenFor = (card: Element) => {
    const existing = pageTokens.get(card);
    if (existing) return existing;
    const token = `zhixue-page-${++pageTokenSequence}`;
    pageTokens.set(card, token);
    return token;
  };
  const observePageControls = (doc: Document) => {
    (["previous", "next"] as const).forEach((direction) => {
      const control = findPageControl(doc, direction);
      if (!control || typeof control.addEventListener !== "function" || observedControls.has(control)) return;
      observedControls.add(control);
      control.addEventListener("click", () => { pageEpoch += 1; }, { capture: true });
    });
  };
  const currentPageToken = (doc = gradingDocument()) => {
    const card = doc ? answerCard(doc) : null;
    if (doc) observePageControls(doc);
    return card ? `${pageTokenFor(card)}@${pageEpoch}` : undefined;
  };
  const readCurrentAnswer = async () => {
    const doc = gradingDocument();
    if (!doc) throw new Error("未找到智学网阅卷子页面");
    const promptIssue = isZhixuePromptOrLoading(doc, isRendered);
    if (promptIssue) throw new Error(promptIssue);
    const card = answerCard(doc);
    const imageElement = answerImage(doc);
    if (!card || !imageElement) throw new Error("未找到智学网学生作答原图");
    const pageToken = currentPageToken(doc);
    const image = await extractAnswerImage({ card, image: imageElement });
    const sourcePageKey = pageFingerprint(doc);
    if (!sourcePageKey) throw new Error("无法生成智学网当前答卷的稳定页面标识，已拒绝提取");
    const settledDoc = gradingDocument();
    if (!settledDoc
      || answerCard(settledDoc) !== card
      || pageFingerprint(settledDoc) !== sourcePageKey
      || currentPageToken(settledDoc) !== pageToken) {
      throw new StaleAnswerError("读取答卷期间智学网页面已经切换，已拒绝继续处理旧答卷");
    }
    return {
      pageKey: `sha256:${image.sha256}`,
      sourcePageKey,
      pageToken,
      imageDataUrl: image.dataUrl,
      imageHash: image.sha256,
      imageMimeType: image.mimeType,
      imageBytes: image.bytes,
      imageSource: image.source
    };
  };
  const assertCurrentTarget = async (payload: ScoreWritePayload) => {
    let doc = gradingDocument();
    if (!doc) throw new StaleAnswerError("写分前智学网阅卷子页面已经离线，已拒绝写入");
    const initialPageKey = pageFingerprint(doc);
    const initialPageToken = currentPageToken(doc);
    if (payload.expectedPageKey && initialPageKey !== payload.expectedPageKey) {
      throw new StaleAnswerError("写分前检测到智学网页面已经切换，已拒绝写入旧答卷分数");
    }
    if (payload.expectedPageToken && initialPageToken !== payload.expectedPageToken) {
      throw new StaleAnswerError("写分前检测到智学网当前答卷实例已经变化，已拒绝写入旧答卷分数");
    }
    if (payload.expectedImageHash) {
      const current = await readCurrentAnswer();
      doc = gradingDocument();
      if (!doc) throw new StaleAnswerError("写分前智学网阅卷子页面已经离线，已拒绝写入");
      if (payload.expectedPageKey && current.sourcePageKey !== payload.expectedPageKey) {
        throw new StaleAnswerError("写分前检测到智学网页面已经切换，已拒绝写入旧答卷分数");
      }
      if (payload.expectedPageToken && current.pageToken !== payload.expectedPageToken) {
        throw new StaleAnswerError("写分前检测到智学网当前答卷实例已经变化，已拒绝写入旧答卷分数");
      }
      if (current.imageHash !== payload.expectedImageHash) {
        throw new StaleAnswerError("写分前检测到智学网答卷图像已经变化，已拒绝写入旧答卷分数");
      }
    }
    // These checks are deliberately the last synchronous guard before the
    // score input is selected. There is no await after them until the value
    // is dispatched to the validated input element.
    const finalDoc = gradingDocument();
    const finalPageKey = finalDoc ? pageFingerprint(finalDoc) : undefined;
    const finalPageToken = currentPageToken(finalDoc);
    if (payload.expectedPageKey && finalPageKey !== payload.expectedPageKey) {
      throw new StaleAnswerError("写分前检测到智学网页面已经切换，已拒绝写入旧答卷分数");
    }
    if (payload.expectedPageToken && finalPageToken !== payload.expectedPageToken) {
      throw new StaleAnswerError("写分前检测到智学网当前答卷实例已经变化，已拒绝写入旧答卷分数");
    }
    if (!finalDoc) throw new StaleAnswerError("写分前智学网阅卷子页面已经离线，已拒绝写入");
    return finalDoc;
  };
  let writtenPayload: ScoreWritePayload | undefined;
  let submittedPageKey: string | undefined;
  let pendingSubmission: SubmissionProbe | undefined;

  const applyScorePayload = async (payload: ScoreWritePayload, rollbackAfter: boolean) => {
    const doc = await assertCurrentTarget(payload);
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
      const promptIssue = doc ? isZhixuePromptOrLoading(doc, isRendered) : undefined;
      const image = doc ? answerImage(doc) : null;
      const total = doc ? totalScoreInput(doc) : null;
      const submit = doc?.querySelector<HTMLElement>("#bnt_save, [data-grading-submit]") ?? null;
      const next = doc ? findPageControl(doc, "next") : null;
      const pageKey = doc ? pageFingerprint(doc) : undefined;
      const completed = Boolean(doc && batchComplete(doc));
      const excellent = doc ? findZhixueExcellentControl(doc, isRendered) : null;
      const capabilities = {
        answerImage: Boolean(image) && !promptIssue,
        scoreInput: Boolean(total),
        submit: Boolean(submit),
        next: Boolean(next),
        // 智学网批完当前份之前下一份按钮禁用，无法跳过未批完的答卷。
        skip: false,
        markExcellent: Boolean(excellent)
      };
      const issues: string[] = [];
      if (!doc) issues.push("未找到智学网阅卷子页面");
      if (promptIssue) issues.push(promptIssue);
      if (!pageKey && !completed) issues.push("无法生成智学网当前答卷的稳定页面标识");
      if (!capabilities.answerImage) issues.push("未找到智学网学生作答原图");
      if (!capabilities.scoreInput) issues.push(`未找到唯一的智学网最终总分框；${doc ? scoreInputDiagnostics(doc) : "阅卷子页面不可用"}`);
      if (!capabilities.submit && !completed) issues.push("未找到智学网提交分数按钮");
      if (!capabilities.next && !completed) issues.push("未找到智学网下一份控件");
      if (doc && autoSubmitState(doc) === true) issues.push("智学网自动提交已开启，请先关闭");
      return {
        ok: issues.length === 0,
        issues,
        capabilities,
        pageKey,
        questionLabel: doc ? currentQuestionLabel(doc) : undefined
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
      return readCurrentAnswer();
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
    async setExcellentMark(checked = true) {
      const doc = gradingDocument();
      if (!doc) throw new Error("智学网阅卷子页面已离线");
      const ok = await setZhixueExcellentMark(doc, checked);
      if (!ok) throw new Error("未在智学网页面找到可用的“优”控件");
      return true;
    },
    async submitScore(payload) {
      const doc = await assertCurrentTarget(payload);
      const submit = doc?.querySelector<HTMLElement>("#bnt_save, [data-grading-submit]");
      if (!doc || !submit) throw new Error("未找到智学网提交分数按钮");
      if (!writtenPayload) throw new Error("提交前尚未完成智学网分数写入校验");
      if (isDisabled(submit)) throw new Error("智学网提交分数按钮当前不可用");

      // 存疑卷回评标记：按业务使用步骤，在提交分数前先勾选页面“优”控件
      if (payload.requiresReview) {
        await setZhixueExcellentMark(doc, true).catch(() => false);
      }

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
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (this.isBatchComplete()) return;
        const doc = gradingDocument();
        if (doc) {
          const currentKey = pageFingerprint(doc);
          if (submittedPageKey && currentKey && currentKey !== submittedPageKey) return;
          const next = enabledNext(doc);
          if (next) {
            next.click();
            return;
          }
        }
        await wait(200);
      }
      throw new Error("智学网未自动进入下一份，且回评下一份控件不可用");
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
    },
    currentQuestionLabel() {
      const doc = gradingDocument();
      return doc ? currentQuestionLabel(doc) : undefined;
    }
  };
}
