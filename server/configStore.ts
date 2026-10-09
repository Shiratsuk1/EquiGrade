import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_GRADING_MODE,
  DEFAULT_MODEL_TIMEOUT_MS,
  DEFAULT_LARGE_QUESTION_WORKFLOW,
  DEFAULT_RESPONSES_AGENT_MAX_OUTPUT_TOKENS,
  DEFAULT_RESPONSES_AGENT_MAX_REGIONS,
  DEFAULT_RESPONSES_AGENT_MAX_TOOL_ROUNDS,
  DEFAULT_RESPONSES_AGENT_REASONING_EFFORT,
  DEFAULT_RESPONSES_AGENT_TIMEOUT_MS,
  DEFAULT_REVIEW_REASONING_EFFORT,
  DEFAULT_TEACHER_REASONING_EFFORT,
  DEFAULT_UNREADABLE_REVIEW_THRESHOLD,
  DEFAULT_STAGED_LAYOUT_ENGINE,
  TEACHER_REASONING_EFFORTS
} from "../shared/types.js";
import type { GradingMode, LargeQuestionWorkflow, ModelConfigInput, PublicModelConfig, ResponsesAgentConfigInput, StagedLayoutEngine, TeacherReasoningEffort } from "../shared/types.js";
import { mergeModelRoutes } from "../shared/modelRouting.js";
import {
  DEFAULT_PADDLEOCR_JOB_URL,
  DEFAULT_PADDLEOCR_MODEL,
  DEFAULT_PADDLEOCR_POLL_INTERVAL_MS,
  DEFAULT_PADDLEOCR_TIMEOUT_MS
} from "./paddleOcr.js";

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
  // The former global grading-mode switch is intentionally retired. Keep the
  // field in persisted/history shapes for backward compatibility, but all
  // saved configurations now resolve to the staged large-question pipeline.
  const gradingMode: GradingMode = DEFAULT_GRADING_MODE;
  const largeQuestionWorkflow: LargeQuestionWorkflow = config.largeQuestionWorkflow === "responses_agent"
    ? "responses_agent"
    : DEFAULT_LARGE_QUESTION_WORKFLOW;
  const stagedLayoutEngine: StagedLayoutEngine = config.stagedLayoutEngine === "model_native"
    ? "model_native"
    : DEFAULT_STAGED_LAYOUT_ENGINE;
  const paddle = config.paddleOcr ?? {};
  const paddlePollIntervalMs = Number(paddle.pollIntervalMs);
  const paddleTimeoutMs = Number(paddle.timeoutMs);
  const paddleOcr = {
    jobUrl: paddle.jobUrl?.trim() || DEFAULT_PADDLEOCR_JOB_URL,
    model: paddle.model?.trim() || DEFAULT_PADDLEOCR_MODEL,
    pollIntervalMs: Number.isFinite(paddlePollIntervalMs) && paddlePollIntervalMs >= 0
      ? Math.floor(paddlePollIntervalMs)
      : DEFAULT_PADDLEOCR_POLL_INTERVAL_MS,
    timeoutMs: Number.isFinite(paddleTimeoutMs) && paddleTimeoutMs >= 1_000
      ? Math.floor(paddleTimeoutMs)
      : DEFAULT_PADDLEOCR_TIMEOUT_MS,
    useDocOrientationClassify: paddle.useDocOrientationClassify === true,
    useDocUnwarping: paddle.useDocUnwarping === true,
    useChartRecognition: paddle.useChartRecognition === true
  };
  const agent: Partial<ResponsesAgentConfigInput> = config.responsesAgent ?? {};
  const agentTimeoutMs = Number(agent.timeoutMs);
  const agentMaxOutputTokens = Number(agent.maxOutputTokens);
  const agentMaxToolRounds = Number(agent.maxToolRounds);
  const agentMaxRegions = Number(agent.maxRegions);
  const verifierReasoningEffort = agent.verifierReasoningEffort;
  const responsesAgent: ResponsesAgentConfigInput = {
    baseUrl: agent.baseUrl?.trim().replace(/\/+$/, "") || config.baseUrl.trim().replace(/\/+$/, ""),
    ...(agent.apiKey?.trim() ? { apiKey: agent.apiKey.trim() } : {}),
    model: agent.model?.trim() || config.visionModel.trim(),
    reasoningEffort: agent.reasoningEffort && TEACHER_REASONING_EFFORTS.includes(agent.reasoningEffort)
      ? agent.reasoningEffort
      : DEFAULT_RESPONSES_AGENT_REASONING_EFFORT,
    timeoutMs: Number.isFinite(agentTimeoutMs) && agentTimeoutMs >= 1_000
      ? Math.floor(agentTimeoutMs)
      : DEFAULT_RESPONSES_AGENT_TIMEOUT_MS,
    maxOutputTokens: Number.isFinite(agentMaxOutputTokens) && agentMaxOutputTokens >= 256
      ? Math.min(65_536, Math.floor(agentMaxOutputTokens))
      : DEFAULT_RESPONSES_AGENT_MAX_OUTPUT_TOKENS,
    maxToolRounds: Number.isFinite(agentMaxToolRounds) && agentMaxToolRounds >= 0
      ? Math.min(3, Math.floor(agentMaxToolRounds))
      : DEFAULT_RESPONSES_AGENT_MAX_TOOL_ROUNDS,
    maxRegions: Number.isFinite(agentMaxRegions) && agentMaxRegions >= 0
      ? Math.min(6, Math.floor(agentMaxRegions))
      : DEFAULT_RESPONSES_AGENT_MAX_REGIONS,
    // Old configurations predate this switch and must retain the safer
    // behavior. Only an explicit false disables semantic-risk escalation.
    backendGuardrailsEnabled: agent.backendGuardrailsEnabled !== false,
    independentVerifierEnabled: agent.independentVerifierEnabled === true,
    ...(agent.verifierBaseUrl?.trim() ? { verifierBaseUrl: agent.verifierBaseUrl.trim().replace(/\/+$/, "") } : {}),
    ...(agent.verifierApiKey?.trim() ? { verifierApiKey: agent.verifierApiKey.trim() } : {}),
    ...(agent.verifierModel?.trim() ? { verifierModel: agent.verifierModel.trim() } : {}),
    ...(verifierReasoningEffort && TEACHER_REASONING_EFFORTS.includes(verifierReasoningEffort) ? { verifierReasoningEffort } : {})
  };
  return {
    ...config,
    // The current grading contract only permits provider-enforced strict JSON
    // Schema output. Keep the legacy capability fields for compatibility with
    // old saved configurations, but normalize their effective values here.
    supportsJsonSchema: true,
    supportsJsonObject: false,
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
    gradingMode,
    largeQuestionWorkflow,
    stagedLayoutEngine,
    modelRoutes: mergeModelRoutes(config),
    paddleOcr,
    responsesAgent
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
  if (!config.apiKey && !config.responsesAgent?.apiKey) throw new Error("当前模型配置缺少 API Key");
  return config;
}

