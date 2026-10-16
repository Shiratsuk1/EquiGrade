import { extractAnswerImage } from "./imageExtractor.js";
import { RUIYA_ADAPTER_MANIFEST } from "./manifests.js";
import { StaleAnswerError } from "./pipelineSafety.js";
import type { ScoreWritePayload, SiteAdapter } from "./types.js";
import { buildRuiyaScorePlan, isRuiyaBatchCompletionText, matchesRuiyaUrl, parseRuiyaProgress, type RuiyaScoreField, type RuiyaScorePlan } from "./ruiyaLogic.js";

type ScoreFieldSnapshot = {
  id: string;
  label: string;
  identity?: string;
  segmentId?: string;
  value: number;
  maxScore?: number;
};

type WrittenScoreSnapshot = {
  pageKey: string;
  pageToken?: string;
  imageHash?: string;
  payloadSignature: string;
  score: number;
  maxScore: number;
  fields: ScoreFieldSnapshot[];
};

type SubmissionSignal = {
  kind: "acknowledged" | "changed" | "progressed" | "completed" | "conflict";
  feedback: string;
  feedbackScore?: number;
};

type SubmissionProbe = {
  previousPageKey: string;
  promise: Promise<SubmissionSignal>;
};

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function isRendered(element: Element) {
  const view = element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect();
  const style = view?.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style?.display !== "none" && style?.visibility !== "hidden";
}

function imageSource(image: HTMLImageElement | null) {
  return image?.currentSrc?.trim() || image?.getAttribute("src")?.trim() || image?.dataset.src?.trim() || undefined;
}

function gradingDocument() {
  return document.querySelector("#formMark")
    && document.querySelector("#CardSpan")
    && document.querySelector("#notationSpan")
    && document.querySelector("#imageFullScreen")
    && document.querySelector("#panelKey")
    ? document
    : null;
}

function answerCard(doc: Document) {
  return doc.querySelector<HTMLElement>("#notationSpan") ?? doc.querySelector<HTMLElement>("#CardSpan");
}

function answerImage(doc: Document) {
  const image = doc.querySelector<HTMLImageElement>("#imageFullScreen");
  return imageSource(image) ? image : null;
}

function currentStudentId(doc: Document) {
  const candidates = [
    doc.querySelector<HTMLInputElement>("#hdMarkPic")?.value,
    doc.querySelector<HTMLImageElement>("#imageFullScreen")?.dataset.stu,
    doc.querySelector<HTMLElement>("#stuPaper")?.dataset.stuno
  ];
  return candidates.map((value) => value?.trim()).find((value) => value && value !== "0");
}

function currentQuestionId(doc: Document) {
  const candidates = [
    doc.querySelector<HTMLImageElement>("#imageFullScreen")?.dataset.sbj,
    doc.querySelector<HTMLInputElement>("input[name='input-rpe-title']")?.value,
    doc.querySelector<HTMLElement>("#span_mt_pwd")?.textContent
  ];
  return candidates.map((value) => value?.replace(/\s+/g, " ").trim()).find((value) => value && value !== "0" && value !== "-");
}

