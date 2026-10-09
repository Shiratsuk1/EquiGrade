import { createHash } from "node:crypto";
import {
  SAFE_LATEX_PROTOCOL_INSTRUCTION,
  decodeSafeLatexTokens,
  findDamagedLatexControlPath,
  repairLatexJsonEscapes
} from "../shared/formulaProtocol.js";
import { applyModelRouteSystemPrompt } from "../shared/modelRouting.js";
import type { ModelCallLogDetails, ModelConfigInput, ModelRouteKey, TeacherReasoningEffort } from "../shared/types.js";
import { findInvalidFormulaPath } from "./formulaValidation.js";
import { assertSafeModelBaseUrl } from "./outboundUrlPolicy.js";
import { getOutboundProxyDispatcher } from "./outboundTransport.js";
import {
  getOperationSignal,
  isOperationCancelled,
  logEvent,
  OperationCancelledError,
  throwIfOperationCancelled
} from "./systemLog.js";

type JsonSchema = Record<string, unknown>;

interface StructuredRequest<T = unknown> {
  model: string;
  routeKey?: ModelRouteKey;
  system: string;
  prompt: string;
  images?: Array<{ mimeType: string; base64: string; label?: string }>;
  schemaName: string;
  schema: JsonSchema;
  validate?: (value: unknown) => T;
  reasoningEffort?: TeacherReasoningEffort;
  operationId?: string;
}

type AppliedReasoningEffort = Exclude<TeacherReasoningEffort, "disabled">;

interface ModelHttpResult {
  raw: string;
  status: number;
  durationMs: number;
  responseHeadersMs?: number;
  firstContentMs?: number;
  streamDurationMs?: number;
  outputChars?: number;
  streamEventCount?: number;
  streamContentMode?: "delta" | "message_snapshot" | "text";
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
  };
  server?: string;
  contentType?: string;
  cfRay?: string;
}

type StreamMetrics = Pick<
  ModelHttpResult,
  "responseHeadersMs" | "firstContentMs" | "streamDurationMs" | "outputChars" | "streamEventCount" | "streamContentMode" | "usage"
>;

type CompleteStreamMetrics = StreamMetrics & {
  streamDurationMs: number;
  outputChars: number;
  streamEventCount: number;
};

type ModelResponseBody = {
  raw: string;
  firstContentMs?: number;
  streamDurationMs?: number;
  outputChars?: number;
  streamEventCount?: number;
  streamContentMode?: "delta" | "message_snapshot" | "text";
  usage?: ModelHttpResult["usage"];
};

class ModelStreamError extends Error {
  constructor(message: string, readonly streamMetrics: StreamMetrics) {
    super(message);
    this.name = "ModelStreamError";
  }
}

interface ModelResponseChoice {
  content: string;
  finishReason?: string;
}

// A 128x128, 8-bit RGB PNG with four colored quadrants. Some vision
// providers reject 1x1 grayscale/alpha images during preprocessing.
const VISION_CONNECTION_TEST_PNG = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABJElEQVR4nO3RQQ0CQRBFwRWBphGBCIThBQd7xsHeVwFXXjpTL19Ap+t4KO2oD9g9AHEA4gDEAYgDEAcg7ifAd60RW+/niAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARiz/LID+uQAGDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANgcYL3OEbs+a8QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACOWfxZA/1wAAwYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABsDqD/BCAOQByAOABxAOIAxAGIuwGhpQ3AHxJWhgAAAABJRU5ErkJggg==";
const MODEL_CLIENT_USER_AGENT = "Hengzhun-Physics-Grading/0.1";

type ModelCallOutcome = "completed" | "retrying" | "strict_rejected" | "failed";

let activeModelCalls = 0;
const modelCallWaiters: Array<{ limit: number; grant: () => void }> = [];

function acquireModelCallSlot(configuredLimit: number, signal?: AbortSignal): Promise<() => void> {
  const limit = Math.max(1, Math.floor(configuredLimit));
  return new Promise((resolve, reject) => {
    let queued = false;
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      if (queued) {
        const index = modelCallWaiters.findIndex((waiter) => waiter.grant === grant);
        if (index >= 0) modelCallWaiters.splice(index, 1);
      }
      reject(new OperationCancelledError());
    };
    const grant = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      activeModelCalls += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeModelCalls = Math.max(0, activeModelCalls - 1);
        for (let index = 0; index < modelCallWaiters.length;) {
          const waiter = modelCallWaiters[index];
          if (activeModelCalls >= waiter.limit) {
            index += 1;
            continue;
          }
          modelCallWaiters.splice(index, 1);
          waiter.grant();
        }
      });
    };
    if (signal?.aborted) {
      cancel();
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
    if (activeModelCalls < limit) grant();
    else {
      queued = true;
      modelCallWaiters.push({ limit, grant });
    }
  });
}

