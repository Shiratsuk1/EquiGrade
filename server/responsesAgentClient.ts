import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  decodeSafeLatexTokens,
  findDamagedLatexControlPath,
  repairLatexJsonEscapes,
  SAFE_LATEX_PROTOCOL_INSTRUCTION
} from "../shared/formulaProtocol.js";
import type { ModelConfigInput, TeacherReasoningEffort } from "../shared/types.js";
import { assertSafeModelBaseUrl } from "./outboundUrlPolicy.js";
import { getOutboundProxyDispatcher } from "./outboundTransport.js";
import { findInvalidFormulaPath } from "./formulaValidation.js";
import { getOperationSignal, isOperationCancelled, logEvent, OperationCancelledError, throwIfOperationCancelled } from "./systemLog.js";
import { withModelCallSlot } from "./modelClient.js";

type JsonSchema = Record<string, unknown>;

export interface ResponsesAgentImageInput {
  mimeType: "image/webp";
  base64: string;
  label?: string;
  imageId?: string;
}

export interface ResponsesAgentToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ResponsesAgentFunctionCall {
  id?: string;
  callId: string;
  name: string;
  arguments: string;
}

export interface ResponsesAgentCallInput<T = unknown> {
  config: ModelConfigInput;
  baseUrl: string;
  apiKey: string;
  model: string;
  instructions: string;
  input: unknown[];
  images?: ResponsesAgentImageInput[];
  tools?: ResponsesAgentToolDefinition[];
  schemaName: string;
  schema: JsonSchema;
  validate?: (value: unknown) => T;
  reasoningEffort?: TeacherReasoningEffort;
  operationId?: string;
  round: number;
  toolChoice?: unknown;
}

export interface ResponsesAgentCallResult<T = unknown> {
  data?: T;
  raw: string;
  response: Record<string, unknown>;
  outputItems: unknown[];
  functionCalls: ResponsesAgentFunctionCall[];
  messageText?: string;
  responseId?: string;
  status?: string;
  durationMs: number;
  usage?: Record<string, unknown>;
  reasoningItemCount: number;
}

function responseStatus(response: Record<string, unknown>): string {
  return typeof response.status === "string" ? response.status.trim().toLowerCase() : "";
}

function responseStatusDetail(response: Record<string, unknown>): string {
  const details: string[] = [];
  const detail = response.incomplete_details;
  if (detail && typeof detail === "object") {
    const reason = (detail as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.trim()) details.push(`原因：${reason.trim()}`);
  }
  const responseError = response.error;
  if (typeof responseError === "string" && responseError.trim()) {
    details.push(`错误：${redactSecrets(responseError.trim())}`);
  } else if (responseError && typeof responseError === "object") {
    const errorValue = responseError as { code?: unknown; message?: unknown };
    const code = typeof errorValue.code === "string" && errorValue.code.trim() ? `${errorValue.code.trim()}：` : "";
    const message = typeof errorValue.message === "string" ? errorValue.message.trim() : "";
    if (code || message) details.push(`错误：${redactSecrets(`${code}${message}`)}`);
  }
  return details.length ? `（${details.join("；")}）` : "";
}

function outputItemType(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const type = (item as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function responsesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("Responses Agent 缺少 API Base URL");
  if (/\/responses$/i.test(normalized)) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) {
    throw new Error("Responses Agent 必须配置 Responses API 地址，不能使用 /chat/completions");
  }
  return `${normalized}/responses`;
}

function redactSecrets(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,}\]"']+/gi, "$1[REDACTED]");
}

