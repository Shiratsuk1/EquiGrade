import { ipcRenderer } from "electron";
import type {
  PipelineControl,
  PipelineDryRunOptions,
  PipelineDryRunResult,
  PluginDiagnosticRequest,
  PluginDiagnosticTargetResult,
  PluginCapabilities,
  PluginPhase,
  PluginRequest,
  PluginResponse,
  PluginStatus,
  PluginUiPreferences,
  UiFontFamily,
  UiMonoFontFamily
} from "../../shared/electron.js";
import { EMPTY_PLUGIN_STATUS } from "../../shared/electron.js";
import type { GradingResult } from "../../shared/types.js";
import {
  pluginFontStacks,
  pluginMonoFontStacks,
  pluginPhaseLabels,
  pluginThemes
} from "../../shared/uiConstants.js";
import { createGenericDataAdapter } from "./genericDataAdapter.js";
import { createMockAdapter } from "./mockAdapter.js";
import { createZhixueAdapter } from "./zhixueAdapter.js";
import {
  assertSameAnswer,
  commitFailureMessage,
  failureRequiresPause,
  isStaleAnswerError,
  StaleAnswerError,
  type PipelineCommitStage
} from "./pipelineSafety.js";
import {
  emptyPluginCapabilities,
  hasRequiredPluginCapabilities,
  samePreflightTarget,
  sanitizePreflightResult,
  type PreflightTarget
} from "./preflightSafety.js";
import type { ExtractedAnswer, ScoreWritePayload, SiteAdapter } from "./types.js";

type GradingResponse = {
  score: number;
  maxScore: number;
  status: string;
  requiresReview: boolean;
  imageHash?: string;
  result?: GradingResult;
};

const adapters = [createMockAdapter(), createZhixueAdapter(), createGenericDataAdapter()];
let adapter: SiteAdapter = selectAdapter();
let status: PluginStatus = {
  ...EMPTY_PLUGIN_STATUS,
  connected: true,
  adapterId: adapter.manifest.id,
  adapterName: adapter.manifest.name,
  adapterVersion: adapter.manifest.version,
  phase: "handshaking",
  message: "正在检查目标网页结构",
  updatedAt: new Date().toISOString()
};
let running = false;
let pauseRequested = false;
let stopRequested = false;
let skipRequested = false;
let pageGeneration = 0;
let lastObservedUrl = window.location.href;
let preflightRun: { target: PreflightTarget; promise: Promise<boolean> } | null = null;
let pluginPreferences: PluginUiPreferences = {
  accent: "teal",
  visible: true,
  defaultCollapsed: false,
  position: "bottom-right",
  confirmBeforeStart: true,
  material: "mica",
  motionIntensity: "comfortable",
  reduceMotion: false,
  fontFamily: "noto-sans-sc",
  monoFontFamily: "cascadia",
  fontWeight: 500,
  fontScale: 1.1,
  lineHeight: 1.5,
  letterSpacing: 0
};

function selectAdapter() {
  const currentUrl = new URL(window.location.href);
  return adapters.find((candidate) => candidate.matches(currentUrl)) ?? adapters.at(-1)!;
}

function invalidatePage(message = "正在重新检查阅卷页面") {
  pageGeneration += 1;
  lastObservedUrl = window.location.href;
  preflightRun = null;
  adapter = selectAdapter();
  phase("preflight", message, {
    adapterId: adapter.manifest.id,
    adapterName: adapter.manifest.name,
    adapterVersion: adapter.manifest.version,
    capabilities: emptyPluginCapabilities(),
    pageKey: undefined
  });
}

function currentPreflightTarget() {
  const url = window.location.href;
  if (url !== lastObservedUrl) invalidatePage();
  return { generation: pageGeneration, url: window.location.href };
}

function isCurrentPreflight(target: PreflightTarget) {
  return samePreflightTarget(target, currentPreflightTarget());
}

function record(event: Record<string, unknown>) {
  ipcRenderer.send("pipeline:event", {
    adapterId: adapter.manifest.id,
    phase: status.phase,
    ...event
  });
}

function publish(patch: Partial<PluginStatus>) {
  status = {
    ...status,
    ...patch,
    capabilities: patch.capabilities ? { ...patch.capabilities } : status.capabilities,
    updatedAt: new Date().toISOString()
  };
  ipcRenderer.send("plugin:status", status);
  if (document.body && document.documentElement) updateWidget();
}