function extractModelChoice(payload: unknown): ModelResponseChoice {
  const body = payload as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: { content?: string | Array<{ type?: string; text?: string }> };
    }>;
  };
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") {
    return { content, ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}) };
  }
  if (Array.isArray(content)) {
    return {
      content: content.map((item) => item.text ?? "").join(""),
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {})
    };
  }
  throw new Error("模型响应中缺少 choices[0].message.content");
}

function contentFragment(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    const text = (item as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("");
}

function parseJson(content: string): unknown {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const repaired = repairLatexJsonEscapes(cleaned);
  try {
    const parsed = JSON.parse(repaired.json) as unknown;
    const damagedPath = findDamagedLatexControlPath(parsed);
    if (damagedPath) {
      throw new Error(`模型 JSON 在 ${damagedPath} 中包含被控制字符损坏的 LaTeX 命令`);
    }
    const decoded = decodeSafeLatexTokens(parsed);
    const formulaIssue = findInvalidFormulaPath(decoded);
    if (formulaIssue) {
      throw new Error(`模型 JSON 在 ${formulaIssue.path} 中包含无法由 KaTeX 渲染的公式：${formulaIssue.reason}`);
    }
    return decoded;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("模型 JSON")) throw error;
    throw new Error(`模型未返回完整有效的 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,}\]"']+/gi, "$1[REDACTED]");
}

function cloudflareAccessHeaders(endpoint: string): Record<string, string> {
  const configuredHost = process.env.HENGZHUN_CLOUDFLARE_ACCESS_HOST?.trim().toLowerCase();
  const clientId = process.env.HENGZHUN_CLOUDFLARE_ACCESS_CLIENT_ID?.trim();
  const clientSecret = process.env.HENGZHUN_CLOUDFLARE_ACCESS_CLIENT_SECRET?.trim();
  const configured = Boolean(configuredHost || clientId || clientSecret);
  if (!configured) return {};
  if (!configuredHost || !clientId || !clientSecret) {
    throw new Error("Cloudflare Access Service Token 配置不完整：必须同时设置 HENGZHUN_CLOUDFLARE_ACCESS_HOST、HENGZHUN_CLOUDFLARE_ACCESS_CLIENT_ID 和 HENGZHUN_CLOUDFLARE_ACCESS_CLIENT_SECRET");
  }
  const hostname = new URL(endpoint).hostname.toLowerCase();
  if (hostname !== configuredHost) return {};
  return {
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret
  };
}

function isCloudflareBlock(result: ModelHttpResult): boolean {
  if (result.status !== 403) return false;
  const headers = `${result.server ?? ""} ${result.contentType ?? ""}`.toLowerCase();
  const body = result.raw.slice(0, 8_000).toLowerCase();
  return headers.includes("cloudflare")
    || Boolean(result.cfRay)
    || body.includes("attention required")
    || body.includes("you have been blocked")
    || body.includes("cloudflare");
}

function modelHttpError(result: ModelHttpResult): string {
  if (isCloudflareBlock(result)) {
    const ray = result.cfRay ? `，CF-RAY ${result.cfRay}` : "";
    return `Cloudflare 拦截了模型 API 请求（403${ray}）：当前返回的是 HTML 阻断页，不是 OpenAI 兼容 JSON。请让站点管理员为 /v1/chat/completions 配置 API 放行规则，或配置 Cloudflare Access Service Token；浏览器 User-Agent 和挑战 Cookie 不能替代授权`;
  }
  return `模型服务返回 ${result.status}: ${redactSecrets(result.raw.slice(0, 800))}`;
}

function isUnsupportedStructuredOutputResponse(result: ModelHttpResult | undefined): boolean {
  if (!result || ![400, 404, 405, 415, 422].includes(result.status)) return false;
  const body = result.raw.toLowerCase();
  if (result.status === 400 && body.includes("upstream request failed")) return true;
  return /(?:json_schema|json_object|response_format|structured output|structured_output)/.test(body)
    && /(?:unsupported|not supported|unknown|unrecognized|unexpected|not allowed|invalid|无法|不支持)/.test(body);
}

function isStructuredContentError(error: Error, result: ModelHttpResult | undefined): boolean {
  if (!(result && result.status >= 200 && result.status < 300)) return false;
  const message = error.message;
  if (/模型未返回完整有效的 JSON|模型返回的 JSON 不符合|Unexpected token|Unexpected end|Unexpected non-whitespace|模型响应中缺少/.test(message)) return true;
  if (!message.includes("模型 JSON")) return false;
  return message.includes("无法由 KaTeX 渲染的公式")
    || message.includes("被控制字符损坏的 LaTeX 命令")
    || message.includes("未安全编码的 LaTeX 反斜杠");
}

function shouldRetrySameMode(error: Error, result: ModelHttpResult | undefined): boolean {
  if (isStructuredContentError(error, result)) return true;
  if (result) {
    if (result.status === 524) return false;
    return [408, 425, 429, 500, 502, 503, 504].includes(result.status);
  }
  const message = error.message.toLowerCase();
  return /fetch failed|econn|socket|network|stream disconnected|stream closed|stream interrupted|terminated|流式响应.*中断|流中断|终止|aborted|timeout/.test(message);
}

function structuredOutputRetryGuidance(schemaName: string): string {
  const common = [
    "上一轮输出已被本地结构或业务校验拒绝，请重新生成完整 JSON，不要原样重复上一轮结果。",
    `当前请求的 schemaName 是 ${schemaName}，只允许输出本次 response_format.json_schema 定义的字段；不要套用其他批改链路的字段，不要输出 Markdown、解释性前缀或隐藏推理。`
  ];
  switch (schemaName) {
    case "large_question_answer_triage":
      return [...common, "本次只返回 answers 和 transcription；每个小问只能出现一次，并完整包含 subquestionId、blockIds、status、studentAnswer、confidence、reason；transcription.lines 必须逐个覆盖请求中给出的全部 OCR 区块，并完整包含 blockId、text、latex、status、confidence、alternatives；不要输出 evidence、decisions、pointJudgements 或 review_items。"].join("\n");
    case "large_question_point_review":
      return [...common, "本次只返回 reviews；每个目标小问必须覆盖全部评分点，并完整包含 decisions、appliedDeductions；每个 decision 必须包含 awardedScore，不能省略或改成其他字段名。LaTeX 中成对的花括号必须转义：使用 \\left\\{ ... \\right\\}，禁止写成 \\left{ ... \\right}。"].join("\n");
    case "direct_visual_review":
      return [...common, "本次只返回 reviews；每条复核结果必须包含 review_id、result、certainty、reason，不能返回评分、转录或其他批改字段。"].join("\n");
    case "direct_vision_grading":
    case "small_question_grading":
    case "process_point_judgement_with_commentary":
      return [...common, "评分点对象必须遵守本次 schema 的状态、证据引用和 awardedScore 约束：不要在 satisfied 或 unreadable 中加入 awardedScore；notSatisfied 的 awardedScore 必须存在且在允许范围内。"].join("\n");
    default:
      return [...common, "严格遵守字段必填性、枚举值、数组覆盖范围和 additionalProperties=false 约束；字段缺失、额外字段或业务值不一致都会导致本轮失败。"].join("\n");
  }
}

interface SseAssemblyState {
  buffer: string;
  dataLines: string[];
  content: string;
  contentMode?: "delta" | "message_snapshot" | "text";
  firstContentAt?: number;
  eventCount: number;
  streamStartedAt: number;
  finishReason?: string;
  sawPayload: boolean;
  done: boolean;
  usage?: ModelHttpResult["usage"];
}

function formatStreamError(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function appendSsePayload(state: SseAssemblyState, payload: unknown): void {
  state.eventCount += 1;
  if (!payload || typeof payload !== "object") return;
  const body = payload as {
    error?: unknown;
    choices?: unknown;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      reasoning_tokens?: unknown;
    };
  };
  if (body.error) {
    throw new Error(`模型服务流式响应报错：${redactSecrets(formatStreamError(body.error).slice(0, 800))}`);
  }
  if (!Array.isArray(body.choices)) return;
  const choice = body.choices[0];
  if (!choice || typeof choice !== "object") return;
  const typedChoice = choice as {
    delta?: { content?: unknown };
    message?: { content?: unknown };
    text?: unknown;
    finish_reason?: unknown;
  };
  const delta = typedChoice.delta;
  const source = delta && Object.prototype.hasOwnProperty.call(delta, "content")
    ? "delta" as const
    : typedChoice.message && Object.prototype.hasOwnProperty.call(typedChoice.message, "content")
      ? "message_snapshot" as const
      : Object.prototype.hasOwnProperty.call(typedChoice, "text")
        ? "text" as const
        : undefined;
  const content = source === "delta"
    ? delta?.content
    : source === "message_snapshot"
      ? typedChoice.message?.content
      : typedChoice.text;
  const fragment = contentFragment(content);
  if (source) {
    if (fragment && state.contentMode && state.contentMode !== source) {
      throw new Error(`模型流式响应混用了 ${state.contentMode} 和 ${source} 内容协议`);
    }
    if (fragment) {
      state.contentMode = source;
      if (state.firstContentAt === undefined) state.firstContentAt = performance.now();
    }
    if (source === "message_snapshot") state.content = fragment;
    else if (fragment) state.content += fragment;
  }
  if (typeof typedChoice.finish_reason === "string") {
    state.finishReason = typedChoice.finish_reason;
  }
  if (body.usage && typeof body.usage === "object") {
    const usage = body.usage;
    state.usage = {
      ...(typeof usage.prompt_tokens === "number" ? { promptTokens: usage.prompt_tokens } : {}),
      ...(typeof usage.completion_tokens === "number" ? { completionTokens: usage.completion_tokens } : {}),
      ...(typeof usage.reasoning_tokens === "number" ? { reasoningTokens: usage.reasoning_tokens } : {})
    };
  }
  state.sawPayload = true;
}

function dispatchSseEvent(state: SseAssemblyState): void {
  if (state.done || state.dataLines.length === 0) return;
  const data = state.dataLines.join("\n");
  state.dataLines = [];
  if (data.trim() === "[DONE]") {
    state.done = true;
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch (error) {
    throw new Error(`模型流式响应包含无效 SSE JSON：${redactSecrets(String(error).slice(0, 400))}`);
  }
  appendSsePayload(state, payload);
}

function consumeSseLine(state: SseAssemblyState, rawLine: string): void {
  if (state.done) return;
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (line === "") {
    dispatchSseEvent(state);
    return;
  }
  if (line.startsWith(":")) return;
  if (line.startsWith("data:")) {
    state.dataLines.push(line.slice(5).replace(/^ /, ""));
  }
}

function consumeSseText(state: SseAssemblyState, text: string): void {
  state.buffer += text;
  while (!state.done) {
    const newline = state.buffer.indexOf("\n");
    if (newline < 0) return;
    const line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    consumeSseLine(state, line);
  }
}

async function readSseResponse(response: Response, requestStartedAt: number): Promise<{
  raw: string;
  firstContentMs?: number;
  streamDurationMs: number;
  outputChars: number;
  streamEventCount: number;
  streamContentMode?: "delta" | "message_snapshot" | "text";
  usage?: ModelHttpResult["usage"];
}> {
  if (!response.body) throw new Error("模型服务返回了空的流式响应体");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state: SseAssemblyState = {
    buffer: "",
    dataLines: [],
    content: "",
    eventCount: 0,
    streamStartedAt: performance.now(),
    sawPayload: false,
    done: false
  };
  const streamMetrics = (): CompleteStreamMetrics => ({
    ...(state.firstContentAt !== undefined ? { firstContentMs: Math.round(state.firstContentAt - requestStartedAt) } : {}),
    streamDurationMs: Math.round(performance.now() - state.streamStartedAt),
    outputChars: state.content.length,
    streamEventCount: state.eventCount,
    ...(state.contentMode ? { streamContentMode: state.contentMode } : {}),
    ...(state.usage ? { usage: state.usage } : {})
  });
  try {
    while (!state.done) {
      const { value, done } = await reader.read();
      if (done) break;
      consumeSseText(state, decoder.decode(value, { stream: true }));
    }
    if (!state.done) {
      consumeSseText(state, decoder.decode());
      if (state.buffer) {
        consumeSseLine(state, state.buffer);
        state.buffer = "";
      }
      dispatchSseEvent(state);
    } else {
      await reader.cancel().catch(() => undefined);
    }
    if (!state.done) {
      throw new Error("模型流式响应在 [DONE] 前中断");
    }
    if (!state.sawPayload) throw new Error("模型流式响应未包含有效 choices");
    const raw = JSON.stringify({
      choices: [{
        message: { content: state.content },
        ...(state.finishReason ? { finish_reason: state.finishReason } : {})
      }],
      ...(state.usage ? {
        usage: {
          ...(state.usage.promptTokens !== undefined ? { prompt_tokens: state.usage.promptTokens } : {}),
          ...(state.usage.completionTokens !== undefined ? { completion_tokens: state.usage.completionTokens } : {}),
          ...(state.usage.reasoningTokens !== undefined ? { reasoning_tokens: state.usage.reasoningTokens } : {})
        }
      } : {})
    });
    return { raw, ...streamMetrics() };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ModelStreamError) throw error;
    throw new ModelStreamError(error instanceof Error ? error.message : String(error), streamMetrics());
  } finally {
    reader.releaseLock();
  }
}

async function readModelResponseBody(response: Response, requestStartedAt: number): Promise<ModelResponseBody> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream")
    ? readSseResponse(response, requestStartedAt)
    : { raw: await response.text() };
}

function imageLogMetadata(image: { mimeType: string; base64: string; label?: string }) {
  const bytes = Buffer.from(image.base64, "base64");
  return {
    ...(image.label ? { label: redactSecrets(image.label) } : {}),
    mimeType: image.mimeType,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function contentFromRaw(raw: string): string | undefined {
  try {
    return extractModelChoice(JSON.parse(raw)).content;
  } catch {
    return undefined;
  }
}

function usageFromRaw(raw: string): ModelHttpResult["usage"] | undefined {
  try {
    const usage = (JSON.parse(raw) as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; reasoning_tokens?: unknown } }).usage;
    if (!usage || typeof usage !== "object") return undefined;
    const result = {
      ...(typeof usage.prompt_tokens === "number" ? { promptTokens: usage.prompt_tokens } : {}),
      ...(typeof usage.completion_tokens === "number" ? { completionTokens: usage.completion_tokens } : {}),
      ...(typeof usage.reasoning_tokens === "number" ? { reasoningTokens: usage.reasoning_tokens } : {})
    };
    return Object.keys(result).length ? result : undefined;
  } catch {
    return undefined;
  }
}

function resolveReasoningEffort(value: TeacherReasoningEffort | undefined): AppliedReasoningEffort | undefined {
  return value && value !== "disabled" ? value : undefined;
}

function summarizeValidationError(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues?: Array<{ path?: PropertyKey[]; message?: string }> }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues.slice(0, 5).map((issue) => {
        const path = issue.path?.length ? issue.path.map(String).join(".") : "根对象";
        return `${path}: ${issue.message ?? "字段不符合约定"}`;
      }).join("；");
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function classifyModelCallError(error: unknown): ModelCallLogDetails["errorClass"] {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|超时/i.test(message)) return "timeout";
  if (/cancel|terminated|强制停止/i.test(message)) return "terminated";
  if (/Unexpected token|JSON.parse|JSON 解析|无效 JSON/i.test(message)) return "invalid_json";
  if (/schema|结构约定|校验|JSON/i.test(message)) return /latex|反斜杠|LaTeX/i.test(message) ? "latex_protocol_error" : "schema_mismatch";
  if (/HTTP|状态(?:码)?|返回|status/i.test(message)) return "http_error";
  if (/URL|fetch|连接|代理|网络|socket|ECONN|ENOTFOUND/i.test(message)) return "transport_failure";
  return "unknown";
}

function validateStructuredData<T>(input: StructuredRequest<T>, value: unknown): T {
  if (!input.validate) return value as T;
  try {
    return input.validate(value);
  } catch (error) {
    throw new Error(`模型返回的 JSON 不符合 ${input.schemaName} 结构约定：${summarizeValidationError(error)}`);
  }
}

function chatCompletionsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`;
}

function recordModelCall<T>(
  config: ModelConfigInput,
  input: StructuredRequest<T>,
  mode: string,
  attempt: number,
  maxAttempts: number,
  userContent: Array<Record<string, unknown>>,
  responseFormat: Record<string, unknown> | undefined,
  reasoningEffort: AppliedReasoningEffort | undefined,
  response: ModelHttpResult | undefined,
  durationMs: number,
  error?: unknown,
  outcome: ModelCallOutcome = error ? "failed" : "completed"
) {
  if (!input.operationId) return;
  const streamMetrics = error instanceof ModelStreamError ? error.streamMetrics : undefined;
  const metricSource = response ?? streamMetrics;
  const userPrompt = userContent.find((item) => item.type === "text")?.text;
  const details: ModelCallLogDetails = {
    kind: "model_call",
    callId: crypto.randomUUID(),
    model: input.model,
    ...(input.routeKey ? { routeKey: input.routeKey } : {}),
    configuration: {
      name: config.name,
      baseUrl: config.baseUrl.replace(/\/+$/, "")
    },
    schemaName: input.schemaName,
    outputMode: mode,
    attempt,
    maxAttempts,
    durationMs,
    ...(metricSource?.responseHeadersMs !== undefined ? { responseHeadersMs: metricSource.responseHeadersMs } : {}),
    ...(metricSource?.firstContentMs !== undefined ? { firstContentMs: metricSource.firstContentMs } : {}),
    ...(metricSource?.streamDurationMs !== undefined ? { streamDurationMs: metricSource.streamDurationMs } : {}),
    ...(metricSource?.outputChars !== undefined ? { outputChars: metricSource.outputChars } : {}),
    ...(metricSource?.streamEventCount !== undefined ? { streamEventCount: metricSource.streamEventCount } : {}),
    ...(metricSource?.streamContentMode ? { streamContentMode: metricSource.streamContentMode } : {}),
    ...(metricSource?.usage ? { usage: metricSource.usage } : {}),
    request: {
      systemPrompt: redactSecrets(input.system),
      userPrompt: redactSecrets(typeof userPrompt === "string" ? userPrompt : ""),
      images: (input.images ?? []).map(imageLogMetadata),
      ...(responseFormat ? { responseFormat } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    },
    ...(response ? {
      response: {
        status: response.status,
        raw: redactSecrets(response.raw),
        ...(contentFromRaw(response.raw) ? { content: redactSecrets(contentFromRaw(response.raw) as string) } : {})
      }
    } : {}),
    ...(error ? {
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
      errorClass: classifyModelCallError(error)
    } : {})
  };
  const message = outcome === "completed"
    ? `模型调用完成：${input.schemaName}`
    : outcome === "retrying"
      ? `模型调用暂时失败，准备重试：${input.schemaName}`
      : outcome === "strict_rejected"
        ? `严格 JSON Schema 请求被上游拒绝：${input.schemaName}`
        : `模型调用失败：${input.schemaName}`;
  logEvent(
    input.operationId,
    "model",
    "model_call",
    message,
    details,
    outcome === "completed" ? "success" : outcome === "failed" || outcome === "strict_rejected" ? "error" : "warning",
    outcome === "completed" ? "completed" : outcome === "failed" || outcome === "strict_rejected" ? "failed" : "progress"
  );
}

async function request(
  config: ModelConfigInput,
  body: Record<string, unknown>,
  signal: AbortSignal
): Promise<ModelHttpResult> {
  await assertSafeModelBaseUrl(config.baseUrl);
  const endpoint = chatCompletionsEndpoint(config.baseUrl);
  const dispatcher = getOutboundProxyDispatcher();
  const transportLabel = dispatcher ? "通过代理请求" : "直连请求";
  const startedAt = performance.now();
  const buildRequestInit = (requestBody: Record<string, unknown>): RequestInit & { dispatcher?: unknown } => ({
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      "User-Agent": MODEL_CLIENT_USER_AGENT,
      Authorization: `Bearer ${config.apiKey ?? ""}`,
      ...cloudflareAccessHeaders(endpoint)
    },
    body: JSON.stringify(requestBody),
    signal,
    ...(dispatcher ? { dispatcher } : {})
  });
  const fetchResult = async (requestBody: Record<string, unknown>): Promise<ModelHttpResult> => {
    let response: Response;
    try {
      response = await fetch(endpoint, buildRequestInit(requestBody));
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`模型${transportLabel} URL ${endpoint} 失败：${reason}`);
    }
    const responseHeadersMs = Math.round(performance.now() - startedAt);
    let body: ModelResponseBody;
    try {
      body = response.status >= 200 && response.status < 300
        ? await readModelResponseBody(response, startedAt)
        : { raw: await response.text() };
    } catch (error) {
      if (error instanceof ModelStreamError) {
        error.streamMetrics.responseHeadersMs = responseHeadersMs;
      }
      throw error;
    }
    const usage = body.usage ?? usageFromRaw(body.raw);
    if (response.status >= 300 && response.status < 400) {
      throw new Error("模型服务返回了重定向；为防止凭据被转发，必须直接配置最终 HTTPS 地址");
    }
    return {
      raw: body.raw,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      responseHeadersMs,
      ...(body.firstContentMs !== undefined ? { firstContentMs: body.firstContentMs } : {
        ...(body.raw.trim() ? { firstContentMs: Math.round(performance.now() - startedAt) } : {})
      }),
      ...(body.streamDurationMs !== undefined ? { streamDurationMs: body.streamDurationMs } : {}),
      ...(body.outputChars !== undefined ? { outputChars: body.outputChars } : { outputChars: contentFromRaw(body.raw)?.length ?? body.raw.length }),
      ...(body.streamEventCount !== undefined ? { streamEventCount: body.streamEventCount } : {}),
      ...(body.streamContentMode ? { streamContentMode: body.streamContentMode } : {}),
      ...(usage ? { usage } : {}),
      server: response.headers.get("server") ?? undefined,
      contentType: response.headers.get("content-type") ?? undefined,
      cfRay: response.headers.get("cf-ray") ?? undefined
    };
  };

  return fetchResult({ ...body, stream: true });
}

async function callStructuredInternal<T>(
  config: ModelConfigInput,
  input: StructuredRequest<T>
): Promise<{ data: T; durationMs: number; outputMode: string }> {
  throwIfOperationCancelled(input.operationId);
  if ((input.images?.length ?? 0) > 0 && !config.supportsBase64Images) {
    throw new Error("当前全局模型配置未启用 Base64 图片，无法执行包含图片的模型调用");
  }
  const protectedInput: StructuredRequest<T> = {
    ...input,
    system: `${applyModelRouteSystemPrompt(input.system, input.routeKey ? config.modelRoutes?.[input.routeKey] : undefined)}\n\n${SAFE_LATEX_PROTOCOL_INSTRUCTION}`
  };
  const imageContent: Array<Record<string, unknown>> = [];
  for (const image of protectedInput.images ?? []) {
    if (image.label) imageContent.push({ type: "text", text: image.label });
    imageContent.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: "high" }
    });
  }

  const buildModeUserContent = (prompt: string): Array<Record<string, unknown>> => [
    {
      type: "text",
      text: prompt
    },
    ...imageContent
  ];

  // The grading contract requires provider-enforced strict structured output.
  // Capability flags are kept in the persisted config for compatibility, but
  // this version deliberately never downgrades to json_object or prompt_json.
  const mode = "json_schema" as const;
  const reasoningEffort = resolveReasoningEffort(protectedInput.reasoningEffort);
  let lastError: Error | null = null;
  const maxAttempts = Math.max(1, Math.floor(config.maxRetries) + 1);
  let remainingAttempts = maxAttempts;
  let validationCorrection = "";

  let modeAttempts = 0;
  while (remainingAttempts > 0 && modeAttempts < 2) {
      throwIfOperationCancelled(protectedInput.operationId);
      const attemptNumber = maxAttempts - remainingAttempts + 1;
      remainingAttempts -= 1;
      modeAttempts += 1;
      const controller = new AbortController();
      const operationSignal = getOperationSignal(protectedInput.operationId);
      const abortForOperation = () => controller.abort(operationSignal?.reason ?? new OperationCancelledError());
      if (operationSignal?.aborted) abortForOperation();
      else operationSignal?.addEventListener("abort", abortForOperation, { once: true });
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      const attemptStartedAt = performance.now();
      let httpResult: ModelHttpResult | undefined;
      const promptForAttempt = validationCorrection
        ? `${protectedInput.prompt}\n\n${validationCorrection}`
        : protectedInput.prompt;
      const modeUserContent = buildModeUserContent(promptForAttempt);
      const responseFormat = { type: "json_schema", json_schema: { name: protectedInput.schemaName, strict: true, schema: protectedInput.schema } };
      try {
        const body: Record<string, unknown> = {
          model: protectedInput.model,
          messages: [
            { role: "system", content: protectedInput.system },
            { role: "user", content: modeUserContent }
          ],
          temperature: 0,
          max_tokens: config.maxOutputTokens
        };
        if (reasoningEffort) body.reasoning_effort = reasoningEffort;
        if (responseFormat) body.response_format = responseFormat;
        httpResult = await request(config, body, controller.signal);
        if (httpResult.status < 200 || httpResult.status >= 300) {
          throw new Error(modelHttpError(httpResult));
        }
        const modelChoice = extractModelChoice(JSON.parse(httpResult.raw));
        if (modelChoice.finishReason === "length") {
          throw new Error("模型输出达到 Token 上限，结构化 JSON 可能被截断");
        }
        if (modelChoice.finishReason === "content_filter") {
          throw new Error("模型响应被内容过滤器截断");
        }
        const data = validateStructuredData(protectedInput, parseJson(modelChoice.content));
        recordModelCall(
          config,
          protectedInput,
          mode,
          attemptNumber,
          maxAttempts,
          modeUserContent,
          responseFormat,
          reasoningEffort,
          httpResult,
          httpResult.durationMs
        );
        return {
          data,
          durationMs: httpResult.durationMs,
          outputMode: mode
        };
      } catch (error) {
        lastError = operationSignal?.aborted || isOperationCancelled(error)
          ? new OperationCancelledError()
          : error instanceof Error ? error : new Error(String(error));
        const unsupportedStructuredOutput = isUnsupportedStructuredOutputResponse(httpResult);
        if (isStructuredContentError(lastError, httpResult)) {
          validationCorrection = [
            structuredOutputRetryGuidance(protectedInput.schemaName),
            `本地校验摘要：${lastError.message}`
          ].join("\n");
        }
        const retrySameMode = !unsupportedStructuredOutput
          && remainingAttempts > 0
          && modeAttempts < 2
          && shouldRetrySameMode(lastError, httpResult);
        recordModelCall(
          config,
          protectedInput,
          mode,
          attemptNumber,
          maxAttempts,
          modeUserContent,
          responseFormat,
          reasoningEffort,
          httpResult,
          httpResult?.durationMs ?? Math.round(performance.now() - attemptStartedAt),
          lastError,
          retrySameMode ? "retrying" : unsupportedStructuredOutput ? "strict_rejected" : "failed"
        );
        if (isOperationCancelled(lastError)) throw lastError;
        if (unsupportedStructuredOutput) throw lastError;
        if (httpResult?.status === 524) throw lastError;
        if (retrySameMode) {
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timeout);
        operationSignal?.removeEventListener("abort", abortForOperation);
      }
  }
  throw lastError ?? new Error("模型调用失败");
}