function imageMetadata(image: ResponsesAgentImageInput) {
  const bytes = Buffer.from(image.base64, "base64");
  return {
    ...(image.label ? { label: redactSecrets(image.label) } : {}),
    ...(image.imageId ? { imageId: image.imageId } : {}),
    mimeType: image.mimeType,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function reasoningValue(value: TeacherReasoningEffort | undefined): string | undefined {
  return value && value !== "disabled" ? value : undefined;
}

function extractOutputItems(response: Record<string, unknown>): unknown[] {
  return Array.isArray(response.output) ? response.output : [];
}

function extractFunctionCalls(outputItems: unknown[]): ResponsesAgentFunctionCall[] {
  return outputItems.flatMap((item): ResponsesAgentFunctionCall[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as { type?: unknown; id?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown };
    if (value.type !== "function_call" || typeof value.call_id !== "string" || typeof value.name !== "string" || typeof value.arguments !== "string") return [];
    return [{
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      callId: value.call_id,
      name: value.name,
      arguments: value.arguments
    }];
  });
}

/**
 * A Responses tool turn must be replayed losslessly.  In particular, every
 * function_call output item needs one valid call_id and call ids must be
 * unique.  Keeping this check at the transport boundary prevents the caller
 * from accidentally appending only a filtered subset of output items and
 * receiving a confusing provider-side "missing tool output" error.
 */
function validateFunctionCallItems(outputItems: unknown[], functionCalls: ResponsesAgentFunctionCall[]): void {
  const functionItems = outputItems.filter((item) => outputItemType(item) === "function_call");
  if (functionItems.length !== functionCalls.length) {
    throw new Error("Responses Agent 返回了格式不完整的 function_call，未进行工具结果重放");
  }
  const ids = new Set<string>();
  for (const call of functionCalls) {
    if (ids.has(call.callId)) throw new Error(`Responses Agent 返回了重复的 function_call call_id：${call.callId}`);
    ids.add(call.callId);
  }
}

function extractMessageText(response: Record<string, unknown>): string | undefined {
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
  const outputItems = extractOutputItems(response);
  const fragments = outputItems.flatMap((item): string[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as { type?: unknown; content?: unknown };
    if (value.type !== "message" || !Array.isArray(value.content)) return [];
    return value.content.flatMap((content): string[] => {
      if (!content || typeof content !== "object") return [];
      const part = content as { type?: unknown; text?: unknown };
      return part.type === "output_text" && typeof part.text === "string" ? [part.text] : [];
    });
  });
  return fragments.join("\n").trim() || undefined;
}

function parseJsonText(value: string, schemaName: string): unknown {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const repaired = repairLatexJsonEscapes(cleaned);
  try {
    const parsed = JSON.parse(repaired.json) as unknown;
    const damagedPath = findDamagedLatexControlPath(parsed);
    if (damagedPath) {
      throw new Error(`Responses Agent JSON 在 ${damagedPath} 中包含被控制字符损坏的 LaTeX 命令`);
    }
    const decoded = decodeSafeLatexTokens(parsed);
    const formulaIssue = findInvalidFormulaPath(decoded);
    if (formulaIssue) {
      throw new Error(`Responses Agent JSON 在 ${formulaIssue.path} 中包含无法由 KaTeX 渲染的公式：${formulaIssue.reason}`);
    }
    return decoded;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Responses Agent JSON")) throw error;
    throw new Error(`Responses Agent 未返回完整的 ${schemaName} JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function protectedInstructions(value: string): string {
  return `${value.trim()}\n\n${SAFE_LATEX_PROTOCOL_INSTRUCTION}`;
}

function summarizeValidationError(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues?: Array<{ path?: PropertyKey[]; message?: string }> }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues.slice(0, 5).map((issue) => `${issue.path?.length ? issue.path.map(String).join(".") : "根对象"}: ${issue.message ?? "字段不符合约定"}`).join("；");
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function modelError(status: number, raw: string): string {
  const body = redactSecrets(raw.slice(0, 1_000));
  if (body.trimStart().startsWith("<")) return `Responses Agent 服务返回 HTML（HTTP ${status}），请检查 Base URL 是否指向 /v1 或兼容服务的 /responses；未回退到 Chat Completions`;
  return `Responses Agent 服务返回 ${status}：${body}`;
}

type ResponsesPayload = {
  raw: string;
  response: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function streamOutputIndex(event: Record<string, unknown>): number | undefined {
  return typeof event.output_index === "number" && Number.isInteger(event.output_index) && event.output_index >= 0
    ? event.output_index
    : undefined;
}

/**
 * Read a Responses SSE stream and retain the same complete response shape used
 * by the non-streaming path.  The completed event is authoritative when a
 * compatible gateway provides it; the output-item map is a conservative
 * fallback for gateways that omit the embedded response object.
 */
async function readResponsesStream(httpResponse: Response): Promise<ResponsesPayload> {
  if (!httpResponse.body) throw new Error("Responses Agent 流式响应没有可读取的响应体");
  const reader = httpResponse.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const outputItems = new Map<number, Record<string, unknown>>();
  const functionArguments = new Map<string, string>();
  let terminalType: string | undefined;
  let terminalResponse: Record<string, unknown> | undefined;
  let nextOutputIndex = 0;

  const findOutputIndex = (event: Record<string, unknown>): number | undefined => {
    const direct = streamOutputIndex(event);
    if (direct !== undefined) return direct;
    const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
    if (!itemId) return undefined;
    for (const [index, item] of outputItems) {
      if (item.id === itemId) return index;
    }
    return undefined;
  };

  const mergeOutputItem = (event: Record<string, unknown>, item: Record<string, unknown>) => {
    const index = streamOutputIndex(event) ?? (typeof item.id === "string"
      ? [...outputItems.entries()].find(([, existing]) => existing.id === item.id)?.[0]
      : undefined) ?? nextOutputIndex++;
    const previous = outputItems.get(index) ?? {};
    const merged = { ...previous, ...item };
    if (typeof merged.id === "string") {
      const argumentsText = functionArguments.get(merged.id);
      if (argumentsText !== undefined) merged.arguments = argumentsText;
    }
    outputItems.set(index, merged);
    nextOutputIndex = Math.max(nextOutputIndex, index + 1);
  };

  const consumeEvent = (payload: string) => {
    if (!payload || payload === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!isRecord(parsed)) return;
      event = parsed;
    } catch {
      throw new Error("Responses Agent 流式响应包含无法解析的 SSE JSON");
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      if (isRecord(event.item)) mergeOutputItem(event, event.item);
    } else if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
      const index = findOutputIndex(event);
      const currentItem = index === undefined ? undefined : outputItems.get(index);
      const key = itemId ?? (typeof currentItem?.id === "string" ? currentItem.id : undefined);
      if (key) {
        if (type.endsWith(".done")) {
          functionArguments.set(key, typeof event.arguments === "string" ? event.arguments : "");
        } else if (typeof event.delta === "string") {
          functionArguments.set(key, `${functionArguments.get(key) ?? ""}${event.delta}`);
        }
        const targetIndex = index ?? [...outputItems.entries()].find(([, item]) => item.id === key)?.[0];
        if (targetIndex !== undefined) {
          const target = outputItems.get(targetIndex) ?? {};
          outputItems.set(targetIndex, { ...target, arguments: functionArguments.get(key) ?? "" });
        }
      }
    }
    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete" || type === "response.cancelled") {
      terminalType = type;
      terminalResponse = isRecord(event.response) ? event.response : undefined;
    }
  };

  const consumeFrames = (value: string) => {
    pending += value;
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      consumeEvent(data);
      if (terminalType) break;
    }
  };

  try {
    while (!terminalType) {
      const chunk = await reader.read();
      if (chunk.done) break;
      consumeFrames(decoder.decode(chunk.value, { stream: true }));
    }
    if (!terminalType) {
      consumeFrames(decoder.decode());
      if (pending.trim()) {
        const data = pending
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("\n");
        consumeEvent(data);
      }
    }
  } finally {
    if (terminalType) await reader.cancel().catch(() => undefined);
  }

  if (!terminalType) throw new Error("Responses Agent 流式响应未返回完成事件");
  const response = terminalResponse ?? {
    status: terminalType.replace(/^response\./, ""),
    output: [...outputItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item)
  };
  if (!Array.isArray(response.output) && outputItems.size > 0) {
    response.output = [...outputItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
  }
  return { raw: JSON.stringify(response), response };
}

async function readResponsesPayload(httpResponse: Response): Promise<ResponsesPayload> {
  const contentType = httpResponse.headers.get("content-type") ?? "";
  if (/text\/event-stream/i.test(contentType)) return readResponsesStream(httpResponse);
  const raw = await httpResponse.text();
  try {
    const response = JSON.parse(raw) as unknown;
    if (!isRecord(response)) throw new Error("响应 JSON 不是对象");
    return { raw, response };
  } catch (error) {
    throw new Error(`Responses Agent 返回不是 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function logResponsesCall(input: ResponsesAgentCallInput, endpoint: string, result: {
  status: number;
  raw: string;
  durationMs: number;
  outputItems: unknown[];
  functionCalls: ResponsesAgentFunctionCall[];
}, error?: unknown) {
  if (!input.operationId) return;
  const inputImages = (input.images ?? []).map(imageMetadata);
  logEvent(input.operationId, "model", "model_call", error ? `Responses Agent 调用失败：${input.schemaName}` : `Responses Agent 调用完成：${input.schemaName}`, {
    kind: "model_call",
    model: input.model,
    configuration: { name: "Responses Agent", baseUrl: endpoint.replace(/\/responses$/, "") },
    schemaName: input.schemaName,
    outputMode: "responses_text_json_schema",
    attempt: input.round,
    maxAttempts: input.round,
    durationMs: result.durationMs,
    request: {
      systemPrompt: redactSecrets(protectedInstructions(input.instructions)),
      userPrompt: "Responses Agent input items are recorded in the local agent audit",
      images: inputImages,
      responseFormat: { type: "json_schema", name: input.schemaName, strict: true, schema: input.schema },
      ...(reasoningValue(input.reasoningEffort) ? { reasoningEffort: reasoningValue(input.reasoningEffort) } : {})
    },
    response: {
      status: result.status,
      raw: redactSecrets(result.raw)
    },
    ...(result.functionCalls.length ? { functionCalls: result.functionCalls.map((call) => ({ callId: call.callId, name: call.name })) } : {}),
    ...(error ? { error: redactSecrets(error instanceof Error ? error.message : String(error)) } : {})
  }, error ? "error" : "success", error ? "failed" : "completed");
}

async function requestResponses<T>(input: ResponsesAgentCallInput<T>): Promise<ResponsesAgentCallResult<T>> {
  throwIfOperationCancelled(input.operationId);
  const endpoint = responsesEndpoint(input.baseUrl);
  await assertSafeModelBaseUrl(endpoint);
  const dispatcher = getOutboundProxyDispatcher();
  const startedAt = performance.now();
  let callLogged = false;
  let httpStatus = 0;
  const recordCall = (result: {
    status: number;
    raw: string;
    durationMs: number;
    outputItems: unknown[];
    functionCalls: ResponsesAgentFunctionCall[];
  }, error?: unknown) => {
    if (callLogged) return;
    callLogged = true;
    logResponsesCall(input, endpoint, result, error);
  };
  const controller = new AbortController();
  const operationSignal = getOperationSignal(input.operationId);
  const abortForOperation = () => controller.abort(operationSignal?.reason ?? new OperationCancelledError());
  if (operationSignal?.aborted) abortForOperation();
  else operationSignal?.addEventListener("abort", abortForOperation, { once: true });
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Math.floor(input.config.responsesAgent?.timeoutMs ?? input.config.timeoutMs)));
  try {
    const inputItems = input.input.length > 0
      ? input.input
      : [{
          role: "user",
          content: [
            { type: "input_text", text: "请按 instructions 完成任务。" },
            ...(input.images ?? []).flatMap((image) => [
              ...(image.label ? [{ type: "input_text", text: image.label }] : []),
              { type: "input_image", image_url: `data:${image.mimeType};base64,${image.base64}`, detail: "high" }
            ])
          ]
        }];
    const body: Record<string, unknown> = {
      model: input.model,
      instructions: protectedInstructions(input.instructions),
      input: inputItems,
      store: false,
      stream: true,
      parallel_tool_calls: true,
      max_output_tokens: input.config.responsesAgent?.maxOutputTokens ?? input.config.maxOutputTokens,
      text: {
        format: {
          type: "json_schema",
          name: input.schemaName,
          strict: true,
          schema: input.schema
        }
      },
      include: ["reasoning.encrypted_content"]
    };
    const reasoning = reasoningValue(input.reasoningEffort);
    if (reasoning) body.reasoning = { effort: reasoning };
    if (input.tools?.length) {
      body.tools = input.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: true
      }));
      body.tool_choice = input.toolChoice ?? "auto";
    } else if (input.toolChoice !== undefined) {
      body.tool_choice = input.toolChoice;
    }
    const requestInit: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${input.apiKey}`,
        "User-Agent": "Hengzhun-Physics-Grading/0.1"
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {})
    };
    let httpResponse: Response;
    try {
      httpResponse = await fetch(endpoint, requestInit);
      httpStatus = httpResponse.status;
    } catch (error) {
      if (operationSignal?.aborted) throw new OperationCancelledError();
      if (controller.signal.aborted) throw new Error("Responses Agent 请求超时");
      throw new Error(`Responses Agent URL ${endpoint} 请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      const raw = await httpResponse.text();
      const durationMs = Math.round(performance.now() - startedAt);
      const error = new Error(modelError(httpResponse.status, raw));
      recordCall({ status: httpResponse.status, raw, durationMs, outputItems: [], functionCalls: [] }, error);
      throw error;
    }
    const { raw, response } = await readResponsesPayload(httpResponse);
    const durationMs = Math.round(performance.now() - startedAt);
    const outputItems = extractOutputItems(response);
    const functionCalls = extractFunctionCalls(outputItems);
    const messageText = extractMessageText(response);
    const result: ResponsesAgentCallResult<T> = {
      raw,
      response,
      outputItems,
      functionCalls,
      ...(messageText ? { messageText } : {}),
      ...(typeof response.id === "string" ? { responseId: response.id } : {}),
      ...(typeof response.status === "string" ? { status: response.status } : {}),
      durationMs,
      ...(response.usage && typeof response.usage === "object" ? { usage: response.usage as Record<string, unknown> } : {}),
      reasoningItemCount: outputItems.filter((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "reasoning").length
    };
    const status = responseStatus(response);
    if (status !== "completed") {
      const statusLabel = status || "缺少 status";
      const unusable = new Error(`Responses Agent 返回不可用状态：${statusLabel}${responseStatusDetail(response)}`);
      recordCall({ status: httpResponse.status, raw, durationMs, outputItems, functionCalls }, unusable);
      throw unusable;
    }
    try {
      validateFunctionCallItems(outputItems, functionCalls);
      if (functionCalls.length === 0) {
        if (!messageText) throw new Error("Responses Agent 未返回最终结构化消息");
        const parsed = parseJsonText(messageText, input.schemaName);
        if (input.validate) {
          try {
            result.data = input.validate(parsed);
          } catch (error) {
            throw new Error(`Responses Agent 返回的 JSON 不符合 ${input.schemaName} 结构约定：${summarizeValidationError(error)}`);
          }
        } else {
          result.data = parsed as T;
        }
      }
    } catch (error) {
      recordCall({ status: httpResponse.status, raw, durationMs, outputItems, functionCalls }, error);
      throw error;
    }
    recordCall({ status: httpResponse.status, raw, durationMs, outputItems, functionCalls });
    return result;
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    recordCall({
      status: httpStatus,
      raw: "",
      durationMs: Math.round(performance.now() - startedAt),
      outputItems: [],
      functionCalls: []
    }, error);
    throw error;
  } finally {
    clearTimeout(timeout);
    operationSignal?.removeEventListener("abort", abortForOperation);
  }
}

