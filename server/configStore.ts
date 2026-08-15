import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_GRADING_MODE,
  DEFAULT_MODEL_TIMEOUT_MS,
  DEFAULT_REVIEW_REASONING_EFFORT,
  DEFAULT_TEACHER_REASONING_EFFORT,
  DEFAULT_UNREADABLE_REVIEW_THRESHOLD,
  GRADING_MODES,
  TEACHER_REASONING_EFFORTS
} from "../shared/types.js";
import type { GradingMode, ModelConfigInput, PublicModelConfig, TeacherReasoningEffort } from "../shared/types.js";

export interface ActiveModelConfig extends ModelConfigInput {
  id: string;
  updatedAt: string;
}

type StoredConfig = ActiveModelConfig;

interface EncryptedPayload {
  iv: string;
  tag: string;
  data: string;
}

const dataDirectory = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.resolve(".data");
const keyPath = path.join(dataDirectory, "master.key");
const configPath = path.join(dataDirectory, "model-config.enc.json");

async function getEncryptionKey(): Promise<Buffer> {
  await mkdir(dataDirectory, { recursive: true });
  try {
    return Buffer.from(await readFile(keyPath, "utf8"), "base64");
  } catch {
    const key = randomBytes(32);
    await writeFile(keyPath, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
    return key;
  }
}

async function encrypt(value: StoredConfig): Promise<EncryptedPayload> {
  const key = await getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64")
  };
}

async function decrypt(payload: EncryptedPayload): Promise<StoredConfig> {
  const key = await getEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString("utf8")) as StoredConfig;
}

function withConfigDefaults(config: StoredConfig): StoredConfig {
  const configuredTimeoutMs = Number(config.timeoutMs);
  const timeoutMs = configuredTimeoutMs === 120_000
    ? DEFAULT_MODEL_TIMEOUT_MS
    : configuredTimeoutMs;
  const unreadableReviewThreshold = Number(config.unreadableReviewThreshold);
  const configuredReasoningEffort = config.teacherReasoningEffort;
  const teacherReasoningEffort: TeacherReasoningEffort = configuredReasoningEffort
    && TEACHER_REASONING_EFFORTS.includes(configuredReasoningEffort)
    ? configuredReasoningEffort
    : DEFAULT_TEACHER_REASONING_EFFORT;
  const configuredReviewReasoningEffort = config.reviewReasoningEffort;
  const reviewReasoningEffort: TeacherReasoningEffort = configuredReviewReasoningEffort
    && TEACHER_REASONING_EFFORTS.includes(configuredReviewReasoningEffort)
    ? configuredReviewReasoningEffort
    : DEFAULT_REVIEW_REASONING_EFFORT;
  const configuredGradingMode = config.gradingMode;
  const gradingMode: GradingMode = configuredGradingMode
    && GRADING_MODES.includes(configuredGradingMode)
    ? configuredGradingMode
    : DEFAULT_GRADING_MODE;
  return {
    ...config,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1_000
      ? timeoutMs
      : DEFAULT_MODEL_TIMEOUT_MS,
    unreadableReviewThreshold: Number.isFinite(unreadableReviewThreshold) && unreadableReviewThreshold >= 0.5
      ? unreadableReviewThreshold
      : DEFAULT_UNREADABLE_REVIEW_THRESHOLD,
    teacherReasoningEffort,
    reviewBaseUrl: config.reviewBaseUrl?.trim().replace(/\/+$/, "") ?? "",
    reviewModel: config.reviewModel?.trim() ?? "",
    reviewReasoningEffort,
    gradingMode
  };
}

export async function readModelConfig(): Promise<ActiveModelConfig | null> {
  try {
    const payload = JSON.parse(await readFile(configPath, "utf8")) as EncryptedPayload;
    return withConfigDefaults(await decrypt(payload));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function requireModelConfig(): Promise<ActiveModelConfig> {
  const config = await readModelConfig();
  if (!config?.enabled) throw new Error("请先在模型服务中保存并启用一个配置");
  if (!config.apiKey) throw new Error("当前模型配置缺少 API Key");
  return config;
}

export async function saveModelConfig(input: ModelConfigInput): Promise<PublicModelConfig> {
  const current = await readModelConfig();
  const apiKey = input.apiKey?.trim() || current?.apiKey || "";
  const reviewApiKey = input.reviewApiKey?.trim() || current?.reviewApiKey || "";
  const stored: StoredConfig = {
    ...input,
    name: input.name.trim(),
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    apiKey,
    visionModel: input.visionModel.trim(),
    textModel: input.textModel.trim(),
    reviewBaseUrl: input.reviewBaseUrl?.trim().replace(/\/+$/, "") ?? "",
    reviewApiKey,
    reviewModel: input.reviewModel?.trim() ?? "",
    id: current?.id ?? crypto.randomUUID(),
    updatedAt: new Date().toISOString()
  };
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify(await encrypt(stored)), "utf8");
  return toPublicConfig(stored);
}

export function toPublicConfig(config: StoredConfig): PublicModelConfig {
  const apiKey = config.apiKey ?? "";
  const reviewApiKey = config.reviewApiKey ?? "";
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    visionModel: config.visionModel,
    textModel: config.textModel,
    reviewBaseUrl: config.reviewBaseUrl ?? "",
    reviewModel: config.reviewModel ?? "",
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxConcurrency: config.maxConcurrency,
    maxOutputTokens: config.maxOutputTokens,
    unreadableReviewThreshold: config.unreadableReviewThreshold ?? DEFAULT_UNREADABLE_REVIEW_THRESHOLD,
    gradingMode: config.gradingMode ?? DEFAULT_GRADING_MODE,
    teacherReasoningEffort: config.teacherReasoningEffort ?? DEFAULT_TEACHER_REASONING_EFFORT,
    reviewReasoningEffort: config.reviewReasoningEffort ?? DEFAULT_REVIEW_REASONING_EFFORT,
    supportsJsonSchema: config.supportsJsonSchema,
    supportsJsonObject: config.supportsJsonObject,
    supportsBase64Images: config.supportsBase64Images,
    enabled: config.enabled,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 3)}${"•".repeat(10)}${apiKey.slice(-4)}` : "",
    hasReviewApiKey: Boolean(reviewApiKey),
    reviewApiKeyMasked: reviewApiKey ? `${reviewApiKey.slice(0, 3)}${"•".repeat(10)}${reviewApiKey.slice(-4)}` : "",
    updatedAt: config.updatedAt
  };
}