export async function callStructured<T>(
  config: ModelConfigInput,
  input: StructuredRequest<T>
): Promise<{ data: T; durationMs: number; outputMode: string }> {
  throwIfOperationCancelled(input.operationId);
  const release = await acquireModelCallSlot(config.maxConcurrency, getOperationSignal(input.operationId));
  try {
    throwIfOperationCancelled(input.operationId);
    return await callStructuredInternal(config, input);
  } finally {
    release();
  }
}

/** Share the existing process-wide model-call concurrency guard with other
 * transports (the Responses Agent client is intentionally a separate wire
 * protocol and must not be routed through chat/completions). */
export async function withModelCallSlot<T>(
  config: Pick<ModelConfigInput, "maxConcurrency">,
  operationId: string | undefined,
  task: () => Promise<T>
): Promise<T> {
  const release = await acquireModelCallSlot(config.maxConcurrency, getOperationSignal(operationId));
  try {
    throwIfOperationCancelled(operationId);
    return await task();
  } finally {
    release();
  }
}

export function resolveReviewModelConfig(config: ModelConfigInput, modelOverride?: string): ModelConfigInput {
  const reviewModel = modelOverride?.trim() || config.reviewModel?.trim();
  if (!reviewModel) throw new Error("未配置局部审验模型");
  const reviewApiKey = config.reviewApiKey?.trim();
  if (!reviewApiKey) throw new Error("局部审验模型缺少独立 API Key，系统不会使用教师模型密钥代替");
  return {
    ...config,
    baseUrl: config.reviewBaseUrl?.trim() || config.baseUrl,
    apiKey: reviewApiKey,
    reviewModel
  };
}