function fnv1a(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function pageIdentity(doc: Document) {
  const student = currentStudentId(doc);
  if (!student) return undefined;
  const image = answerImage(doc);
  const source = imageSource(image);
  const imageIdentity = source?.startsWith("data:") ? `data:${source.length}` : source ?? "";
  const pathname = (() => {
    try {
      return doc.location?.pathname ?? "";
    } catch {
      return "";
    }
  })();
  return `${pathname}|${currentQuestionId(doc) ?? ""}|${student}|${imageIdentity}`;
}

function pageFingerprint(doc: Document) {
  const identity = pageIdentity(doc);
  return identity ? `ruiya:${fnv1a(identity)}` : undefined;
}

function scoreInputs(doc: Document) {
  return Array.from(doc.querySelectorAll<HTMLInputElement>("#panelKey input.ipt_score, #panelKey input[type='text']"))
    .filter((input) => ["", "text", "number", "tel"].includes(input.type.toLowerCase()))
    .filter((input) => isRendered(input) && !input.disabled);
}

function normalizedText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function scoreFieldElement(input: HTMLInputElement): HTMLElement | null {
  return input.closest<HTMLElement>(".panel-item-input") ?? input.parentElement;
}

function scoreInputMetadataCandidates(input: HTMLInputElement) {
  const field = scoreFieldElement(input);
  return [
    input.getAttribute("aria-label"),
    input.getAttribute("data-label"),
    input.getAttribute("data-segment-id"),
    input.getAttribute("data-question-id"),
    input.getAttribute("data-subquestion-id"),
    input.getAttribute("data-subquestion"),
    field?.querySelector<HTMLElement>(".panel-item-label, .panel-item-title, label, span:first-child")?.textContent,
    field?.textContent,
    input.id,
    input.name
  ];
}

function stableScoreInputLabels(value: string) {
  const text = normalizedText(value);
  if (!text) return [];
  const labels = new Set<string>();
  for (const match of text.matchAll(/(?:第\s*)?\d+\s*题?\s*[（(]\s*\d+\s*[）)]/g)) labels.add(normalizedText(match[0]));
  if (!labels.size) {
    for (const match of text.matchAll(/(?:第\s*)?\d+\s*(?:[-_.:/]|小题\s*)\d+(?:\s*小题)?/g)) labels.add(normalizedText(match[0]));
  }
  if (!labels.size) {
    for (const match of text.matchAll(/[（(]\s*\d+\s*[）)]/g)) labels.add(normalizedText(match[0]));
  }
  if (!labels.size) {
    for (const match of text.matchAll(/(?:第\s*)?\d+\s*小题|小题\s*\d+/g)) labels.add(normalizedText(match[0]));
  }
  return Array.from(labels);
}

function scoreInputSemanticLabel(input: HTMLInputElement) {
  const labels = new Set<string>();
  for (const candidate of scoreInputMetadataCandidates(input)) {
    stableScoreInputLabels(candidate ?? "").forEach((label) => labels.add(label));
  }
  return labels.size ? Array.from(labels).join(" | ") : undefined;
}

function scoreInputLabel(input: HTMLInputElement, index: number) {
  return scoreInputSemanticLabel(input) || input.id || input.name || `小题 ${index + 1}`;
}

function scoreInputIdentity(input: HTMLInputElement) {
  const field = scoreFieldElement(input);
  const candidates = [
    input.getAttribute("data-segment-id"),
    input.getAttribute("data-subquestion-id"),
    input.getAttribute("data-question-id"),
    input.dataset.segmentId,
    input.dataset.subquestionId,
    input.dataset.questionId,
    field?.getAttribute("data-segment-id"),
    field?.getAttribute("data-subquestion-id"),
    field?.getAttribute("data-question-id"),
    field?.dataset.segmentId,
    field?.dataset.subquestionId,
    field?.dataset.questionId
  ].map((value) => normalizedText(value)).filter(Boolean);
  if (!candidates.length) return undefined;
  // Preserve every explicit identity so conflicting site attributes are not
  // silently discarded. The logic layer rejects ambiguous combinations.
  return Array.from(new Set(candidates)).join(" | ");
}

function scoreInputMaximum(input: HTMLInputElement) {
  const field = scoreFieldElement(input);
  const source = [
    field?.textContent,
    input.max,
    input.dataset.maxScore,
    input.placeholder,
    input.getAttribute("aria-label"),
    input.title
  ].filter(Boolean).join(" ");
  const marked = source.match(/(?:<=|≤|满分|上限)\s*(\d+(?:\.\d+)?)/);
  const fallback = source.match(/(\d+(?:\.\d+)?)\s*(?:分)?\s*$/);
  const value = Number(marked?.[1] ?? fallback?.[1]);
  return Number.isFinite(value) ? value : undefined;
}

function scoreInputDiagnostics(doc: Document) {
  const inputs = scoreInputs(doc);
  if (!inputs.length) return "评分区没有可见文本输入框";
  return inputs.slice(0, 6).map((input) => {
    const index = inputs.indexOf(input);
    const identity = scoreInputLabel(input, index);
    const hint = input.placeholder || input.getAttribute("aria-label") || input.title || "无提示";
    return `${identity}[${hint}]`;
  }).join("、");
}

function scorePayloadSignature(payload: ScoreWritePayload) {
  return JSON.stringify({
    score: payload.score,
    maxScore: payload.maxScore,
    expectedPageKey: payload.expectedPageKey,
    expectedPageToken: payload.expectedPageToken,
    expectedImageHash: payload.expectedImageHash,
    segments: payload.segments.map((segment) => ({
      id: segment.id,
      title: segment.title,
      score: segment.score,
      maxScore: segment.maxScore,
      points: segment.points.map((point) => ({ id: point.id, score: point.score, maxScore: point.maxScore }))
    })).sort((left, right) => left.id.localeCompare(right.id))
  });
}

function scoreFieldsForInputs(inputs: HTMLInputElement[]) {
  return inputs.map((input, index) => ({
    id: input.id || `score-${index + 1}`,
    label: scoreInputSemanticLabel(input),
    identity: scoreInputIdentity(input),
    maxScore: scoreInputMaximum(input)
  } satisfies RuiyaScoreField));
}

function scoreFieldSetupIssue(inputs: HTMLInputElement[]) {
  if (inputs.length <= 1) return undefined;
  const fields = scoreFieldsForInputs(inputs);
  const missing = fields.filter((field) => !field.label && !field.identity);
  return missing.length
    ? `睿芽云存在 ${missing.length} 个小题评分框缺少可稳定提取的小问标签或身份，已禁止多框写分`
    : undefined;
}

function snapshotForInputs(
  payload: ScoreWritePayload,
  pageKey: string,
  pageToken: string | undefined,
  inputs: HTMLInputElement[],
  fields: RuiyaScoreField[],
  plan: RuiyaScorePlan
): WrittenScoreSnapshot {
  return {
    pageKey,
    pageToken,
    imageHash: payload.expectedImageHash,
    payloadSignature: scorePayloadSignature(payload),
    score: payload.score,
    maxScore: payload.maxScore,
    fields: inputs.map((input, index) => ({
      id: fields[index].id,
      label: fields[index].label || fields[index].id,
      identity: fields[index].identity,
      segmentId: plan.assignments?.[index]?.segmentId,
      value: plan.values[index],
      maxScore: fields[index].maxScore
    }))
  };
}

function scoreReadbackMatches(
  doc: Document,
  payload: ScoreWritePayload,
  expected: WrittenScoreSnapshot
) {
  if (pageFingerprint(doc) !== expected.pageKey || scorePayloadSignature(payload) !== expected.payloadSignature) return false;
  const inputs = scoreInputs(doc);
  if (inputs.length !== expected.fields.length) return false;
  const fields = scoreFieldsForInputs(inputs);
  let plan: RuiyaScorePlan;
  try {
    plan = buildRuiyaScorePlan(payload, fields);
  } catch {
    return false;
  }
  if (plan.values.length !== expected.fields.length) return false;
  if ((plan.assignments?.length ?? 0) !== expected.fields.filter((field) => field.segmentId !== undefined).length) return false;
  return inputs.every((input, index) => {
    const current = fields[index];
    const previous = expected.fields[index];
    const assignment = plan.assignments?.[index];
    return current.id === previous.id
      && current.label === previous.label
      && current.identity === previous.identity
      && (assignment?.segmentId ?? undefined) === previous.segmentId
      && Number.isFinite(Number(input.value))
      && Math.abs(Number(input.value) - previous.value) <= 1e-6
      && (current.maxScore === undefined || previous.maxScore === undefined || Math.abs(current.maxScore - previous.maxScore) <= 1e-6);
  });
}

function totalMaximum(doc: Document) {
  const maximums = scoreInputs(doc).map((input) => scoreInputMaximum(input));
  const knownMaximums = maximums.filter((maximum): maximum is number => maximum !== undefined);
  if (!maximums.length || knownMaximums.length !== maximums.length) return undefined;
  return knownMaximums.reduce((sum, maximum) => sum + maximum, 0);
}

function inputWindow(input: HTMLInputElement) {
  return input.ownerDocument.defaultView;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const view = inputWindow(input);
  const setter = view && Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.set;
  if (!view || !setter) throw new Error("无法访问睿芽云网页评分输入框");
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
    || /(?:^|\s)disabled(?:\s|$)/i.test(className);
}

function markingProgress(doc: Document) {
  const text = [
    doc.querySelector<HTMLElement>("header")?.textContent,
    doc.querySelector<HTMLElement>("#lblMarked")?.textContent,
    doc.querySelector<HTMLElement>("#lblUnMarked")?.textContent
  ].filter(Boolean).join(" ");
  return parseRuiyaProgress(text);
}

function visibleText(doc: Document, selector: string) {
  const element = doc.querySelector<HTMLElement>(selector);
  return element && isRendered(element) ? element.textContent?.replace(/\s+/g, " ").trim() ?? "" : "";
}

function batchComplete(doc: Document) {
  const progress = markingProgress(doc);
  if (progress && progress.total > 0 && progress.completed >= progress.total) return true;
  const completionText = [visibleText(doc, "#alertSpan"), visibleText(doc, "#msgSpan"), visibleText(doc, "#tecMessageModel .modal-body")]
    .filter(Boolean)
    .join(" ");
  return isRuiyaBatchCompletionText(completionText);
}

function currentQuestionLabel(doc: Document) {
  const subject = doc.querySelector<HTMLElement>("#lblSub")?.textContent?.replace(/\s+/g, " ").trim();
  const topic = doc.querySelector<HTMLElement>(".btn-group .dropdown-toggle")?.textContent?.replace(/\s+/g, " ").trim()
    || doc.querySelector<HTMLElement>("#td-rpe-title")?.textContent?.replace(/\s+/g, " ").trim();
  const value = [subject, topic].filter(Boolean).join(" · ");
  return value.length <= 80 ? value || undefined : value.slice(0, 80);
}

async function waitForPageChange(previousPageKey: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const doc = gradingDocument();
    if (doc) {
      const current = pageFingerprint(doc);
      if (current && current !== previousPageKey) return "changed" as const;
      if (batchComplete(doc)) return "completed" as const;
    }
    await wait(150);
  }
  return undefined;
}

