import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAFE_LATEX_BACKSLASH_TOKEN } from "../shared/formulaProtocol.js";
import type { ModelCallLogDetails, ModelConfigInput } from "../shared/types.js";
import { callStructured, testModelConnection } from "./modelClient.js";
import {
  beginOperation,
  clearCompletedLogs,
  forceStopOperation,
  getLogSnapshot,
  getOperationModelCalls,
  releaseOperationModelCalls
} from "./systemLog.js";

const config: ModelConfigInput = {
  name: "test",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-api-secret-value",
  visionModel: "vision-model",
  textModel: "text-model",
  timeoutMs: 1000,
  maxRetries: 0,
  maxConcurrency: 1,
  maxOutputTokens: 1024,
  unreadableReviewThreshold: 2,
  supportsJsonSchema: true,
  supportsJsonObject: true,
  supportsBase64Images: true,
  enabled: true
};

describe("model call audit logging", () => {
  beforeEach(() => {
    clearCompletedLogs();
    vi.unstubAllGlobals();
  });

  it("records prompts and the raw response without persisting credentials or image base64", async () => {
    const imageBase64 = Buffer.from("private-image-bytes").toString("base64");
    const rawResponse = JSON.stringify({
      id: "response-id",
      choices: [{ message: { content: "{\"status\":\"ok\"}" } }]
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(rawResponse, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    await callStructured<{ status: string }>(config, {
      model: config.visionModel,
      system: "系统提示词，密钥样例 sk-prompt-secret 不应出现在日志中。",
      prompt: "这是完整的用户 Prompt。",
      images: [{ mimeType: "image/png", base64: imageBase64, label: "[学生作答原图]" }],
      schemaName: "audit_test",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { status: { type: "string" } },
        required: ["status"]
      },
      operationId: "operation-audit-test"
    });

    const entry = getLogSnapshot(20).entries.find((item) => item.step === "model_call");
    expect(entry).toBeDefined();
    const details = entry?.details as ModelCallLogDetails;
    expect(details.request.systemPrompt).toContain("[REDACTED]");
    expect(details.request.systemPrompt).toContain(SAFE_LATEX_BACKSLASH_TOKEN);
    expect(details.request.userPrompt).toBe("这是完整的用户 Prompt。");
    expect(details.request.images).toHaveLength(1);
    expect(details.request.images[0]).toMatchObject({
      label: "[学生作答原图]",
      mimeType: "image/png",
      bytes: Buffer.from("private-image-bytes").length
    });
    expect(details.response?.raw).toBe(rawResponse);
    expect(details.response?.content).toBe("{\"status\":\"ok\"}");
    expect(JSON.stringify(details)).not.toContain(config.apiKey);
    expect(JSON.stringify(details)).not.toContain(imageBase64);
    expect(JSON.stringify(details)).not.toContain("sk-prompt-secret");
    const historyCalls = getOperationModelCalls("operation-audit-test");
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0].details.response?.raw).toBe(rawResponse);
    expect(historyCalls[0].details.request.images[0].sha256).toBe(details.request.images[0].sha256);
    clearCompletedLogs();
    expect(getOperationModelCalls("operation-audit-test")).toHaveLength(1);
    releaseOperationModelCalls("operation-audit-test");
    expect(getOperationModelCalls("operation-audit-test")).toHaveLength(0);
  });

  it("captures every failed retry and the eventual successful raw response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{\"status\":\"ok\"}" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await callStructured<{ status: string }>({ ...config, maxRetries: 1 }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "retry_history_test",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { status: { type: "string" } },
        required: ["status"]
      },
      operationId: "operation-retry-history"
    });

    const calls = getOperationModelCalls("operation-retry-history");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.status)).toEqual(["failed", "completed"]);
    expect(calls[0].details.response?.raw).toBe("temporary failure");
    expect(calls[1].details.response?.content).toBe("{\"status\":\"ok\"}");
    releaseOperationModelCalls("operation-retry-history");
  });

  it("passes all six configured reasoning efforts through to the provider and audit log", async () => {
    const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
    const operationId = "operation-reasoning-efforts";
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "{\"status\":\"ok\"}" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    for (const reasoningEffort of efforts) {
      await callStructured<{ status: string }>(config, {
        model: config.textModel,
        system: "Return JSON.",
        prompt: "Return status.",
        schemaName: `reasoning_${reasoningEffort}`,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { status: { type: "string" } },
          required: ["status"]
        },
        reasoningEffort,
        operationId
      });
    }

    const requestBodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(requestBodies.map((body) => body.reasoning_effort)).toEqual(efforts);
    expect(getOperationModelCalls(operationId).map((call) => call.details.request.reasoningEffort)).toEqual(efforts);
    releaseOperationModelCalls(operationId);
  });

  it("uses the review model's independent endpoint and API key for its connection test", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "{\"status\":\"ok\"}" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testModelConnection({
      ...config,
      reviewBaseUrl: "https://review.example.test/v1",
      reviewApiKey: "review-secret",
      reviewModel: "fast-review"
    }, "review");

    expect(result.model).toBe("fast-review");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://review.example.test/v1/chat/completions");
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer review-secret");
    expect(headers.Authorization).not.toContain(config.apiKey);
  });

  it("rejects review calls without falling back to the teacher API key", async () => {
    await expect(testModelConnection({
      ...config,
      reviewModel: "fast-review",
      reviewApiKey: ""
    }, "review")).rejects.toThrow("不会使用教师模型密钥代替");
  });

  it("decodes the safe LaTeX token only after the model JSON is complete", async () => {
    const content = JSON.stringify({ latex: `${SAFE_LATEX_BACKSLASH_TOKEN}frac{1}{2}mv^2` });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callStructured<{ latex: string }>(config, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return a formula.",
      schemaName: "formula_transport_test",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { latex: { type: "string" } },
        required: ["latex"]
      }
    });

    expect(result.data.latex).toBe(String.raw`\frac{1}{2}mv^2`);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(requestBody.messages[0].content).toContain(SAFE_LATEX_BACKSLASH_TOKEN);
  });

  it("rejects a single JSON escape that would turn a LaTeX command into a control character", async () => {
    const unsafeContent = String.raw`{"latex":"\right)"}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: unsafeContent } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(callStructured<{ latex: string }>({
      ...config,
      supportsJsonSchema: false,
      supportsJsonObject: false
    }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return a formula.",
      schemaName: "unsafe_formula_transport_test",
      schema: { type: "object" }
    })).rejects.toThrow("未安全编码的 LaTeX 反斜杠");
  });

  it("rejects responses stopped by the token limit before parsing partial JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "{\"status\":\"ok\"" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(callStructured<{ status: string }>({
      ...config,
      supportsJsonSchema: false,
      supportsJsonObject: false
    }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "truncated_json_test",
      schema: { type: "object" }
    })).rejects.toThrow("Token 上限");
  });

  it("does not follow model endpoint redirects with the API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "http://169.254.169.254/latest/meta-data" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callStructured<{ status: string }>({
      ...config,
      supportsJsonSchema: false,
      supportsJsonObject: false
    }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "redirect_test",
      schema: { type: "object" }
    })).rejects.toThrow("重定向");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("aborts an in-flight model request immediately without retrying", async () => {
    const operationId = beginOperation("grading", "开始批改待停止答卷", "vision_direct_grade");
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const request = callStructured<{ status: string }>({ ...config, maxRetries: 2 }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "force_stop_test",
      schema: { type: "object" },
      operationId
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(forceStopOperation(operationId)).not.toBeNull();

    await expect(request).rejects.toThrow("任务已被用户强制停止");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getLogSnapshot(20).activeOperations.some((operation) => operation.id === operationId)).toBe(false);
  });
});
