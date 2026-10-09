import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertSafePublicHttpsUrl } from "./outboundUrlPolicy.js";
import { getOutboundProxyDispatcher } from "./outboundTransport.js";
import { OperationCancelledError } from "./systemLog.js";
import type { PaddleOcrAudit, PaddleOcrConfigInput, PaddleOcrLayoutBlock } from "../shared/types.js";

export const DEFAULT_PADDLEOCR_JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
export const DEFAULT_PADDLEOCR_MODEL = "PaddleOCR-VL-1.6";
export const PADDLEOCR_TOKEN_ENV = "PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN";
export const DEFAULT_PADDLEOCR_TOKEN_FILE = ".data/paddleocr.token";
export const DEFAULT_PADDLEOCR_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_PADDLEOCR_TIMEOUT_MS = 600_000;

export type PaddleOcrErrorCode =
  | "missing_token"
  | "invalid_url"
  | "invalid_configuration"
  | "network"
  | "http_error"
  | "invalid_json"
  | "missing_job_id"
  | "missing_result_url"
  | "failed"
  | "unknown_status"
  | "invalid_jsonl"
  | "empty_result"
  | "timeout";

export class PaddleOcrError extends Error {
  readonly code: PaddleOcrErrorCode;

  constructor(code: PaddleOcrErrorCode, message: string) {
    super(message);
    this.name = "PaddleOcrError";
    this.code = code;
  }
}

export interface RunPaddleOcrInput {
  imageBuffer: Buffer;
  mimeType: string;
  fileName?: string;
  settings?: PaddleOcrConfigInput;
  signal?: AbortSignal;
}

interface RequestState {
  controller: AbortController;
  callerSignal?: AbortSignal;
  timedOut: boolean;
}

function redactPaddleText(value: string, token?: string): string {
  return value
    .replace(token ? new RegExp(escapeRegExp(token), "g") : /$^/g, "[REDACTED_SECRET]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED_SECRET]")
    .replace(/(access[_-]?token\s*[:=]\s*)[^\s,}\]"']+/gi, "$1[REDACTED_SECRET]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseEnvNumber(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new PaddleOcrError("invalid_configuration", `${name} 配置无效：必须是大于等于 ${minimum} 的数字`);
  }
  return Math.floor(parsed);
}