export async function saveModelConfig(input: ModelConfigInput): Promise<PublicModelConfig> {
  const current = await readModelConfig();
  const apiKey = input.apiKey?.trim() || current?.apiKey || "";
  const reviewApiKey = input.reviewApiKey?.trim() || current?.reviewApiKey || "";
  const incomingAgent = input.responsesAgent;
  const currentAgent = current?.responsesAgent;
  const responsesAgent = incomingAgent ? {
    ...incomingAgent,
    baseUrl: incomingAgent.baseUrl.trim().replace(/\/+$/, ""),
    model: incomingAgent.model.trim(),
    ...(incomingAgent.apiKey?.trim() || currentAgent?.apiKey ? { apiKey: incomingAgent.apiKey?.trim() || currentAgent?.apiKey } : {}),
    ...(incomingAgent.verifierApiKey?.trim() || currentAgent?.verifierApiKey ? { verifierApiKey: incomingAgent.verifierApiKey?.trim() || currentAgent?.verifierApiKey } : {})
  } : currentAgent;
  const stored: StoredConfig = {
    ...input,
    supportsJsonSchema: true,
    supportsJsonObject: false,
    name: input.name.trim(),
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    apiKey,
    visionModel: input.visionModel.trim(),
    textModel: input.textModel.trim(),
    reviewBaseUrl: input.reviewBaseUrl?.trim().replace(/\/+$/, "") ?? "",
    reviewApiKey,
    reviewModel: input.reviewModel?.trim() ?? "",
    ...(responsesAgent ? { responsesAgent } : {}),
    id: current?.id ?? crypto.randomUUID(),
    updatedAt: new Date().toISOString()
  };
  const normalized = withConfigDefaults(stored);
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify(await encrypt(normalized)), "utf8");
  return toPublicConfig(normalized);
}

