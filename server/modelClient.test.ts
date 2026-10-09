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

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" }
  });
}

function failedSseResponse(message: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error(message));
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" }
  });
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("model call audit logging", () => {
  beforeEach(() => {
    clearCompletedLogs();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends standard API headers and scoped Cloudflare Access service-token headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "{\"status\":\"ok\"}" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("HENGZHUN_CLOUDFLARE_ACCESS_HOST", "example.test");
    vi.stubEnv("HENGZHUN_CLOUDFLARE_ACCESS_CLIENT_ID", "access-client-id");
    vi.stubEnv("HENGZHUN_CLOUDFLARE_ACCESS_CLIENT_SECRET", "access-client-secret");

    await testModelConnection(config, "text");

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Accept).toContain("text/event-stream");
    expect(headers.Accept).toContain("application/json");
    expect(headers["User-Agent"]).toBe("Hengzhun-Physics-Grading/0.1");
    expect(headers["CF-Access-Client-Id"]).toBe("access-client-id");
    expect(headers["CF-Access-Client-Secret"]).toBe("access-client-secret");
  });

  it("does not send Cloudflare Access credentials to a different model host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "{\"status\":\"ok\"}" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("HENGZHUN_CLOUDFLARE_ACCESS_HOST", "another.example.test");
    vi.stubEnv("HENGZHUN_CLOUDFLARE_ACCESS_CLIENT_ID", "access-client-id");
    vi.stubEnv("HENGZHUN_CLOUDFLARE_ACCESS_CLIENT_SECRET", "access-client-secret");

    await testModelConnection(config, "text");

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["CF-Access-Client-Id"]).toBeUndefined();
    expect(headers["CF-Access-Client-Secret"]).toBeUndefined();
  });

  it("connects through the configured model proxy to the configured URL", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "{\"status\":\"ok\"}" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("HENGZHUN_MODEL_PROXY_URL", "http://127.0.0.1:7897");

    await testModelConnection(config, "text");

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(requestInit.dispatcher).toBeDefined();
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.test/v1/chat/completions");
  });

  it("reports the model URL when the proxy request cannot connect", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    vi.stubEnv("HENGZHUN_MODEL_PROXY_URL", "http://127.0.0.1:7897");

    await expect(testModelConnection({ ...config, supportsJsonSchema: false, supportsJsonObject: false }, "text"))
      .rejects.toThrow("模型通过代理请求 URL https://example.test/v1/chat/completions 失败：connect ECONNREFUSED");
  });

  it("retries a transient proxy transport failure with the dispatcher", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{\"status\":\"ok\"}" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("HENGZHUN_MODEL_PROXY_URL", "http://127.0.0.1:7897");

    await testModelConnection({ ...config, maxRetries: 1 }, "text");

    const firstDispatcher = (fetchMock.mock.calls[0][1] as RequestInit & { dispatcher?: unknown }).dispatcher;
    const secondDispatcher = (fetchMock.mock.calls[1][1] as RequestInit & { dispatcher?: unknown }).dispatcher;
    expect(firstDispatcher).toBeDefined();
    expect(secondDispatcher).toBe(firstDispatcher);
  });

  it("allows explicitly bypassing the outbound proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "{\"status\":\"ok\"}" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("HENGZHUN_MODEL_PROXY_URL", "direct");

    await testModelConnection(config, "text");

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(requestInit.dispatcher).toBeUndefined();
  });

  it("explains a Cloudflare HTML block instead of reporting a JSON parse failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<html><title>Attention Required! | Cloudflare</title><h1>Sorry, you have been blocked</h1></html>",
      { status: 403, headers: { "Content-Type": "text/html", Server: "cloudflare", "CF-RAY": "test-ray" } }
    )));

    await expect(testModelConnection({ ...config, supportsJsonSchema: false, supportsJsonObject: false }, "text"))
      .rejects.toThrow("Cloudflare 拦截了模型 API 请求（403，CF-RAY test-ray）");
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
    expect(details.callId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(details.request.systemPrompt).toContain("[REDACTED]");
    expect(details.request.systemPrompt).toContain("JSON 的反斜杠转义由本地程序负责");
    expect(details.request.systemPrompt).not.toContain(SAFE_LATEX_BACKSLASH_TOKEN);
    expect(details.request.userPrompt).toBe("这是完整的用户 Prompt。");
    expect(details.request.images).toHaveLength(1);
    expect(details.request.images[0]).toMatchObject({
      label: "[学生作答原图]",
      mimeType: "image/png",
      bytes: Buffer.from("private-image-bytes").length
    });
    expect(details.response?.raw).toBe(rawResponse);
    expect(details.response?.content).toBe("{\"status\":\"ok\"}");
    expect(details.responseHeadersMs).toEqual(expect.any(Number));
    expect(details.firstContentMs).toEqual(expect.any(Number));
    expect(details.outputChars).toBe("{\"status\":\"ok\"}".length);
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

  it("applies the configured route System Prompt before the mandatory safety protocol", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "{\"status\":\"ok\"}" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await callStructured<{ status: string }>({
      ...config,
      modelRoutes: {
        large_question_answer_triage: {
          endpoint: "teacher",
          model: config.visionModel,
          systemPrompt: "只补充首轮答案转录要求",
          systemPromptMode: "append"
        }
      }
    }, {
      model: config.visionModel,
      routeKey: "large_question_answer_triage",
      system: "当前步骤内置提示词",
      prompt: "返回状态",
      schemaName: "route_system_prompt_test",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { status: { type: "string" } },
        required: ["status"]
      }
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const systemMessage = body.messages?.find((message) => message.role === "system");
    expect(systemMessage?.content).toContain("当前步骤内置提示词");
    expect(systemMessage?.content).toContain("只补充首轮答案转录要求");
    expect(systemMessage?.content).toContain("JSON 的反斜杠转义由本地程序负责");
    expect(systemMessage?.content).not.toContain(SAFE_LATEX_BACKSLASH_TOKEN);
  });

  it("captures a retryable failure as a warning and the eventual successful raw response", async () => {
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
    expect(calls.map((call) => call.status)).toEqual(["progress", "completed"]);
    expect(calls[0].level).toBe("warning");
    expect(calls[0].details.callId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(calls[0].details.errorClass).toBe("http_error");
    expect(calls[0].details.response?.raw).toBe("temporary failure");
    expect(calls[1].details.response?.content).toBe("{\"status\":\"ok\"}");
    expect(calls[1].details.callId).toMatch(/^[0-9a-f-]{36}$/i);
    releaseOperationModelCalls("operation-retry-history");
  });

  it("requests SSE and reconstructs fragmented structured JSON before validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      sseData({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { content: '{"status":' } }] }),
      sseData({ choices: [{ delta: { content: '"ok"}' } }] }),
      sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n"
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callStructured<{ status: string }>(config, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "streaming_json_test",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { status: { type: "string" } },
        required: ["status"]
      },
      operationId: "streaming-metrics-test"
    });

    expect(result.data).toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).response_format.type).toBe("json_schema");
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(requestBody.stream).toBe(true);
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Accept).toContain("text/event-stream");
    const call = getOperationModelCalls("streaming-metrics-test")[0];
    expect(call.details.streamContentMode).toBe("delta");
    expect(call.details.streamEventCount).toBe(4);
    expect(call.details.outputChars).toBe('{"status":"ok"}'.length);
    expect(call.details.firstContentMs).toEqual(expect.any(Number));
    releaseOperationModelCalls("streaming-metrics-test");
  });

  it("treats streamed message.content values as complete snapshots", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      sseData({ choices: [{ message: { content: '{"status":"empty"}' } }] }),
      sseData({ choices: [{ message: { content: '{"status":"ok"}' }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n"
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callStructured<{ status: string }>({
      ...config,
      supportsJsonSchema: false,
      supportsJsonObject: false
    }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "streaming_message_snapshot_test",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { status: { type: "string", enum: ["ok"] } },
        required: ["status"]
      }
    });

    expect(result.data).toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).response_format.type).toBe("json_schema");
  });

  it("rejects mixed streamed content protocols instead of concatenating them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      sseData({ choices: [{ delta: { content: '{"status":"' } }] }),
      sseData({ choices: [{ message: { content: '{"status":"ok"}' }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n"
    ])));

    await expect(callStructured<{ status: string }>({
      ...config,
      supportsJsonSchema: false,
      supportsJsonObject: false
    }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "streaming_mixed_protocol_test",
      schema: { type: "object" }
    })).rejects.toThrow("混用了 delta 和 message_snapshot");
  });

  it("retries one time after a stream closes before [DONE]", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        sseData({ choices: [{ delta: { content: '{"status":"ok"' } }] })
      ]))
      .mockResolvedValueOnce(sseResponse([
        sseData({ choices: [{ delta: { content: '{"status":"ok"}' }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n"
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callStructured<{ status: string }>({ ...config, maxRetries: 1 }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "stream_interrupted_retry_test",
      schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] }
    });

    expect(result.data).toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).stream).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).stream).toBe(true);
  });

  it("retries when an upstream stream is reported as terminated", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failedSseResponse("terminated"))
      .mockResolvedValueOnce(sseResponse([
        sseData({ choices: [{ delta: { content: '{\"status\":\"ok\"}' }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n"
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callStructured<{ status: string }>({ ...config, maxRetries: 1 }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "terminated_stream_retry_test",
      schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] }
    });

    expect(result.data).toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries an upstream response.completed disconnect with streaming", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        sseData({ error: { message: "stream error: stream disconnected before completion: stream closed before response.completed", type: "upstream_error" } })
      ]))
      .mockResolvedValueOnce(sseResponse([
        sseData({ choices: [{ delta: { content: '{"status":"ok"}' }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n"
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callStructured<{ status: string }>({ ...config, maxRetries: 1 }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "upstream_disconnect_stream_retry_test",
      schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
      operationId: "upstream-disconnect-stream-retry"
    });

    expect(result.data).toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).stream).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).stream).toBe(true);
    const failedCall = getOperationModelCalls("upstream-disconnect-stream-retry")[0];
    expect(failedCall.details.streamEventCount).toBe(1);
    expect(failedCall.details.outputChars).toBe(0);
    expect(failedCall.details.streamDurationMs).toEqual(expect.any(Number));
    expect(failedCall.details.responseHeadersMs).toEqual(expect.any(Number));
    releaseOperationModelCalls("upstream-disconnect-stream-retry");
  });

  it("treats a stream with finish_reason but no [DONE] as interrupted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      sseData({ choices: [{ delta: { content: '{"status":"ok"}' }, finish_reason: "stop" }] })
    ])));

    await expect(callStructured<{ status: string }>({
      ...config,
      maxRetries: 0,
      supportsJsonSchema: false,
      supportsJsonObject: false
    }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "stream_finish_without_done_test",
      schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] }
    })).rejects.toThrow("[DONE] 前中断");
  });

  it("does not fan out a 524 failure into other output modes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("gateway timeout", {
      status: 524,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callStructured<{ status: string }>({ ...config, maxRetries: 2 }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "no_524_mode_fanout_test",
      schema: { type: "object" }
    })).rejects.toThrow("524");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails without switching output mode when the provider rejects strict response_format", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "json_schema response_format is not supported" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"status":"ok"}' } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callStructured<{ status: string }>({ ...config, maxRetries: 1 }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "format_strict_rejection_test",
      schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] }
    })).rejects.toThrow("模型服务返回 400");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).response_format.type).toBe("json_schema");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).stream).toBe(true);
  });

  it("fails without switching output mode when the gateway hides a schema rejection as an upstream 400", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Upstream request failed" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"status":"ok"}' } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callStructured<{ status: string }>({ ...config, maxRetries: 1 }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "opaque_strict_rejection_test",
      schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] }
    })).rejects.toThrow("模型服务返回 400");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).response_format.type).toBe("json_schema");
  });

  it("uses one global retry budget instead of retrying every output mode", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "not-json" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "still-not-json" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callStructured<{ status: string }>({ ...config, maxRetries: 1 }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "global_retry_budget_test",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { status: { type: "string" } },
        required: ["status"]
      }
    })).rejects.toThrow("完整有效的 JSON");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps retries for each output mode at one extra attempt", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "not-json" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callStructured<{ status: string }>({ ...config, maxRetries: 2 }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "per_mode_retry_cap_test",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { status: { type: "string" } },
        required: ["status"]
      }
    })).rejects.toThrow("完整有效的 JSON");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects streamed JSON when the provider ends with the token limit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      sseData({ choices: [{ delta: { content: '{"status":"ok"' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: "length" }] }),
      "data: [DONE]\n\n"
    ])));

    await expect(callStructured<{ status: string }>({
      ...config,
      supportsJsonSchema: false,
      supportsJsonObject: false
    }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "streaming_truncated_json_test",
      schema: { type: "object" }
    })).rejects.toThrow("Token 上限");
  });

  it("does not fall back to non-streaming when the provider rejects streaming", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "stream is not supported" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
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
      schemaName: "streaming_fallback_test",
      schema: { type: "object" }
    })).rejects.toThrow("stream is not supported");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).stream).toBe(true);
  });

  it("retries a structurally valid but semantically incomplete response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"items":[]}' } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"items":["L1"]}' } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callStructured<{ items: string[] }>({ ...config, maxRetries: 1 }, {
      model: config.visionModel,
      system: "Return all required items.",
      prompt: "Return the required items.",
      schemaName: "semantic_completeness_retry_test",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { items: { type: "array", items: { type: "string" } } },
        required: ["items"]
      },
      validate: (value) => {
        const items = (value as { items?: unknown }).items;
        if (!Array.isArray(items) || items.length === 0) throw new Error("结果缺少必需项目");
        return value as { items: string[] };
      },
      operationId: "operation-semantic-completeness-retry"
    });

    expect(result.data).toEqual({ items: ["L1"] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getOperationModelCalls("operation-semantic-completeness-retry").map((call) => call.status))
      .toEqual(["progress", "completed"]);
    expect(getOperationModelCalls("operation-semantic-completeness-retry")[0].details.error)
      .toContain("结果缺少必需项目");
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as {
      messages?: Array<{ content?: unknown }>;
    };
    expect(JSON.stringify(secondRequest.messages?.[1]?.content)).toContain("结果缺少必需项目");
    expect(JSON.stringify(secondRequest.messages?.[1]?.content)).toContain("不要原样重复上一轮结果");
    expect(JSON.stringify(secondRequest.messages?.[1]?.content)).toContain("schemaName 是 semantic_completeness_retry_test");
    expect(JSON.stringify(secondRequest.messages?.[1]?.content)).not.toContain("direct_vision_grading");
    releaseOperationModelCalls("operation-semantic-completeness-retry");
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

  it("decodes a historical safe LaTeX token only after the model JSON is complete", async () => {
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
    expect(requestBody.messages[0].content).toContain("JSON 的反斜杠转义由本地程序负责");
    expect(requestBody.messages[0].content).not.toContain(SAFE_LATEX_BACKSLASH_TOKEN);
  });

  it("retries a KaTeX-invalid structured response with the failing field path", async () => {
    const firstContent = JSON.stringify({ evidenceQuote: String.raw`$\Delta x=\left{x_1-x_2\right}$` });
    const secondContent = JSON.stringify({ evidenceQuote: String.raw`$\Delta x=\left\{x_1-x_2\right\}$` });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: firstContent } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: secondContent } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callStructured<{ evidenceQuote: string }>({ ...config, maxRetries: 1 }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return a formula.",
      schemaName: "large_question_point_review",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { evidenceQuote: { type: "string" } },
        required: ["evidenceQuote"]
      }
    });

    expect(result.data.evidenceQuote).toBe(String.raw`$\Delta x=\left\{x_1-x_2\right\}$`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(retryBody.messages[1].content[0].text).toContain("$model.evidenceQuote");
    expect(retryBody.messages[1].content[0].text).toContain("\\left\\{");

  });

  it("repairs a single JSON escape that would turn a LaTeX command into a control character", async () => {
    const unsafeContent = String.raw`{"latex":"\right)"}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: unsafeContent } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await callStructured<{ latex: string }>({
      ...config,
      supportsJsonSchema: false,
      supportsJsonObject: false
    }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return a formula.",
      schemaName: "unsafe_formula_transport_test",
      schema: { type: "object" }
    });
    expect(result.data.latex).toBe(String.raw`\right)`);
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

  it("does not accept multiple root JSON objects concatenated in one response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: '{"status":"ok"}{"status":"ok"}' } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(callStructured<{ status: string }>({
      ...config,
      supportsJsonSchema: false,
      supportsJsonObject: false
    }, {
      model: config.textModel,
      system: "Return JSON.",
      prompt: "Return status.",
      schemaName: "multiple_root_json_test",
      schema: { type: "object" }
    })).rejects.toThrow("Unexpected non-whitespace character");
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
