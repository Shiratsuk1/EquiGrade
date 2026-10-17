import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelConfigInput, ResponsesAgentConfigInput } from "../shared/types.js";

function responsesAgent(overrides: Partial<ResponsesAgentConfigInput> & { backendGuardrailsEnabled?: boolean } = {}): ResponsesAgentConfigInput & { backendGuardrailsEnabled: boolean } {
  return {
    baseUrl: "https://responses.example.test/v1",
    apiKey: "sk-agent-secret-123456",
    model: "responses-model",
    reasoningEffort: "low",
    timeoutMs: 20_000,
    maxOutputTokens: 8_000,
    maxToolRounds: 3,
    maxRegions: 6,
    independentVerifierEnabled: true,
    backendGuardrailsEnabled: true,
    verifierBaseUrl: "https://verifier.example.test/v1",
    verifierApiKey: "sk-verifier-secret-123456",
    verifierModel: "verifier-model",
    verifierReasoningEffort: "medium",
    ...overrides
  } as ResponsesAgentConfigInput & { backendGuardrailsEnabled: boolean };
}

function config(overrides: Partial<ModelConfigInput> = {}): ModelConfigInput {
  return {
    name: "配置测试",
    baseUrl: "https://chat.example.test/v1",
    apiKey: "sk-primary-secret-123456",
    visionModel: "vision-model",
    textModel: "text-model",
    reviewBaseUrl: "https://review.example.test/v1",
    reviewApiKey: "sk-review-secret-123456",
    reviewModel: "review-model",
    timeoutMs: 20_000,
    maxRetries: 1,
    maxConcurrency: 2,
    maxOutputTokens: 4_096,
    unreadableReviewThreshold: 2,
    largeQuestionWorkflow: "staged",
    teacherReasoningEffort: "disabled",
    reviewReasoningEffort: "low",
    responsesAgent: responsesAgent(),
    supportsJsonSchema: false,
    supportsJsonObject: true,
    supportsBase64Images: true,
    enabled: true,
    ...overrides
  };
}

describe("model configuration persistence", () => {
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    delete process.env.APP_DATA_DIR;
    vi.resetModules();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  async function withConfig<T>(operation: (store: typeof import("./configStore.js")) => Promise<T>): Promise<T> {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "hengzhun-config-"));
    process.env.APP_DATA_DIR = temporaryDirectory;
    vi.resetModules();
    const store = await import("./configStore.js");
    return operation(store);
  }

  it("defaults the active large-question workflow to staged and keeps strict JSON capabilities", async () => {
    await withConfig(async (store) => {
      const saved = await store.saveModelConfig(config({ responsesAgent: undefined }));
      const active = await store.readModelConfig();

      expect(saved.largeQuestionWorkflow).toBe("staged");
      expect(saved.stagedLayoutEngine).toBe("model_native");
      expect(saved.supportsJsonSchema).toBe(true);
      expect(saved.supportsJsonObject).toBe(false);
      expect(active?.largeQuestionWorkflow).toBe("staged");
      expect(active?.stagedLayoutEngine).toBe("model_native");
      expect(active?.responsesAgent).toMatchObject({
        reasoningEffort: "low",
        maxToolRounds: 3,
        maxRegions: 6,
        independentVerifierEnabled: false,
        backendGuardrailsEnabled: true
      });

      const modelNativeSaved = await store.saveModelConfig(config({
        stagedLayoutEngine: "model_native"
      }));
      const modelNativeActive = await store.readModelConfig();
      expect(modelNativeSaved.stagedLayoutEngine).toBe("model_native");
      expect(modelNativeActive?.stagedLayoutEngine).toBe("model_native");

      const disabled = await store.saveModelConfig(config({
        largeQuestionWorkflow: "responses_agent",
        responsesAgent: responsesAgent({ backendGuardrailsEnabled: false })
      }));
      const disabledActive = await store.readModelConfig();
      expect(disabled.responsesAgent?.backendGuardrailsEnabled).toBe(false);
      expect(disabledActive?.responsesAgent?.backendGuardrailsEnabled).toBe(false);
    });
  });

  it("masks keys for the UI, retains them on blank updates, and never writes them in plaintext", async () => {
    await withConfig(async (store) => {
      const first = await store.saveModelConfig(config({ largeQuestionWorkflow: "responses_agent" }));
      const firstAgent = first.responsesAgent;
      expect(first.apiKeyMasked).not.toContain("sk-primary-secret-123456");
      expect(first.responsesAgent?.apiKeyMasked).not.toContain("sk-agent-secret-123456");
      expect(first.responsesAgent?.verifierApiKeyMasked).not.toContain("sk-verifier-secret-123456");
      expect(first.hasApiKey).toBe(true);
      expect(first.hasReviewApiKey).toBe(true);
      expect(first.responsesAgent?.hasApiKey).toBe(true);
      expect(first.responsesAgent?.hasVerifierApiKey).toBe(true);
      expect(first).not.toHaveProperty("apiKey", "sk-primary-secret-123456");
      expect(first.responsesAgent).not.toHaveProperty("apiKey");
      expect(first.responsesAgent).not.toHaveProperty("verifierApiKey");

      const updated = await store.saveModelConfig(config({
        name: "配置测试·更新",
        apiKey: "",
        reviewApiKey: "",
        largeQuestionWorkflow: "responses_agent",
        responsesAgent: responsesAgent({
          apiKey: "",
          verifierApiKey: "",
          ...(firstAgent ? {
            baseUrl: firstAgent.baseUrl,
            model: firstAgent.model,
            timeoutMs: firstAgent.timeoutMs,
            maxOutputTokens: firstAgent.maxOutputTokens,
            maxToolRounds: firstAgent.maxToolRounds,
            maxRegions: firstAgent.maxRegions,
            independentVerifierEnabled: firstAgent.independentVerifierEnabled
          } : {})
        })
      }));
      const active = await store.readModelConfig();

      expect(updated.largeQuestionWorkflow).toBe("responses_agent");
      expect(active?.apiKey).toBe("sk-primary-secret-123456");
      expect(active?.reviewApiKey).toBe("sk-review-secret-123456");
      expect(active?.responsesAgent?.apiKey).toBe("sk-agent-secret-123456");
      expect(active?.responsesAgent?.verifierApiKey).toBe("sk-verifier-secret-123456");

      const encryptedFile = await readFile(path.join(temporaryDirectory!, "model-config.enc.json"), "utf8");
      expect(encryptedFile).not.toContain("sk-primary-secret-123456");
      expect(encryptedFile).not.toContain("sk-agent-secret-123456");
      expect(encryptedFile).not.toContain("sk-verifier-secret-123456");
    });
  });
});