function asRecord(value: unknown, operation: string, token?: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaddleOcrError("invalid_json", `PaddleOCR${operation}失败：响应顶层不是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function parseJsonResponse(raw: string, operation: string, token?: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(raw) as unknown, operation, token);
  } catch (error) {
    if (error instanceof PaddleOcrError) throw error;
    throw new PaddleOcrError(
      "invalid_json",
      `PaddleOCR${operation}失败：服务端没有返回 JSON：${redactPaddleText(raw.slice(0, 500), token)}`
    );
  }
}

function responseError(operation: string, status: number, raw: string, token?: string): PaddleOcrError {
  return new PaddleOcrError(
    "http_error",
    `PaddleOCR${operation}失败：HTTP ${status}，响应：${redactPaddleText(raw.slice(0, 800).replace(/\s+/g, " "), token)}`
  );
}

function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function requestText(
  url: string,
  initOrFactory: RequestInit | (() => RequestInit),
  operation: string,
  state: RequestState,
  token?: string,
  maxRetries = 2
): Promise<string> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const init = typeof initOrFactory === "function" ? initOrFactory() : initOrFactory;
      const dispatcher = getOutboundProxyDispatcher();
      const response = await fetch(url, {
        ...init,
        redirect: "error",
        signal: state.controller.signal,
        ...(dispatcher ? { dispatcher } : {})
      } as RequestInit & { dispatcher?: unknown });
      const raw = await response.text();
      if (response.status < 200 || response.status >= 300) {
        if (attempt <= maxRetries && isTransientHttpStatus(response.status)) {
          const delayMs = Math.min(2000, 300 * Math.pow(2, attempt - 1));
          await waitForPoll(delayMs, state);
          continue;
        }
        throw responseError(operation, response.status, raw, token);
      }
      return raw;
    } catch (error) {
      if (error instanceof OperationCancelledError) throw error;
      if (state.callerSignal?.aborted) throw new OperationCancelledError();
      if (state.timedOut) throw new PaddleOcrError("timeout", `PaddleOCR${operation}超过设定超时时间，任务未完成`);
      if (error instanceof PaddleOcrError && error.code !== "network") throw error;
      if (attempt <= maxRetries) {
        const delayMs = Math.min(2000, 300 * Math.pow(2, attempt - 1));
        try {
          await waitForPoll(delayMs, state);
          continue;
        } catch (pollError) {
          if (pollError instanceof OperationCancelledError) throw pollError;
          throw new PaddleOcrError("timeout", `PaddleOCR${operation}超过设定超时时间，任务未完成`);
        }
      }
      if (error instanceof PaddleOcrError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new PaddleOcrError("network", `PaddleOCR${operation}请求失败：${redactPaddleText(message, token)}`);
    }
  }
}

function waitForPoll(ms: number, state: RequestState): Promise<void> {
  if (state.callerSignal?.aborted) return Promise.reject(new OperationCancelledError());
  if (state.timedOut) return Promise.reject(new PaddleOcrError("timeout", "PaddleOCR超过设定超时时间，任务未完成"));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      state.controller.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.controller.signal.removeEventListener("abort", onAbort);
      if (state.callerSignal?.aborted) reject(new OperationCancelledError());
      else reject(new PaddleOcrError("timeout", "PaddleOCR超过设定超时时间，任务未完成"));
    };
    state.controller.signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function assertPaddleUrl(value: string, label: string): Promise<URL> {
  try {
    return await assertSafePublicHttpsUrl(value);
  } catch (error) {
    throw new PaddleOcrError(
      "invalid_url",
      `PaddleOCR${label}无效：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function readDataRecord(body: Record<string, unknown>, operation: string, token?: string): Record<string, unknown> {
  return asRecord(body.data, operation, token);
}

function paddleOcrTokenFilePath(): string {
  const dataDirectory = process.env.APP_DATA_DIR?.trim()
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.resolve(path.dirname(DEFAULT_PADDLEOCR_TOKEN_FILE));
  return path.join(dataDirectory, path.basename(DEFAULT_PADDLEOCR_TOKEN_FILE));
}

async function readPaddleOcrToken(): Promise<string> {
  const environmentToken = process.env[PADDLEOCR_TOKEN_ENV]?.trim();
  if (environmentToken) return environmentToken;
  try {
    return (await readFile(paddleOcrTokenFilePath(), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new PaddleOcrError("invalid_configuration", `读取 PaddleOCR 本机 Token 文件失败：${paddleOcrTokenFilePath()}`);
  }
}

/** 从 PaddleOCR 返回的多行 JSONL 中合并所有页面的 Markdown。 */
export function extractPaddleOcrMarkdown(rawJsonl: string): string {
  const lines = rawJsonl.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new PaddleOcrError("empty_result", "PaddleOCR 下载的 JSONL 结果为空");

  const markdownParts: string[] = [];
  lines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new PaddleOcrError(
        "invalid_jsonl",
        `PaddleOCR JSONL 第 ${index + 1} 行不是有效 JSON：${error instanceof Error ? error.message : String(error)}`
      );
    }
    const record = asRecord(parsed, ` JSONL 第 ${index + 1} 行`);
    const result = record.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const layoutParsingResults = (result as { layoutParsingResults?: unknown }).layoutParsingResults;
    if (!Array.isArray(layoutParsingResults)) return;
    for (const layoutResult of layoutParsingResults) {
      if (!layoutResult || typeof layoutResult !== "object" || Array.isArray(layoutResult)) continue;
      const markdown = (layoutResult as { markdown?: unknown }).markdown;
      if (!markdown || typeof markdown !== "object" || Array.isArray(markdown)) continue;
      const text = (markdown as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) markdownParts.push(text.trim());
    }
  });

  if (!markdownParts.length) {
    throw new PaddleOcrError("empty_result", "PaddleOCR JSONL 中没有可用的 layoutParsingResults.markdown.text");
  }
  return markdownParts.join("\n\n");
}

function recordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function finitePositiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function parsePaddleOcrJsonlRecords(rawJsonl: string): Record<string, unknown>[] {
  const lines = rawJsonl.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new PaddleOcrError("empty_result", "PaddleOCR 下载的 JSONL 结果为空");
  return lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      return asRecord(parsed, ` JSONL 第 ${index + 1} 行`);
    } catch (error) {
      if (error instanceof PaddleOcrError) throw error;
      throw new PaddleOcrError(
        "invalid_jsonl",
        `PaddleOCR JSONL 第 ${index + 1} 行不是有效 JSON：${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}

function readPaddleOcrDimensions(value: unknown): { width: number; height: number } | undefined {
  const width = finitePositiveNumber(recordValue(value, "width"));
  const height = finitePositiveNumber(recordValue(value, "height"));
  return width && height ? { width, height } : undefined;
}

function readPaddleOcrPolygonPoints(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((point): Array<[number, number]> => {
    if (Array.isArray(point) && point.length >= 2) {
      const x = finiteNumber(point[0]);
      const y = finiteNumber(point[1]);
      return x === undefined || y === undefined ? [] : [[x, y]];
    }
    const x = finiteNumber(recordValue(point, "x"));
    const y = finiteNumber(recordValue(point, "y"));
    return x === undefined || y === undefined ? [] : [[x, y]];
  });
}

function readPaddleOcrBoxes(value: unknown, pageIndex: number): Array<Omit<PaddleOcrLayoutBlock, "blockId"> & { sourceIndex: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, sourceIndex): Array<Omit<PaddleOcrLayoutBlock, "blockId"> & { sourceIndex: number }> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const coordinateValue = recordValue(candidate, "coordinate");
    if (!Array.isArray(coordinateValue) || coordinateValue.length < 4) return [];
    const coordinate = coordinateValue.slice(0, 4).map(finiteNumber);
    if (coordinate.some((item) => item === undefined)) return [];
    const [x1, y1, x2, y2] = coordinate as [number, number, number, number];
    if (x2 <= x1 || y2 <= y1) return [];
    const score = finiteNumber(recordValue(candidate, "score")) ?? 0;
    const order = finiteNumber(recordValue(candidate, "order"));
    const labelValue = recordValue(candidate, "label");
    return [{
      pageIndex,
      label: typeof labelValue === "string" && labelValue.trim() ? labelValue.trim() : "unknown",
      score,
      coordinate: [x1, y1, x2, y2],
      polygonPoints: readPaddleOcrPolygonPoints(recordValue(candidate, "polygon_points")),
      order: order === undefined ? null : order,
      sourceIndex
    }];
  });
}

/**
 * 从 PaddleOCR 的原始 JSONL 中提取原图尺寸和细粒度 layout_det_res.boxes。
 * 这里只保存可审计的区域元数据，不展开或打印 PaddleOCR 返回的签名资源 URL。
 */
export function extractPaddleOcrLayoutMetadata(rawJsonl: string): {
  imageWidth?: number;
  imageHeight?: number;
  layoutBlocks: PaddleOcrLayoutBlock[];
} {
  const records = parsePaddleOcrJsonlRecords(rawJsonl);
  const blocks: Array<Omit<PaddleOcrLayoutBlock, "blockId"> & { sourceIndex: number }> = [];
  let imageDimensions: { width: number; height: number } | undefined;
  let pageIndex = 0;

  for (const record of records) {
    const result = recordValue(record, "result");
    const resultDimensions = readPaddleOcrDimensions(recordValue(result, "dataInfo"));
    if (!imageDimensions && resultDimensions) imageDimensions = resultDimensions;
    const layoutParsingResults = recordValue(result, "layoutParsingResults");
    if (!Array.isArray(layoutParsingResults)) continue;
    for (const layoutResult of layoutParsingResults) {
      const layoutDimensions = readPaddleOcrDimensions(recordValue(layoutResult, "dataInfo"));
      if (!imageDimensions && layoutDimensions) imageDimensions = layoutDimensions;
      const prunedResult = recordValue(layoutResult, "prunedResult");
      const boxes = recordValue(recordValue(prunedResult, "layout_det_res"), "boxes")
        ?? recordValue(recordValue(layoutResult, "layout_det_res"), "boxes")
        ?? recordValue(recordValue(result, "layout_det_res"), "boxes");
      blocks.push(...readPaddleOcrBoxes(boxes, pageIndex));
      pageIndex += 1;
    }
  }

  blocks.sort((left, right) => left.pageIndex - right.pageIndex
    || (left.order === null ? Number.POSITIVE_INFINITY : left.order) - (right.order === null ? Number.POSITIVE_INFINITY : right.order)
    || left.sourceIndex - right.sourceIndex);
  const layoutBlocks = blocks.map(({ sourceIndex: _sourceIndex, ...block }, index) => ({
    blockId: `block-${String(index).padStart(2, "0")}`,
    ...block
  }));
  return {
    ...(imageDimensions ? { imageWidth: imageDimensions.width, imageHeight: imageDimensions.height } : {}),
    layoutBlocks
  };
}

export async function runPaddleOcr(input: RunPaddleOcrInput): Promise<PaddleOcrAudit> {
  if (input.signal?.aborted) throw new OperationCancelledError();
  if (!input.imageBuffer.length) throw new PaddleOcrError("invalid_configuration", "PaddleOCR 输入答卷图片为空");

  const token = await readPaddleOcrToken();
  if (!token) {
    throw new PaddleOcrError("missing_token", `缺少 PaddleOCR 访问令牌，请设置环境变量 ${PADDLEOCR_TOKEN_ENV} 或创建未跟踪文件 ${DEFAULT_PADDLEOCR_TOKEN_FILE}`);
  }

  const settings = input.settings ?? {};
  const jobUrl = await assertPaddleUrl(
    settings.jobUrl?.trim() || process.env.PADDLEOCR_JOB_URL?.trim() || DEFAULT_PADDLEOCR_JOB_URL,
    "任务地址"
  );
  const model = settings.model?.trim() || process.env.PADDLEOCR_MODEL?.trim() || DEFAULT_PADDLEOCR_MODEL;
  const pollIntervalMs = settings.pollIntervalMs === undefined
    ? parseEnvNumber("PADDLEOCR_POLL_INTERVAL_MS", DEFAULT_PADDLEOCR_POLL_INTERVAL_MS, 0)
    : Math.max(0, Math.floor(settings.pollIntervalMs));
  const timeoutMs = settings.timeoutMs === undefined
    ? parseEnvNumber("PADDLEOCR_TIMEOUT_MS", DEFAULT_PADDLEOCR_TIMEOUT_MS, 1)
    : Math.max(1_000, Math.floor(settings.timeoutMs));
  const optionalPayload = {
    useDocOrientationClassify: settings.useDocOrientationClassify === true,
    useDocUnwarping: settings.useDocUnwarping === true,
    useChartRecognition: settings.useChartRecognition === true
  };
  const startedAt = performance.now();
  const controller = new AbortController();
  const state: RequestState = { controller, callerSignal: input.signal, timedOut: false };
  const abortFromCaller = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const buildSubmitInit = (): RequestInit => {
      const form = new FormData();
      form.append("model", model);
      form.append("optionalPayload", JSON.stringify(optionalPayload));
      const fileName = input.fileName?.trim() || "student-answer";
      const blob = new Blob([new Uint8Array(input.imageBuffer)], { type: input.mimeType || "application/octet-stream" });
      form.append("file", blob, fileName);
      return {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        },
        body: form
      };
    };

    const submitRaw = await requestText(jobUrl.toString(), buildSubmitInit, "提交 OCR 任务", state, token);
    const submitBody = parseJsonResponse(submitRaw, "提交 OCR 任务", token);
    const submitData = readDataRecord(submitBody, "提交 OCR 任务", token);
    const jobId = typeof submitData.jobId === "string" ? submitData.jobId.trim() : "";
    if (!jobId) throw new PaddleOcrError("missing_job_id", "PaddleOCR 提交成功但响应中缺少 data.jobId");

    let resultUrl: URL | undefined;
    while (!resultUrl) {
      const pollUrl = `${jobUrl.toString().replace(/\/+$/, "")}/${encodeURIComponent(jobId)}`;
      const pollRaw = await requestText(pollUrl, () => ({
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        }
      }), "查询 OCR 任务", state, token);
      const pollBody = parseJsonResponse(pollRaw, "查询 OCR 任务", token);
      const pollData = readDataRecord(pollBody, "查询 OCR 任务", token);
      const jobState = typeof pollData.state === "string" ? pollData.state : "";
      if (jobState === "done") {
        const resultUrlValue = pollData.resultUrl && typeof pollData.resultUrl === "object" && !Array.isArray(pollData.resultUrl)
          ? (pollData.resultUrl as { jsonUrl?: unknown }).jsonUrl
          : undefined;
        if (typeof resultUrlValue !== "string" || !resultUrlValue.trim()) {
          throw new PaddleOcrError("missing_result_url", "PaddleOCR 任务已完成但响应中缺少 data.resultUrl.jsonUrl");
        }
        resultUrl = await assertPaddleUrl(resultUrlValue.trim(), "结果地址");
        break;
      }
      if (jobState === "failed") {
        const reason = typeof pollData.errorMsg === "string" && pollData.errorMsg.trim()
          ? pollData.errorMsg.trim()
          : "服务端未提供错误信息";
        throw new PaddleOcrError("failed", `PaddleOCR 任务失败：${redactPaddleText(reason, token)}`);
      }
      if (jobState !== "pending" && jobState !== "running") {
        throw new PaddleOcrError("unknown_status", `PaddleOCR 返回未知任务状态：${jobState || "（缺失）"}`);
      }
      await waitForPoll(pollIntervalMs, state);
    }

    const resultRaw = await requestText(resultUrl.toString(), () => ({
      method: "GET",
      headers: { Accept: "application/jsonl, text/plain" }
    }), "下载 JSONL 结果", state);
    const markdownText = extractPaddleOcrMarkdown(resultRaw);
    const layoutMetadata = extractPaddleOcrLayoutMetadata(resultRaw);
    return {
      provider: "paddleocr",
      model,
      jobId,
      rawJsonl: resultRaw,
      markdownText,
      ...layoutMetadata,
      durationMs: Math.round(performance.now() - startedAt)
    };
  } catch (error) {
    if (error instanceof OperationCancelledError) throw error;
    if (input.signal?.aborted) throw new OperationCancelledError();
    if (state.timedOut && !(error instanceof PaddleOcrError && error.code === "timeout")) {
      throw new PaddleOcrError("timeout", "PaddleOCR超过设定超时时间，任务未完成");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}