function phase(next: PluginPhase, message: string, patch: Partial<PluginStatus> = {}) {
  publish({ ...patch, phase: next, message });
  record({ type: "pipeline_phase", nextPhase: next, message, pageKey: patch.pageKey });
}

function statusLabel(value: PluginPhase) {
  return pluginPhaseLabels[value];
}

function ensureWidget() {
  let widget = document.getElementById("hengzhun-grading-plugin");
  if (widget) return widget;
  widget = document.createElement("aside");
  widget.id = "hengzhun-grading-plugin";
  widget.innerHTML = `
    <div class="hz-plugin-head"><span class="hz-plugin-mark">衡准</span><strong>阅卷插件</strong><button data-hz-collapse title="折叠插件">−</button></div>
    <div class="hz-plugin-body">
      <div class="hz-plugin-state"><i></i><span data-hz-state>连接中</span><b data-hz-score>-- / --</b></div>
      <p data-hz-message>正在连接当前网页</p>
      <div class="hz-plugin-actions"><button data-hz-start>开始批改</button><button data-hz-pause disabled>暂停</button></div>
    </div>`;
  const style = document.createElement("style");
  style.textContent = `
    #hengzhun-grading-plugin{--hz-accent:#13a8a2;--hz-accent-hover:#0d8c88;--hz-accent-soft:#e8f8f6;--hz-accent-ring:rgba(19,168,162,.14);--hz-surface:#f6fafa;--hz-filter:blur(10px) saturate(115%);--hz-font-family:"Noto Sans SC","Noto Sans CJK SC","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif;--hz-mono-font-family:"Cascadia Code","Cascadia Mono",Consolas,monospace;--hz-font-weight:500;--hz-font-scale:1.1;--hz-line-height:1.5;--hz-letter-spacing:0em;position:fixed;z-index:2147483647;right:16px;bottom:16px;width:236px;border:1px solid rgba(255,255,255,.72);border-radius:9px;background:var(--hz-surface);backdrop-filter:var(--hz-filter);-webkit-backdrop-filter:var(--hz-filter);box-shadow:0 8px 20px rgba(32,41,51,.14),0 1px 2px rgba(32,41,51,.08);font-family:var(--hz-font-family);font-size:calc(12px * var(--hz-font-scale));font-weight:var(--hz-font-weight);line-height:var(--hz-line-height);color:#202933;letter-spacing:var(--hz-letter-spacing);transition:transform .22s cubic-bezier(.22,1,.36,1),box-shadow .22s cubic-bezier(.22,1,.36,1)}
    #hengzhun-grading-plugin *{box-sizing:border-box;letter-spacing:inherit}
    .hz-plugin-head{height:38px;display:flex;align-items:center;gap:7px;padding:0 9px;border-bottom:1px solid #e2e8ec}.hz-plugin-mark{padding:3px 5px;border-radius:3px;background:var(--hz-accent);color:#fff;font-size:9px;font-weight:800}.hz-plugin-head strong{font-size:12px}.hz-plugin-head button{margin-left:auto;width:25px;height:25px;border:0;background:transparent;color:#66717d;font-size:17px;cursor:pointer}
    .hz-plugin-body{padding:10px}.hz-plugin-state{display:flex;align-items:center;gap:6px}.hz-plugin-state i{width:7px;height:7px;border-radius:50%;background:var(--hz-accent);box-shadow:0 0 0 3px var(--hz-accent-ring)}.hz-plugin-state span{color:#66717d;font-size:10px}.hz-plugin-state b{margin-left:auto;color:var(--hz-accent);font-size:13px}.hz-plugin-body p{min-height:30px;margin:8px 0;color:#66717d;font-size:10px;line-height:1.5}.hz-plugin-actions{display:grid;grid-template-columns:1fr 64px;gap:6px}.hz-plugin-actions button{height:30px;border:1px solid #cfd9de;border-radius:4px;background:#fff;color:#202933;font:inherit;font-size:10px;font-weight:750;cursor:pointer}.hz-plugin-actions button:first-child{border-color:var(--hz-accent);background:var(--hz-accent);color:#fff}.hz-plugin-actions button:first-child:hover{border-color:var(--hz-accent-hover);background:var(--hz-accent-hover)}.hz-plugin-actions button:disabled{opacity:.45;cursor:default}
    #hengzhun-grading-plugin.hz-solid{--hz-surface:#f5f8f8;--hz-filter:none}.hz-acrylic{--hz-surface:rgba(255,255,255,.92);--hz-filter:blur(8px) saturate(110%)}.hz-collapsed{width:154px}.hz-collapsed .hz-plugin-body{display:none}.hz-collapsed .hz-plugin-head{border-bottom:0}.hz-motion-off,.hz-motion-off *{animation:none!important;transition:none!important}
    #hengzhun-grading-plugin.hz-left{right:auto;left:16px}
  `;
  document.documentElement.appendChild(style);
  document.body.appendChild(widget);
  widget.querySelector<HTMLButtonElement>("[data-hz-collapse]")!.addEventListener("click", () => {
    widget!.classList.toggle("hz-collapsed");
    widget!.querySelector<HTMLButtonElement>("[data-hz-collapse]")!.textContent = widget!.classList.contains("hz-collapsed") ? "+" : "−";
  });
  widget.querySelector<HTMLButtonElement>("[data-hz-start]")!.addEventListener("click", () => {
    if (pluginPreferences.confirmBeforeStart && !window.confirm("开始批改会向智学网写入并提交真实分数，确定继续吗？")) return;
    void control("start");
  });
  widget.querySelector<HTMLButtonElement>("[data-hz-pause]")!.addEventListener("click", () => void control("pause"));
  applyPluginPreferences(widget);
  return widget;
}