export function toPublicConfig(config: StoredConfig): PublicModelConfig {
  const apiKey = config.apiKey ?? "";
  const reviewApiKey = config.reviewApiKey ?? "";
  const agent = config.responsesAgent;
  const agentApiKey = agent?.apiKey ?? "";
  const verifierApiKey = agent?.verifierApiKey ?? "";
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
    largeQuestionWorkflow: config.largeQuestionWorkflow ?? DEFAULT_LARGE_QUESTION_WORKFLOW,
    stagedLayoutEngine: config.stagedLayoutEngine ?? DEFAULT_STAGED_LAYOUT_ENGINE,
    teacherReasoningEffort: config.teacherReasoningEffort ?? DEFAULT_TEACHER_REASONING_EFFORT,
    reviewReasoningEffort: config.reviewReasoningEffort ?? DEFAULT_REVIEW_REASONING_EFFORT,
    modelRoutes: config.modelRoutes,
    paddleOcr: config.paddleOcr,
    ...(agent ? {
      responsesAgent: {
        baseUrl: agent.baseUrl,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort,
        timeoutMs: agent.timeoutMs,
        maxOutputTokens: agent.maxOutputTokens,
        maxToolRounds: agent.maxToolRounds,
        maxRegions: agent.maxRegions,
        backendGuardrailsEnabled: agent.backendGuardrailsEnabled,
        independentVerifierEnabled: agent.independentVerifierEnabled,
        ...(agent.verifierBaseUrl ? { verifierBaseUrl: agent.verifierBaseUrl } : {}),
        ...(agent.verifierModel ? { verifierModel: agent.verifierModel } : {}),
        ...(agent.verifierReasoningEffort ? { verifierReasoningEffort: agent.verifierReasoningEffort } : {}),
        apiKeyMasked: agentApiKey ? `${agentApiKey.slice(0, 3)}${"•".repeat(10)}${agentApiKey.slice(-4)}` : "",
        hasApiKey: Boolean(agentApiKey),
        verifierApiKeyMasked: verifierApiKey ? `${verifierApiKey.slice(0, 3)}${"•".repeat(10)}${verifierApiKey.slice(-4)}` : "",
        hasVerifierApiKey: Boolean(verifierApiKey)
      }
    } : {}),
    supportsJsonSchema: true,
    supportsJsonObject: false,
    supportsBase64Images: config.supportsBase64Images,
    enabled: config.enabled,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 3)}${"•".repeat(10)}${apiKey.slice(-4)}` : "",
    hasReviewApiKey: Boolean(reviewApiKey),
    reviewApiKeyMasked: reviewApiKey ? `${reviewApiKey.slice(0, 3)}${"•".repeat(10)}${reviewApiKey.slice(-4)}` : "",
    updatedAt: config.updatedAt
  };
}
