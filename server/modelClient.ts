import { createHash } from "node:crypto";
import {
  SAFE_LATEX_PROTOCOL_INSTRUCTION,
  decodeSafeLatexTokens,
  findDamagedLatexControlPath,
  hasUnsafeLatexJsonEscape
} from "../shared/formulaProtocol.js";
import type { ModelCallLogDetails, ModelConfigInput, TeacherReasoningEffort } from "../shared/types.js";
import { findInvalidFormulaPath } from "./formulaValidation.js";
import { assertSafeModelBaseUrl } from "./outboundUrlPolicy.js";
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
}

interface ModelResponseChoice {
  content: string;
  finishReason?: string;
}

// A 128x128, 8-bit RGB PNG with four colored quadrants. Some vision
// providers reject 1x1 grayscale/alpha images during preprocessing.
const VISION_CONNECTION_TEST_PNG = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABJElEQVR4nO3RQQ0CQRBFwRWBphGBCIThBQd7xsHeVwFXXjpTL19Ap+t4KO2oD9g9AHEA4gDEAYgDEAcg7ifAd60RW+/niAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARiz/LID+uQAGDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANgcYL3OEbs+a8QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACOWfxZA/1wAAwYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABsDqD/BCAOQByAOABxAOIAxAGIuwGhpQ3AHxJWhgAAAABJRU5ErkJggg==";

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

function parseJson(content: string): unknown {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (hasUnsafeLatexJsonEscape(cleaned)) {
    throw new Error("模型 JSON 中包含未安全编码的 LaTeX 反斜杠，已拒绝可能损坏的公式");
  }
  try {
    const parsed = JSON.parse(cleaned) as unknown;
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
  error?: unknown
) {
  if (!input.operationId) return;
  const userPrompt = userContent.find((item) => item.type === "text")?.text;
  const details: ModelCallLogDetails = {
    kind: "model_call",
    model: input.model,
    configuration: {
      name: config.name,
      baseUrl: config.baseUrl.replace(/\/+$/, "")
    },
    schemaName: input.schemaName,
    outputMode: mode,
    attempt,
    maxAttempts,
    durationMs,
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
    ...(error ? { error: redactSecrets(error instanceof Error ? error.message : String(error)) } : {})
  };
  logEvent(
    input.operationId,
    "model",
    "model_call",
    error ? `模型调用失败：${input.schemaName}` : `模型调用完成：${input.schemaName}`,
    details,
    error ? "error" : "success",
    error ? "failed" : "completed"
  );
}

async function request(
  config: ModelConfigInput,
  body: Record<string, unknown>,
  signal: AbortSignal
): Promise<ModelHttpResult> {
  await assertSafeModelBaseUrl(config.baseUrl);
  const startedAt = performance.now();
  const response = await fetch(chatCompletionsEndpoint(config.baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey ?? ""}`
    },
    body: JSON.stringify(body),
    signal
  });
  const raw = await response.text();
  if (response.status >= 300 && response.status < 400) {
    throw new Error("模型服务返回了重定向；为防止凭据被转发，必须直接配置最终 HTTPS 地址");
  }
  return { raw, status: response.status, durationMs: Math.round(performance.now() - startedAt) };
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
    system: `${input.system}\n\n${SAFE_LATEX_PROTOCOL_INSTRUCTION}`
  };
  const userContent: Array<Record<string, unknown>> = [{ type: "text", text: protectedInput.prompt }];
  for (const image of protectedInput.images ?? []) {
    if (image.label) userContent.push({ type: "text", text: image.label });
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: "high" }
    });
  }

  const modes = [
    ...(config.supportsJsonSchema ? ["json_schema"] : []),
    ...(config.supportsJsonObject ? ["json_object"] : []),
    "prompt_json"
  ];
  const reasoningEffort = resolveReasoningEffort(protectedInput.reasoningEffort);
  let lastError: Error | null = null;

  for (const mode of modes) {
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      throwIfOperationCancelled(protectedInput.operationId);
      const controller = new AbortController();
      const operationSignal = getOperationSignal(protectedInput.operationId);
      const abortForOperation = () => controller.abort(operationSignal?.reason ?? new OperationCancelledError());
      if (operationSignal?.aborted) abortForOperation();
      else operationSignal?.addEventListener("abort", abortForOperation, { once: true });
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      const attemptStartedAt = performance.now();
      let httpResult: ModelHttpResult | undefined;
      try {
        const modeUserContent = mode === "json_schema"
          ? userContent
          : [
            { type: "text", text: `${protectedInput.prompt}\n\n请严格返回符合以下 JSON Schema 的对象，不要输出任何额外文字：\n${JSON.stringify(protectedInput.schema)}` },
            ...userContent.slice(1)
          ];
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
        if (mode === "json_schema") {
          body.response_format = {
            type: "json_schema",
            json_schema: { name: protectedInput.schemaName, strict: true, schema: protectedInput.schema }
          };
        } else if (mode === "json_object") {
          body.response_format = { type: "json_object" };
        }
        const responseFormat = body.response_format as Record<string, unknown> | undefined;
        httpResult = await request(config, body, controller.signal);
        if (httpResult.status < 200 || httpResult.status >= 300) {
          const safeMessage = redactSecrets(httpResult.raw.slice(0, 800));
          throw new Error(`模型服务返回 ${httpResult.status}: ${safeMessage}`);
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
          attempt + 1,
          config.maxRetries + 1,
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
        const modeUserContent = mode === "json_schema"
          ? userContent
          : [
            { type: "text", text: `${protectedInput.prompt}\n\n请严格返回符合以下 JSON Schema 的对象，不要输出任何额外文字：\n${JSON.stringify(protectedInput.schema)}` },
            ...userContent.slice(1)
          ];
        const responseFormat = mode === "json_schema"
          ? { type: "json_schema", json_schema: { name: protectedInput.schemaName, strict: true, schema: protectedInput.schema } }
          : mode === "json_object" ? { type: "json_object" } : undefined;
        recordModelCall(
          config,
          protectedInput,
          mode,
          attempt + 1,
          config.maxRetries + 1,
          modeUserContent,
          responseFormat,
          reasoningEffort,
          httpResult,
          httpResult?.durationMs ?? Math.round(performance.now() - attemptStartedAt),
          lastError
        );
        if (isOperationCancelled(lastError)) throw lastError;
        if (attempt < config.maxRetries) continue;
      } finally {
        clearTimeout(timeout);
        operationSignal?.removeEventListener("abort", abortForOperation);
      }
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

export function resolveReviewModelConfig(config: ModelConfigInput): ModelConfigInput {
  const reviewModel = config.reviewModel?.trim();
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
    maxRetries: 0,
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