export async function testModelConnection(
  config: ModelConfigInput,
  mode: "text" | "vision" | "review",
  operationId?: string
): Promise<{ ok: true; durationMs: number; model: string; message: string }> {
  const effectiveConfig = mode === "review" ? resolveReviewModelConfig(config) : config;
  const model = mode === "vision"
    ? effectiveConfig.visionModel
    : mode === "review"
      ? effectiveConfig.reviewModel!
      : effectiveConfig.textModel;
  const result = await callStructured<{ status: string }>({
    ...effectiveConfig,
    // A connection check is deliberately short, but one retry still helps
    // with a transient direct transport failure.
    maxRetries: Math.min(1, Math.max(1, Math.floor(effectiveConfig.maxRetries))),
    maxOutputTokens: Math.min(effectiveConfig.maxOutputTokens, 256)
  }, {
    model,
    system: "Return only valid JSON. Do not include markdown.",
    prompt: mode === "vision" || mode === "review"
      ? "Inspect the supplied RGB test image. Return {\"status\":\"ok\"}."
      : "Return {\"status\":\"ok\"}.",
    images: mode === "vision" || mode === "review" ? [{
      mimeType: "image/png",
      base64: VISION_CONNECTION_TEST_PNG,
      label: "[视觉连接测试图：128x128 RGB PNG]"
    }] : undefined,
    schemaName: "connection_test",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { status: { type: "string" } },
      required: ["status"]
    },
    validate: (value) => {
      const candidate = value as { status?: unknown };
      if (!candidate || typeof candidate.status !== "string") {
        throw new Error("status 必须是字符串");
      }
      return { status: candidate.status };
    },
    operationId
  });
  return {
    ok: true,
    durationMs: result.durationMs,
    model,
    message: `连接成功，结构化输出模式：${result.outputMode}`
  };
}