export async function callResponsesAgent<T>(input: ResponsesAgentCallInput<T>): Promise<ResponsesAgentCallResult<T>> {
  return withModelCallSlot(input.config, input.operationId, () => requestResponses(input));
}

const connectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string" } }
} as const;

/**
 * Exercise the real Responses wire contract without sending a student page:
 * text structured output, vision structured output, then a forced custom
 * function call followed by a replayed function_call_output final response.
 */
export async function testResponsesAgentConnection(
  config: ModelConfigInput,
  operationId?: string
): Promise<{ ok: true; durationMs: number; model: string; message: string }> {
  const agent = config.responsesAgent;
  if (!agent?.baseUrl?.trim() || !agent.model?.trim() || !agent.apiKey?.trim()) {
    throw new Error("Responses Agent 连接测试需要完整的 Base URL、模型和 API Key");
  }
  const startedAt = performance.now();
  const testImage = await sharp({
    create: { width: 128, height: 128, channels: 3, background: { r: 245, g: 245, b: 245 } }
  }).webp({ quality: 90 }).toBuffer();
  const baseRequest = {
    config,
    baseUrl: agent.baseUrl,
    apiKey: agent.apiKey,
    model: agent.model,
    instructions: "只输出当前请求 schema 定义的 JSON，不要输出 Markdown。",
    schemaName: "responses_agent_connection_test",
    schema: connectionSchema,
    validate: (value: unknown) => {
      const status = value && typeof value === "object" && typeof (value as { status?: unknown }).status === "string"
        ? (value as { status: string }).status
        : "";
      if (!status) throw new Error("status 必须是字符串");
      return { status };
    },
    reasoningEffort: agent.reasoningEffort,
    operationId
  } satisfies Omit<ResponsesAgentCallInput<{ status: string }>, "input" | "round">;
  await callResponsesAgent({
    ...baseRequest,
    input: [{ role: "user", content: [{ type: "input_text", text: "返回 {status: \"ok\"}。" }] }],
    round: 1
  });
  const visionImage: ResponsesAgentImageInput = { mimeType: "image/webp", base64: testImage.toString("base64"), label: "[Responses Agent 视觉连接测试图：128x128 WebP q90]", imageId: "connection-test" };
  await callResponsesAgent({
    ...baseRequest,
    input: [{ role: "user", content: [{ type: "input_text", text: "查看这张 WebP 测试图，返回 {status: \"ok\"}。" }, { type: "input_image", image_url: `data:image/webp;base64,${visionImage.base64}`, detail: "high" }] }],
    images: [visionImage],
    round: 2
  });
  const tool = {
    name: "connection_probe",
    description: "返回连接测试的固定字符串。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } }
    }
  } satisfies ResponsesAgentToolDefinition;
  const toolInput = [{ role: "user", content: [{ type: "input_text", text: "请调用 connection_probe，参数 value=ok；收到工具结果后输出 {status: \"ok\"}。" }, { type: "input_image", image_url: `data:image/webp;base64,${visionImage.base64}`, detail: "high" }] }];
  const toolCall = await callResponsesAgent({
    ...baseRequest,
    input: toolInput,
    images: [visionImage],
    tools: [tool],
    toolChoice: { type: "function", name: "connection_probe" },
    round: 3
  });
  const functionCall = toolCall.functionCalls[0];
  if (!functionCall) throw new Error("Responses Agent 未返回严格 function_call");
  await callResponsesAgent({
    ...baseRequest,
    input: [...toolInput, ...toolCall.outputItems, { type: "function_call_output", call_id: functionCall.callId, output: [{ type: "input_text", text: JSON.stringify({ ok: true, value: "ok" }) }] }],
    images: [visionImage],
    tools: [tool],
    round: 4
  });
  return {
    ok: true,
    durationMs: Math.round(performance.now() - startedAt),
    model: agent.model,
    message: "Responses API 文本、视觉、strict function calling 与最终 strict JSON Schema 均通过"
  };
}