function applyPluginPreferences(widget = document.getElementById("hengzhun-grading-plugin")) {
  if (!widget) return;
  const theme = pluginThemes[pluginPreferences.accent];
  const material = pluginPreferences.material ?? "mica";
  const motionOff = pluginPreferences.reduceMotion === true || pluginPreferences.motionIntensity === "off";
  widget.style.setProperty("--hz-accent", theme.accent);
  widget.style.setProperty("--hz-accent-hover", theme.hover);
  widget.style.setProperty("--hz-accent-soft", theme.soft);
  widget.style.setProperty("--hz-accent-ring", theme.ring);
  widget.style.setProperty("--hz-font-family", pluginFontStacks[pluginPreferences.fontFamily ?? "noto-sans-sc"]);
  widget.style.setProperty("--hz-mono-font-family", pluginMonoFontStacks[pluginPreferences.monoFontFamily ?? "cascadia"]);
  widget.style.setProperty("--hz-font-weight", String(pluginPreferences.fontWeight ?? 500));
  widget.style.setProperty("--hz-font-scale", String(pluginPreferences.fontScale ?? 1.1));
  widget.style.setProperty("--hz-line-height", String(pluginPreferences.lineHeight ?? 1.5));
  widget.style.setProperty("--hz-letter-spacing", `${pluginPreferences.letterSpacing ?? 0}em`);
  widget.style.display = pluginPreferences.visible ? "block" : "none";
  widget.classList.toggle("hz-left", pluginPreferences.position === "bottom-left");
  widget.classList.toggle("hz-collapsed", pluginPreferences.defaultCollapsed);
  widget.classList.toggle("hz-solid", material === "solid");
  widget.classList.toggle("hz-acrylic", material === "acrylic");
  widget.classList.toggle("hz-motion-off", motionOff);
  const collapse = widget.querySelector<HTMLButtonElement>("[data-hz-collapse]");
  if (collapse) collapse.textContent = pluginPreferences.defaultCollapsed ? "+" : "−";
}

function updateWidget() {
  const widget = ensureWidget();
  widget.querySelector("[data-hz-state]")!.textContent = statusLabel(status.phase);
  widget.querySelector("[data-hz-message]")!.textContent = status.message;
  widget.querySelector("[data-hz-score]")!.textContent = status.lastScore === undefined ? "-- / --" : `${status.lastScore} / ${status.maxScore ?? "--"}`;
  widget.querySelector<HTMLButtonElement>("[data-hz-start]")!.disabled = running
    || status.phase !== "ready"
    || !hasRequiredPluginCapabilities(status.capabilities);
  widget.querySelector<HTMLButtonElement>("[data-hz-pause]")!.disabled = !running;
}

