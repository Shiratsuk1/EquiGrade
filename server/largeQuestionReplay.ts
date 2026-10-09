import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PaddleOcrAudit } from "../shared/types.js";
import {
  DEFAULT_PADDLEOCR_MODEL,
  extractPaddleOcrLayoutMetadata,
  extractPaddleOcrMarkdown
} from "./paddleOcr.js";

const REPLAY_CACHE_FILE = "reconstruction-rubric-ab-result.json";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 不是对象`);
  }
  return value as JsonRecord;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 缺少有效字符串`);
  return value.trim();
}

function dataDirectory(): string {
  return process.env.APP_DATA_DIR?.trim()
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.resolve(".data");
}

function cachedJobId(rawJsonl: string): string {
  return `cached-ocr-${createHash("sha256").update(rawJsonl).digest("hex").slice(0, 16)}`;
}

function buildReplayAudit(input: {
  rawJsonl: string;
  markdownText?: string;
  model?: string;
  jobId?: string;
  durationMs?: number;
}): PaddleOcrAudit {
  const rawJsonl = input.rawJsonl;
  if (!rawJsonl.trim()) throw new Error("缓存 OCR rawJsonl 缺少有效内容");
  const markdownText = input.markdownText?.trim() || extractPaddleOcrMarkdown(rawJsonl);
  return {
    provider: "paddleocr",
    model: input.model?.trim() || DEFAULT_PADDLEOCR_MODEL,
    jobId: input.jobId?.trim() || cachedJobId(rawJsonl),
    source: "cached_replay",
    rawJsonl,
    markdownText,
    ...extractPaddleOcrLayoutMetadata(rawJsonl),
    durationMs: typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? input.durationMs
      : 0
  };
}

/**
 * Loads OCR data that is already attached to a history record. If an old record
 * has no saved OCR audit, fall back to the local reconstruction cache created
 * by the independent OCR test. This function never contacts PaddleOCR.
 */
export async function loadCachedPaddleOcrAudit(savedAudit?: PaddleOcrAudit): Promise<PaddleOcrAudit> {
  if (savedAudit?.rawJsonl?.trim()) {
    return buildReplayAudit(savedAudit);
  }

  const cachePath = path.join(dataDirectory(), REPLAY_CACHE_FILE);
  let cache: JsonRecord;
  try {
    cache = asRecord(JSON.parse(await readFile(cachePath, "utf8")) as unknown, cachePath);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`缓存 OCR 文件不是有效 JSON：${cachePath}`);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`历史记录没有保存 OCR 审计，且未找到缓存 OCR 文件：${cachePath}`);
    }
    throw new Error(`读取缓存 OCR 文件失败：${cachePath}`);
  }
  const ocr = asRecord(cache.ocr, "缓存 OCR");
  return buildReplayAudit({
    rawJsonl: asString(ocr.rawJsonl, "缓存 OCR rawJsonl"),
    markdownText: typeof ocr.markdownText === "string" ? ocr.markdownText : undefined,
    model: typeof ocr.model === "string" ? ocr.model : undefined,
    jobId: typeof ocr.jobId === "string" ? ocr.jobId : typeof cache.jobId === "string" ? cache.jobId : undefined,
    durationMs: typeof ocr.durationMs === "number" ? ocr.durationMs : undefined
  });
}