function submissionFeedback(doc: Document) {
  return [visibleText(doc, "#alertSpan"), visibleText(doc, "#msgSpan")].filter(Boolean).join(" ");
}

function parseAbsoluteFeedbackScore(text: string) {
  const match = text.match(/(?:得分|分数|总分)\s*[:：=]?\s*(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}

function isExplicitSubmissionAcknowledgement(text: string, feedbackScore: number | undefined) {
  return /保存成功|提交成功|评分成功|已保存/.test(text) || (feedbackScore !== undefined && /得分|分数|总分/.test(text));
}

function pageTokenAfterSubmission(expected: string | undefined, current: string | undefined) {
  if (!expected || !current) return expected === current;
  const expectedParts = expected.match(/^(.*)@(\d+)$/);
  const currentParts = current.match(/^(.*)@(\d+)$/);
  if (!expectedParts || !currentParts || expectedParts[1] !== currentParts[1]) return false;
  const expectedEpoch = Number(expectedParts[2]);
  const currentEpoch = Number(currentParts[2]);
  // The click listener increments the page token once. Test pages without a
  // native listener keep the same epoch, which is also safe when the page key
  // and every score field still match.
  return currentEpoch === expectedEpoch || currentEpoch === expectedEpoch + 1;
}

function submissionProbe(
  previousPageKey: string,
  previousProgress: ReturnType<typeof markingProgress>,
  previousFeedback: string,
  previousStudent: string | undefined,
  previousImage: string | undefined,
  expected: WrittenScoreSnapshot,
  payload: ScoreWritePayload,
  getPageToken: (doc: Document) => string | undefined
) {
  const deadline = Date.now() + 12_000;
  return new Promise<SubmissionSignal>((resolve, reject) => {
    const poll = () => {
      const doc = gradingDocument();
      if (doc) {
        const feedback = submissionFeedback(doc);
        const feedbackScore = parseAbsoluteFeedbackScore(feedback);
        if (feedback !== previousFeedback && isExplicitSubmissionAcknowledgement(feedback, feedbackScore)) {
          if (feedbackScore !== undefined && Math.abs(feedbackScore - payload.score) > 1e-6) {
            return resolve({ kind: "conflict", feedback, feedbackScore });
          }
          const currentToken = getPageToken(doc);
          if (pageFingerprint(doc) === expected.pageKey
            && pageTokenAfterSubmission(expected.pageToken, currentToken)
            && scoreReadbackMatches(doc, payload, expected)) {
            return resolve({ kind: "acknowledged", feedback, feedbackScore });
          }
        }
        const currentKey = pageFingerprint(doc);
        if (currentKey && currentKey !== previousPageKey) return resolve({ kind: "changed", feedback });
        if (batchComplete(doc)) return resolve({ kind: "completed", feedback });
        const progress = markingProgress(doc);
        if (previousProgress && progress && progress.completed > previousProgress.completed) return resolve({ kind: "progressed", feedback });
        const student = currentStudentId(doc);
        const image = imageSource(answerImage(doc));
        if (previousStudent && student && student !== previousStudent) return resolve({ kind: "changed", feedback });
        if (previousImage && image && image !== previousImage) return resolve({ kind: "changed", feedback });
      }
      if (Date.now() >= deadline) return reject(new Error("睿芽云保存状态不确定：未获得与待写字段和值一致的回读确认"));
      window.setTimeout(poll, 100);
    };
    poll();
  });
}

async function confirmZeroIfNeeded(doc: Document) {
  const deadline = Date.now() + 1_200;
  let sawModal = false;
  while (Date.now() < deadline) {
    const modal = doc.querySelector<HTMLElement>("#zeroCheckModal");
    if (modal && isRendered(modal)) {
      sawModal = true;
      const confirm = doc.querySelector<HTMLElement>("#btn_0_ok");
      if (confirm && !isDisabled(confirm)) {
        confirm.click();
        return;
      }
    }
    await wait(50);
  }
  if (sawModal) throw new Error("睿芽云零分确认弹窗未找到可用的确认按钮");
}

export function createRuiyaAdapter(): SiteAdapter {
  const observedControls = new WeakSet<HTMLElement>();
  let pageEpoch = 0;
  const observeSubmitControl = (doc: Document) => {
    const control = doc.querySelector<HTMLElement>("#submitMark");
    if (!control || observedControls.has(control)) return;
    observedControls.add(control);
    control.addEventListener("click", () => { pageEpoch += 1; }, { capture: true });
  };
  const currentPageToken = (doc = gradingDocument()) => {
    if (!doc) return undefined;
    observeSubmitControl(doc);
    const identity = pageIdentity(doc);
    return identity ? `ruiya-page-${fnv1a(identity)}@${pageEpoch}` : undefined;
  };
  const readCurrentAnswer = async () => {
    const doc = gradingDocument();
    if (!doc) throw new Error("未找到睿芽云阅卷页面");
    const card = answerCard(doc);
    const imageElement = answerImage(doc);
    const sourcePageKey = pageFingerprint(doc);
    const pageToken = currentPageToken(doc);
    if (!card || !imageElement) throw new Error("未找到睿芽云当前学生答卷原图");
    if (!sourcePageKey || !pageToken) throw new Error("无法生成睿芽云当前答卷的稳定页面标识，已拒绝提取");
    const image = await extractAnswerImage({ card, image: imageElement });
    const settledDoc = gradingDocument();
    if (!settledDoc
      || answerCard(settledDoc) !== card
      || pageFingerprint(settledDoc) !== sourcePageKey
      || currentPageToken(settledDoc) !== pageToken) {
      throw new StaleAnswerError("读取答卷期间睿芽云页面已经切换，已拒绝继续处理旧答卷");
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
    if (!doc) throw new StaleAnswerError("写分前睿芽云阅卷页面已经离线，已拒绝写入");
    const initialPageKey = pageFingerprint(doc);
    const initialPageToken = currentPageToken(doc);
    if (payload.expectedPageKey && initialPageKey !== payload.expectedPageKey) {
      throw new StaleAnswerError("写分前检测到睿芽云页面已经切换，已拒绝写入旧答卷分数");
    }
    if (payload.expectedPageToken && initialPageToken !== payload.expectedPageToken) {
      throw new StaleAnswerError("写分前检测到睿芽云当前答卷实例已经变化，已拒绝写入旧答卷分数");
    }
    if (payload.expectedImageHash) {
      const current = await readCurrentAnswer();
      doc = gradingDocument();
      if (!doc) throw new StaleAnswerError("写分前睿芽云阅卷页面已经离线，已拒绝写入");
      if (payload.expectedPageKey && current.sourcePageKey !== payload.expectedPageKey) {
        throw new StaleAnswerError("写分前检测到睿芽云页面已经切换，已拒绝写入旧答卷分数");
      }
      if (payload.expectedPageToken && current.pageToken !== payload.expectedPageToken) {
        throw new StaleAnswerError("写分前检测到睿芽云当前答卷实例已经变化，已拒绝写入旧答卷分数");
      }
      if (current.imageHash !== payload.expectedImageHash) {
        throw new StaleAnswerError("写分前检测到睿芽云答卷图像已经变化，已拒绝写入旧答卷分数");
      }
    }
    const finalDoc = gradingDocument();
    const finalPageKey = finalDoc ? pageFingerprint(finalDoc) : undefined;
    const finalPageToken = currentPageToken(finalDoc);
    if (!finalDoc) throw new StaleAnswerError("写分前睿芽云阅卷页面已经离线，已拒绝写入");
    if (payload.expectedPageKey && finalPageKey !== payload.expectedPageKey) {
      throw new StaleAnswerError("写分前检测到睿芽云页面已经切换，已拒绝写入旧答卷分数");
    }
    if (payload.expectedPageToken && finalPageToken !== payload.expectedPageToken) {
      throw new StaleAnswerError("写分前检测到睿芽云当前答卷实例已经变化，已拒绝写入旧答卷分数");
    }
    return finalDoc;
  };
  let writtenSnapshot: WrittenScoreSnapshot | undefined;
  let submittedPageKey: string | undefined;
  let pendingSubmission: SubmissionProbe | undefined;

  const applyScorePayload = async (payload: ScoreWritePayload, rollbackAfter: boolean) => {
    const doc = await assertCurrentTarget(payload);
    const inputs = scoreInputs(doc);
    if (!inputs.length) throw new Error(`睿芽云当前页面没有可写分数框；${scoreInputDiagnostics(doc)}`);
    const fields = scoreFieldsForInputs(inputs);
    const plan = buildRuiyaScorePlan(payload, fields);
    const previousValues = inputs.map((input) => input.value);
    let restored = false;
    const restore = async () => {
      inputs.forEach((input, index) => setInputValue(input, previousValues[index]));
      await wait(180);
      inputs.forEach((input, index) => {
        if (input.value !== previousValues[index]) throw new Error(`睿芽云分数框 ${fields[index].label || fields[index].id} 回滚失败`);
      });
      restored = true;
    };
    try {
      inputs.forEach((input, index) => setInputValue(input, String(plan.values[index])));
      await wait(180);
      inputs.forEach((input, index) => {
        if (Number(input.value) !== plan.values[index]) throw new Error(`睿芽云分数框 ${fields[index].label || fields[index].id} 写入校验失败`);
      });
      const result = {
        supported: true,
        rolledBack: rollbackAfter,
        fieldValues: inputs.map((input, index) => ({
          id: fields[index].id,
          value: plan.values[index],
          maxScore: fields[index].maxScore
        })),
        total: payload.score,
        message: rollbackAfter
          ? (plan.source === "subquestions" ? "睿芽云各小题最终总分写入校验成功，已恢复原值" : "睿芽云最终总分写入校验成功，已恢复原值")
          : (plan.source === "subquestions" ? "睿芽云各小题最终总分写入校验成功" : "睿芽云最终总分写入校验成功")
      };
      if (rollbackAfter) await restore();
      else {
        const pageKey = pageFingerprint(doc);
        if (!pageKey) throw new StaleAnswerError("写分后无法确认睿芽云当前答卷，已拒绝保留未验证的分数状态");
        writtenSnapshot = snapshotForInputs(payload, pageKey, currentPageToken(doc), inputs, fields, plan);
      }
      return result;
    } catch (error) {
      if (!restored) await restore().catch(() => undefined);
      throw error;
    }
  };

  return {
    manifest: RUIYA_ADAPTER_MANIFEST,
    matches: matchesRuiyaUrl,
    async preflight() {
      const doc = gradingDocument();
      const image = doc ? answerImage(doc) : null;
      const inputs = doc ? scoreInputs(doc) : [];
      const submit = doc?.querySelector<HTMLElement>("#submitMark") ?? null;
      const pageKey = doc ? pageFingerprint(doc) : undefined;
      const completed = Boolean(doc && batchComplete(doc));
      const capabilities = {
        answerImage: Boolean(image),
        scoreInput: inputs.length > 0,
        submit: Boolean(submit && !isDisabled(submit)),
        // 睿芽云没有独立的“下一份”按钮，提交当前分数后由站点自动装载下一份。
        next: Boolean(submit && !isDisabled(submit)),
        skip: false
      };
      const issues: string[] = [];
      if (!doc) issues.push("未找到睿芽云阅卷页面");
      if (!completed) {
        if (!pageKey) issues.push("无法生成睿芽云当前答卷的稳定页面标识");
        if (!capabilities.answerImage) issues.push("未找到睿芽云当前学生答卷原图");
        if (!inputs.length) issues.push(`未找到睿芽云最终分数框；${doc ? scoreInputDiagnostics(doc) : "阅卷页面不可用"}`);
        const mappingIssue = scoreFieldSetupIssue(inputs);
        if (mappingIssue) issues.push(mappingIssue);
        if (!capabilities.submit) issues.push("未找到可用的睿芽云提交按钮");
      }
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
      const inputs = doc ? scoreInputs(doc) : [];
      const scoreFields = scoreFieldsForInputs(inputs).map(({ id, label, maxScore }) => ({ id, label: label || id, maxScore }));
      const complete = Boolean(doc && batchComplete(doc));
      return {
        ok: preflight.ok,
        issues: preflight.issues,
        adapterId: RUIYA_ADAPTER_MANIFEST.id,
        adapterName: RUIYA_ADAPTER_MANIFEST.name,
        pageKey: preflight.pageKey,
        pageTitle: document.title || "睿芽考试服务云平台",
        questionLabel: doc ? currentQuestionLabel(doc) : undefined,
        fullScore: doc ? totalMaximum(doc) : undefined,
        scoreFields,
        // #autoSubmit 只控制睿芽键盘/鼠标模式的站点行为，自动流水线使用提交按钮并等待站点装载下一份。
        autoSubmit: undefined,
        batchComplete: complete,
        progress: doc ? markingProgress(doc) : undefined,
        capabilities: preflight.capabilities
      };
    },
    async getCurrentAnswer() {
      return readCurrentAnswer();
    },
    async setDiagnosticScore(score) {
      const doc = gradingDocument();
      if (!doc) throw new Error("睿芽云阅卷页面已离线");
      const inputs = scoreInputs(doc);
      if (inputs.length !== 1) {
        throw new Error(inputs.length > 1
          ? `睿芽云当前页面有 ${inputs.length} 个小题总分框，不能用单一测试总分覆盖；请在安全试运行中按小题结果验证写分`
          : "睿芽云当前页面没有可写分数框");
      }
      const input = inputs[0];
      const maximum = scoreInputMaximum(input);
      if (score !== undefined) {
        if (!Number.isFinite(score) || score < 0) throw new Error("测试分数必须是大于等于 0 的数字");
        if (maximum !== undefined && score > maximum) throw new Error(`测试分数不能超过网页满分 ${maximum}`);
      }
      writtenSnapshot = undefined;
      submittedPageKey = undefined;
      pendingSubmission = undefined;
      setInputValue(input, score === undefined ? "" : String(score));
      await wait(180);
      const matched = score === undefined ? input.value === "" : Number(input.value) === score;
      if (!matched) throw new Error(score === undefined ? "睿芽云总分框清空校验失败" : "睿芽云总分写入校验失败");
      return { fieldId: input.id || "score", score };
    },
    async navigateForDiagnostic() {
      throw new Error("睿芽云没有独立的上一份或下一份控件；必须提交当前分数后由站点自动进入下一份");
    },
    async writeScore(payload) {
      await applyScorePayload(payload, false);
    },
    async testScoreWrite(payload) {
      return applyScorePayload(payload, true);
    },
    async submitScore(payload) {
      const doc = await assertCurrentTarget(payload);
      const submit = doc.querySelector<HTMLElement>("#submitMark");
      if (!submit) throw new Error("未找到睿芽云提交分数按钮");
      if (!writtenSnapshot || writtenSnapshot.payloadSignature !== scorePayloadSignature(payload)) {
        throw new Error("提交前尚未完成睿芽云分数写入校验");
      }
      if (isDisabled(submit)) throw new Error("睿芽云提交分数按钮当前不可用");
      const previousPageKey = pageFingerprint(doc);
      if (!previousPageKey) throw new StaleAnswerError("提交前无法确认睿芽云当前答卷，已拒绝提交");
      if (writtenSnapshot.pageKey !== previousPageKey) {
        throw new StaleAnswerError("提交前检测到已写分快照与当前答卷不一致，已拒绝提交");
      }
      submittedPageKey = previousPageKey;
      pendingSubmission = {
        previousPageKey,
        promise: submissionProbe(
          previousPageKey,
          markingProgress(doc),
          submissionFeedback(doc),
          currentStudentId(doc),
          imageSource(answerImage(doc)),
          writtenSnapshot,
          payload,
          currentPageToken
        )
      };
      submit.click();
      if (payload.score === 0) await confirmZeroIfNeeded(doc);
    },
    async verifySubmission(payload) {
      if (!writtenSnapshot || writtenSnapshot.payloadSignature !== scorePayloadSignature(payload)) {
        throw new Error("睿芽云待校验分数与已写入分数不一致");
      }
      if (!pendingSubmission) throw new Error("睿芽云提交状态丢失");
      const signal = await pendingSubmission.promise;
      pendingSubmission = undefined;
      if (signal.kind !== "acknowledged") {
        throw new Error(`睿芽云保存状态不确定：${signal.kind === "conflict" ? "页面反馈分数与待写分数不一致" : "只检测到页面变化或弱提交信号，未能回读当前字段和值"}`);
      }

      const doc = gradingDocument();
      if (!doc || pageFingerprint(doc) !== writtenSnapshot.pageKey) {
        throw new StaleAnswerError("分数确认期间睿芽云页面已经切换，已拒绝把当前答卷标记为已提交");
      }
      if (!pageTokenAfterSubmission(writtenSnapshot.pageToken, currentPageToken(doc))) {
        throw new StaleAnswerError("分数确认期间睿芽云答卷实例已经变化，已拒绝把当前答卷标记为已提交");
      }
      if (!scoreReadbackMatches(doc, payload, writtenSnapshot)) {
        throw new Error("睿芽云保存状态不确定：提交后的字段身份或分值回读与待写快照不一致");
      }
      if (payload.expectedImageHash) {
        const current = await readCurrentAnswer();
        if (current.sourcePageKey !== writtenSnapshot.pageKey || current.imageHash !== payload.expectedImageHash) {
          throw new StaleAnswerError("分数确认期间睿芽云答卷图像已经变化，已拒绝把当前答卷标记为已提交");
        }
      }
      writtenSnapshot = undefined;
    },
    async goToNext() {
      const previousPageKey = submittedPageKey;
      if (!previousPageKey) throw new Error("睿芽云尚未确认当前答卷已提交，无法进入下一份");
      const transition = await waitForPageChange(previousPageKey, 12_000);
      if (!transition) throw new Error("睿芽云提交后下一份答卷未加载");
      submittedPageKey = undefined;
    },
    async detectPageChange(previousPageKey) {
      const transition = await waitForPageChange(previousPageKey, 12_000);
      if (transition) return transition;
      throw new Error("睿芽云下一份答卷未加载");
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