async function runPreflight() {
  const target = currentPreflightTarget();
  if (preflightRun && samePreflightTarget(preflightRun.target, target)) return preflightRun.promise;

  const candidateAdapter = selectAdapter();
  adapter = candidateAdapter;
  const promise = (async () => {
    phase("preflight", "正在检查答卷图片、评分框和翻页控件", {
      adapterId: candidateAdapter.manifest.id,
      adapterName: candidateAdapter.manifest.name,
      adapterVersion: candidateAdapter.manifest.version,
      capabilities: emptyPluginCapabilities(),
      pageKey: undefined
    });
    const deadline = Date.now() + 12_000;
    let rawResult = await candidateAdapter.preflight();
    while (!rawResult.ok && Date.now() < deadline) {
      if (!isCurrentPreflight(target)) return false;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      rawResult = await candidateAdapter.preflight();
    }
    if (!isCurrentPreflight(target)) return false;

    const result = sanitizePreflightResult(rawResult, candidateAdapter.isBatchComplete());
    publish({
      adapterId: candidateAdapter.manifest.id,
      adapterName: candidateAdapter.manifest.name,
      adapterVersion: candidateAdapter.manifest.version,
      capabilities: result.capabilities,
      pageKey: result.pageKey
    });
    if (!result.ok) {
      phase("failed", result.issues.join("；"));
      record({ type: "plugin_preflight_failed", issues: result.issues, capabilities: result.capabilities });
      return false;
    }
    phase("ready", "站点适配完成，可以开始自动批改", { pageKey: result.pageKey });
    record({ type: "plugin_preflight_completed", capabilities: result.capabilities, pageKey: result.pageKey });
    return true;
  })();
  const currentRun = { target, promise };
  preflightRun = currentRun;
  try {
    return await promise;
  } finally {
    if (preflightRun === currentRun) preflightRun = null;
  }
}

/** 流水线内部中断信号。使用带 code 的错误类而非魔法字符串，避免错误被包装/改写后控制流失效。 */
type PipelineInterruptCode = "stopped" | "paused" | "skip" | "review";

class PipelineInterruptError extends Error {
  readonly code: PipelineInterruptCode;

  constructor(code: PipelineInterruptCode, message: string) {
    super(message);
    this.name = "PipelineInterruptError";
    this.code = code;
  }
}

function checkInterruption() {
  if (stopRequested) throw new PipelineInterruptError("stopped", "流水线已停止");
  if (pauseRequested) throw new PipelineInterruptError("paused", "流水线已暂停");
  if (skipRequested) throw new PipelineInterruptError("skip", "用户跳过当前答卷");
}

function readableRemoteError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : String(error || fallback);
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || fallback;
}

async function gradeCurrent(answer: ExtractedAnswer) {
  phase("grading", "教师模型正在直接查看学生答卷图片", { pageKey: answer.sourcePageKey ?? answer.pageKey });
  return await ipcRenderer.invoke("pipeline:grade-image", {
    pageKey: answer.pageKey,
    imageHash: answer.imageHash,
    sourcePageKey: answer.sourcePageKey,
    imageDataUrl: answer.imageDataUrl
  }) as GradingResponse;
}

function scorePayload(grading: GradingResponse, answer: ExtractedAnswer): ScoreWritePayload {
  return {
    score: grading.score,
    maxScore: grading.maxScore,
    expectedPageKey: answer.sourcePageKey ?? answer.pageKey,
    expectedPageToken: answer.pageToken,
    expectedImageHash: answer.imageHash,
    segments: (grading.result?.subquestions ?? []).map((subquestion) => ({
      id: subquestion.id,
      title: subquestion.title,
      score: subquestion.score,
      maxScore: subquestion.maxScore,
      points: subquestion.decisions.map((decision) => ({
        id: decision.pointId,
        score: decision.awardedScore,
        maxScore: decision.maxScore
      }))
    }))
  };
}

async function confirmCurrentAnswer(expected: ExtractedAnswer) {
  const currentPageKey = adapter.currentPageKey();
  if (expected.sourcePageKey && currentPageKey !== expected.sourcePageKey) {
    throw new StaleAnswerError("模型批改期间阅卷页面已经切换，已拒绝写入旧答卷分数");
  }
  const current = await adapter.getCurrentAnswer();
  assertSameAnswer(expected, current);
  return current;
}

async function skipAnswer(previousPageKey: string) {
  phase("skipped", "正在记录异常并跳过当前答卷", { pageKey: previousPageKey });
  await adapter.goToNext();
  return await adapter.detectPageChange(previousPageKey);
}

async function runPipeline() {
  if (running) return;
  running = true;
  pauseRequested = false;
  stopRequested = false;
  skipRequested = false;
  publish({ consecutiveFailures: 0 });
  record({ type: "pipeline_started", mode: "teacher_model_direct_vision", adapterId: adapter.manifest.id });

  try {
    if (!(await runPreflight())) return;
    while (!stopRequested && !pauseRequested) {
      if (adapter.isBatchComplete()) {
        phase("completed", "本批次答卷已全部提交");
        record({ type: "pipeline_completed" });
        return;
      }

      let answer: ExtractedAnswer | null = null;
      let commitStage: PipelineCommitStage = "untouched";
      const fallbackPageKey = adapter.currentPageKey() ?? "unknown";
      try {
        checkInterruption();
        phase("extracting", "正在读取当前学生答卷原始图像", { pageKey: fallbackPageKey });
        answer = await adapter.getCurrentAnswer();
        const transitionKey = answer.sourcePageKey ?? answer.pageKey;
        record({
          type: "image_extracted",
          pageKey: answer.pageKey,
          sourcePageKey: answer.sourcePageKey,
          imageHash: answer.imageHash,
          imageSource: answer.imageSource,
          imageBytes: answer.imageBytes,
          imageMimeType: answer.imageMimeType
        });
        checkInterruption();
        const grading = await gradeCurrent(answer);
        checkInterruption();
        if (grading.status !== "completed" || grading.requiresReview) throw new PipelineInterruptError("review", "教师模型要求人工复核");
        if (!Number.isFinite(grading.score) || !Number.isFinite(grading.maxScore)) throw new Error("教师模型返回的分数无效");
        if (grading.imageHash && grading.imageHash !== answer.imageHash) throw new Error("批改结果与当前答卷图像哈希不一致");
        await confirmCurrentAnswer(answer);
        const score = scorePayload(grading, answer);

        phase("writing_score", `正在写入 ${grading.score} 分`, { pageKey: transitionKey });
        commitStage = "write_started";
        await adapter.writeScore(score);
        commitStage = "score_written";
        checkInterruption();
        await confirmCurrentAnswer(answer);
        phase("submitting", "正在提交当前答卷分数", { pageKey: transitionKey });
        commitStage = "submit_started";
        await adapter.submitScore(score);
        phase("verifying", "正在验证网页已接收分数", { pageKey: transitionKey });
        await adapter.verifySubmission(score);
        commitStage = "verified";
        record({
          type: "page_completed",
          pageKey: answer.pageKey,
          sourcePageKey: answer.sourcePageKey,
          imageHash: grading.imageHash ?? answer.imageHash,
          score: grading.score,
          maxScore: grading.maxScore,
          segments: score.segments
        });
        publish({ consecutiveFailures: 0, lastScore: grading.score, maxScore: grading.maxScore });
        checkInterruption();
        phase("navigating_next", "当前答卷已提交，正在进入下一份", { pageKey: transitionKey });
        await adapter.goToNext();
        const transition = await adapter.detectPageChange(transitionKey);
        if (transition === "completed") {
          phase("completed", "本批次答卷已全部提交");
          record({ type: "pipeline_completed" });
          return;
        }
        await runPreflight();
      } catch (error) {
        const reason = readableRemoteError(error, "当前答卷处理失败");
        if (stopRequested || reason === "任务已被用户强制停止") {
          phase("idle", "流水线已强制停止");
          record({ type: "pipeline_force_stopped", pageKey: answer?.sourcePageKey ?? answer?.pageKey ?? fallbackPageKey });
          return;
        }
        if (isStaleAnswerError(error)) {
          const currentKey = adapter.currentPageKey() ?? answer?.sourcePageKey ?? answer?.pageKey ?? fallbackPageKey;
          const message = `检测到当前答卷已变化，已停止写分：${reason}`;
          phase("paused", message, { pageKey: currentKey });
          record({
            type: "pipeline_paused_stale_answer",
            pageKey: currentKey,
            expectedPageKey: answer?.sourcePageKey ?? answer?.pageKey,
            imageHash: answer?.imageHash,
            reason
          });
          return;
        }
        if (failureRequiresPause(commitStage)) {
          const currentKey = answer?.sourcePageKey ?? answer?.pageKey ?? fallbackPageKey;
          const message = commitFailureMessage(commitStage, reason);
          phase("paused", message, { pageKey: currentKey });
          record({
            type: "pipeline_paused_commit_uncertain",
            pageKey: currentKey,
            imageHash: answer?.imageHash,
            commitStage,
            reason
          });
          return;
        }
        if (error instanceof PipelineInterruptError) {
          switch (error.code) {
            case "stopped":
              phase("idle", "流水线已停止");
              record({ type: "pipeline_stopped" });
              return;
            case "paused":
              phase("paused", "流水线已按要求暂停");
              record({ type: "pipeline_paused", reason: "用户暂停", consecutiveFailures: status.consecutiveFailures });
              return;
            case "review": {
              const reviewKey = answer?.sourcePageKey ?? answer?.pageKey ?? fallbackPageKey;
              phase("paused", "教师模型要求人工复核，已停留在当前答卷", { pageKey: reviewKey });
              record({
                type: "pipeline_paused",
                pageKey: reviewKey,
                reason: "教师模型结果需要人工复核",
                consecutiveFailures: status.consecutiveFailures
              });
              return;
            }
            case "skip":
              skipRequested = false;
              break;
          }
        }
        const currentKey = answer?.sourcePageKey ?? answer?.pageKey ?? fallbackPageKey;
        const skipped = error instanceof PipelineInterruptError && error.code === "skip";
        const failures = skipped ? status.consecutiveFailures : status.consecutiveFailures + 1;
        publish({ consecutiveFailures: failures });
        record({ type: "page_failed", pageKey: currentKey, reason: skipped ? "用户跳过当前答卷" : reason, consecutiveFailures: failures });
        if (failures >= 3) {
          phase("paused", "连续 3 份答卷处理失败，已自动暂停", { pageKey: currentKey });
          record({ type: "pipeline_paused", pageKey: currentKey, reason: "连续 3 次失败", consecutiveFailures: failures });
          return;
        }
        try {
          const transition = await skipAnswer(currentKey);
          record({ type: "page_skipped", pageKey: currentKey, reason });
          if (transition === "completed") {
            phase("completed", "异常答卷已跳过，本批次处理完成");
            record({ type: "pipeline_completed_after_skip" });
            return;
          }
          await runPreflight();
        } catch (skipError) {
          const skipReason = readableRemoteError(skipError, "异常答卷跳过失败");
          phase("paused", skipReason, { pageKey: currentKey });
          record({ type: "pipeline_paused", pageKey: currentKey, reason: skipReason, consecutiveFailures: failures });
          return;
        }
      }
    }
  } finally {
    running = false;
    updateWidget();
  }
}

async function inspectSetup() {
  if (running) throw new Error("流水线运行中，无法重新检查任务配置");
  adapter = selectAdapter();
  const preflightOk = await runPreflight();
  const inspection = await adapter.inspectSetup();
  if (preflightOk) return inspection;
  return {
    ...inspection,
    ok: false,
    pageKey: undefined,
    capabilities: emptyPluginCapabilities()
  };
}

async function runDryRun(options: PipelineDryRunOptions): Promise<PipelineDryRunResult> {
  if (running) throw new Error("流水线运行中，无法执行试运行");
  adapter = selectAdapter();
  if (!(await runPreflight())) throw new Error(status.message || "目标页面检查未通过");
  phase("extracting", "试运行：正在读取当前答卷原图");
  const answer = await adapter.getCurrentAnswer();
  record({
    type: "dry_run_image_extracted",
    pageKey: answer.pageKey,
    sourcePageKey: answer.sourcePageKey,
    imageHash: answer.imageHash,
    imageBytes: answer.imageBytes,
    imageMimeType: answer.imageMimeType
  });
  phase("grading", "试运行：教师模型正在评分，不会提交成绩", { pageKey: answer.sourcePageKey ?? answer.pageKey });
  const grading = await gradeCurrent(answer);
  if (!Number.isFinite(grading.score) || !Number.isFinite(grading.maxScore)) throw new Error("教师模型返回的分数无效");
  if (grading.imageHash && grading.imageHash !== answer.imageHash) throw new Error("批改结果与当前答卷图像哈希不一致");
  await confirmCurrentAnswer(answer);
  const payload = scorePayload(grading, answer);
  const writeTest = options.verifyWrite
    ? grading.requiresReview
      ? (() => { throw new Error("教师模型要求人工复核，本次试运行未写入网页评分栏"); })()
      : await adapter.testScoreWrite(payload)
    : undefined;
  phase("ready", options.verifyWrite
    ? "试运行完成：评分栏写入校验成功并已恢复原值，未提交成绩"
    : "试运行完成：原图与模型评分正常，未写入或提交成绩", {
    pageKey: answer.sourcePageKey ?? answer.pageKey,
    lastScore: grading.score,
    maxScore: grading.maxScore
  });
  record({
    type: "pipeline_dry_run_completed",
    pageKey: answer.pageKey,
    sourcePageKey: answer.sourcePageKey,
    score: grading.score,
    maxScore: grading.maxScore,
    requiresReview: grading.requiresReview,
    writeVerified: Boolean(writeTest),
    segments: payload.segments
  });
  return {
    pageKey: answer.pageKey,
    sourcePageKey: answer.sourcePageKey,
    imageHash: answer.imageHash,
    imageBytes: answer.imageBytes,
    imageMimeType: answer.imageMimeType,
    imageSource: answer.imageSource,
    score: grading.score,
    maxScore: grading.maxScore,
    status: grading.status,
    requiresReview: grading.requiresReview,
    segments: payload.segments,
    writeTest
  };
}

async function runPluginDiagnostic(request: PluginDiagnosticRequest): Promise<PluginDiagnosticTargetResult> {
  if (running) throw new Error("流水线运行中，无法执行插件行为测试");
  adapter = selectAdapter();
  if (!(await runPreflight())) throw new Error(status.message || "目标页面检查未通过");
  switch (request.action) {
    case "extract-image": {
      phase("extracting", "诊断：正在提取当前学生答卷图像");
      const answer = await adapter.getCurrentAnswer();
      phase("ready", "诊断：学生答卷图像提取成功", { pageKey: answer.sourcePageKey ?? answer.pageKey });
      record({
        type: "plugin_diagnostic_image_extracted",
        pageKey: answer.pageKey,
        sourcePageKey: answer.sourcePageKey,
        imageHash: answer.imageHash,
        imageBytes: answer.imageBytes,
        imageMimeType: answer.imageMimeType,
        imageSource: answer.imageSource
      });
      return {
        action: request.action,
        message: "学生答卷图像提取成功",
        pageKey: answer.sourcePageKey ?? answer.pageKey,
        imageDataUrl: answer.imageDataUrl,
        imageMimeType: answer.imageMimeType,
        imageBytes: answer.imageBytes,
        imageHash: answer.imageHash,
        imageSource: answer.imageSource
      };
    }
    case "write-score":
    case "clear-score": {
      const score = request.action === "clear-score" ? undefined : request.score;
      if (request.action === "write-score" && !Number.isFinite(score)) throw new Error("请输入有效的测试分数");
      phase("writing_score", score === undefined ? "诊断：正在清空最终总分框" : `诊断：正在写入 ${score} 分`);
      const result = await adapter.setDiagnosticScore(score);
      const message = score === undefined
        ? "最终总分框已清空；没有点击提交"
        : `已向最终总分框写入 ${score} 分；没有点击提交`;
      phase("ready", message, { pageKey: adapter.currentPageKey() });
      record({ type: "plugin_diagnostic_score_changed", action: request.action, score, fieldId: result.fieldId, pageKey: adapter.currentPageKey() });
      return { action: request.action, message, pageKey: adapter.currentPageKey(), fieldId: result.fieldId, score: result.score };
    }
    case "previous-page":
    case "next-page": {
      const direction = request.action === "previous-page" ? "previous" : "next";
      const label = direction === "previous" ? "上一份" : "下一份";
      phase("navigating_next", `诊断：正在进入${label}`);
      const result = await adapter.navigateForDiagnostic(direction);
      if (!(await runPreflight())) throw new Error(status.message || "进入下一份后页面检查未通过");
      const message = `插件已控制网页进入${label}；没有填写或提交分数`;
      phase("ready", message, { pageKey: result.pageKey });
      record({ type: "plugin_diagnostic_page_changed", direction, previousPageKey: result.previousPageKey, pageKey: result.pageKey });
      return { action: request.action, message, previousPageKey: result.previousPageKey, pageKey: result.pageKey };
    }
  }
}

async function handlePluginRequest(request: PluginRequest) {
  switch (request.kind) {
    case "inspect-setup":
      return inspectSetup();
    case "dry-run":
      return runDryRun(request.options);
    case "plugin-diagnostic": {
      try {
        return await runPluginDiagnostic(request.diagnostic);
      } catch (error) {
        const reason = readableRemoteError(error, "插件行为测试失败");
        phase("failed", `诊断失败：${reason}`, { pageKey: adapter.currentPageKey() });
        record({ type: "plugin_diagnostic_failed", action: request.diagnostic.action, reason, pageKey: adapter.currentPageKey() });
        throw error;
      }
    }
  }
}

async function skipWhenIdle() {
  if (!(await runPreflight())) return;
  const pageKey = adapter.currentPageKey() ?? "unknown";
  try {
    await adapter.goToNext();
    await adapter.detectPageChange(pageKey);
    record({ type: "page_skipped", pageKey, reason: "用户手动跳过" });
    await runPreflight();
  } catch (error) {
    const reason = readableRemoteError(error, "当前答卷跳过失败");
    phase("failed", reason, { pageKey });
  }
}

async function control(command: PipelineControl) {
  switch (command) {
    case "preflight":
      if (!running) await runPreflight();
      break;
    case "start":
      try {
        await ipcRenderer.invoke("pipeline:assert-task");
        await runPipeline();
      } catch (error) {
        const reason = readableRemoteError(error, "批改任务启动失败");
        phase("failed", reason);
        record({ type: "pipeline_start_rejected", reason });
      }
      break;
    case "pause":
      pauseRequested = true;
      publish({ message: running ? "将在当前原子步骤结束后暂停" : "流水线已暂停", phase: "paused" });
      break;
    case "stop":
      stopRequested = true;
      publish({ message: running ? "将在当前原子步骤结束后停止" : "流水线已停止", phase: "idle" });
      break;
    case "skip":
      if (running) skipRequested = true;
      else await skipWhenIdle();
      break;
  }
}

export function bootPluginRuntime() {
  status = {
    ...status,
    phase: "handshaking",
    message: "插件已注入，正在识别站点适配器",
    updatedAt: new Date().toISOString()
  };
  ipcRenderer.send("plugin:status", status);
  ipcRenderer.on("plugin:command", (_event, payload: { control?: PipelineControl }) => {
    if (payload?.control) void control(payload.control);
  });
  ipcRenderer.on("plugin:preferences", (_event, preferences: PluginUiPreferences) => {
    pluginPreferences = preferences;
    applyPluginPreferences(ensureWidget());
  });
  ipcRenderer.on("plugin:request", (_event, request: PluginRequest) => {
    void (async () => {
      let response: PluginResponse;
      try {
        response = { requestId: request.requestId, ok: true, result: await handlePluginRequest(request) };
      } catch (error) {
        response = {
          requestId: request.requestId,
          ok: false,
          error: readableRemoteError(error, "插件请求执行失败")
        };
      }
      ipcRenderer.send("plugin:response", response);
    })();
  });
  ipcRenderer.on("pipeline:page-invalidated", () => {
    invalidatePage();
  });
  ipcRenderer.on("pipeline:page-ready", () => {
    invalidatePage();
    if (!running) void runPreflight();
  });
  window.addEventListener("DOMContentLoaded", () => {
    ensureWidget();
    publish({ phase: "handshaking", message: "网页已加载，正在执行站点预检" });
    void runPreflight();
  }, { once: true });
}
