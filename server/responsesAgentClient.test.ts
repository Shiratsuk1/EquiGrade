import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfigInput } from "../shared/types.js";
import { callResponsesAgent } from "./responsesAgentClient.js";

const config: ModelConfigInput = {
  name: "responses-test",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test-secret",
  visionModel: "vision-model",
  textModel: "text-model",
  timeoutMs: 5_000,
  maxRetries: 0,
  maxConcurrency: 2,
  maxOutputTokens: 1_024,
  unreadableReviewThreshold: 2,
  supportsJsonSchema: true,
  supportsJsonObject: false,
  supportsBase64Images: true,
  enabled: true
};

function response(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function streamResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${String(event.type ?? "message")}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

function completedMessage(text = '{"status":"ok"}'): Record<string, unknown> {
  return {
    id: "resp_test",
    status: "completed",
    output_text: text,
    output: [{ type: "message", content: [{ type: "output_text", text }] }]
  };
}

describe("Responses Agent transport contract", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends store:false, encrypted reasoning inclusion and strict text schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(completedMessage()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callResponsesAgent({
      config,
      baseUrl: "https://example.test/v1",
      apiKey: config.apiKey!,
      model: "vision-model",
      instructions: "return JSON",
      input: [{ role: "user", content: [{ type: "input_text", text: "ok" }] }],
      schemaName: "test_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string" } }
      },
      validate: (value) => value as { status: string },
      round: 1
    });

    expect(result.data).toEqual({ status: "ok" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, any>;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(String(body.instructions)).toContain("JSON 的反斜杠转义由本地程序负责");
    expect(String(body.instructions)).not.toContain("[[LATEX_BS]]");
    expect(body.previous_response_id).toBeUndefined();
    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        name: "test_schema",
        strict: true,
        schema: expect.any(Object)
      }
    });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("reconstructs a streamed final message from response output item events", async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([
      { type: "response.created", response: { id: "resp_stream", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_stream", type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_stream", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"status":"ok"}' }] } },
      { type: "response.completed", response: { id: "resp_stream", status: "completed" } }
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callResponsesAgent({
      config,
      baseUrl: "https://example.test/v1",
      apiKey: config.apiKey!,
      model: "vision-model",
      instructions: "return JSON",
      input: [{ role: "user", content: [{ type: "input_text", text: "ok" }] }],
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string" } } },
      validate: (value) => value as { status: string },
      round: 1
    });

    expect(result.data).toEqual({ status: "ok" });
    expect(result.status).toBe("completed");
    expect(result.outputItems.map((item) => (item as { type?: string }).type)).toEqual(["message"]);
  });

  it("reconstructs streamed function-call arguments and preserves the call item", async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([
      { type: "response.output_item.added", output_index: 0, item: { id: "rs_stream", type: "reasoning", encrypted_content: "opaque" } },
      { type: "response.output_item.done", output_index: 0, item: { id: "rs_stream", type: "reasoning", encrypted_content: "opaque" } },
      { type: "response.output_item.added", output_index: 1, item: { id: "fc_stream", type: "function_call", call_id: "call_stream", name: "probe", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_stream", delta: '{"value":"' },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_stream", delta: "ok" },
      { type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_stream", arguments: '{"value":"ok"}' },
      { type: "response.completed", response: { id: "resp_tools_stream", status: "completed" } }
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callResponsesAgent({
      config,
      baseUrl: "https://example.test/v1",
      apiKey: config.apiKey!,
      model: "vision-model",
      instructions: "call probe",
      input: [{ role: "user", content: [{ type: "input_text", text: "call" }] }],
      tools: [{ name: "probe", description: "probe", parameters: { type: "object", additionalProperties: false, required: [], properties: {} } }],
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false, required: [], properties: {} },
      round: 1
    });

    expect(result.functionCalls).toEqual([{ id: "fc_stream", callId: "call_stream", name: "probe", arguments: '{"value":"ok"}' }]);
    expect(result.outputItems.map((item) => (item as { type?: string }).type)).toEqual(["reasoning", "function_call"]);
  });

  it("refuses a Chat Completions endpoint before making an outbound request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(callResponsesAgent({
      config,
      baseUrl: "https://example.test/v1/chat/completions",
      apiKey: config.apiKey!,
      model: "vision-model",
      instructions: "return JSON",
      input: [{ role: "user", content: [{ type: "input_text", text: "ok" }] }],
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false, required: [], properties: {} },
      round: 1
    })).rejects.toThrow(/不能使用 \/chat\/completions/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns parallel function calls and preserves every output item for stateless continuation", async () => {
    const firstOutput = [
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque-reasoning" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "inspect_page_tiles", arguments: '{"tileIds":["r1c1"]}' },
      { type: "function_call", id: "fc_2", call_id: "call_2", name: "inspect_page_region", arguments: '{"x":10,"y":20,"width":30,"height":40}' }
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: "resp_tools", status: "completed", output: firstOutput }))
      .mockResolvedValueOnce(response(completedMessage()));
    vi.stubGlobal("fetch", fetchMock);

    const tools = [
      { name: "inspect_page_tiles", description: "tiles", parameters: { type: "object", additionalProperties: false, required: [], properties: {} } },
      { name: "inspect_page_region", description: "region", parameters: { type: "object", additionalProperties: false, required: [], properties: {} } }
    ];
    const initialInput = [{ role: "user", content: [{ type: "input_text", text: "inspect" }] }];
    const first = await callResponsesAgent({
      config,
      baseUrl: "https://example.test/v1",
      apiKey: config.apiKey!,
      model: "vision-model",
      instructions: "inspect",
      input: initialInput,
      tools,
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string" } } },
      round: 1
    });

    expect(first.functionCalls.map((call) => call.callId)).toEqual(["call_1", "call_2"]);
    expect(first.outputItems).toEqual(firstOutput);

    const functionOutputs = [
      { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: '{"ok":true}' }] },
      { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: '{"ok":true}' }] }
    ];
    const second = await callResponsesAgent({
      config,
      baseUrl: "https://example.test/v1",
      apiKey: config.apiKey!,
      model: "vision-model",
      instructions: "finish",
      input: [...initialInput, ...first.outputItems, ...functionOutputs],
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string" } } },
      validate: (value) => value as { status: string },
      round: 2
    });

    expect(second.data).toEqual({ status: "ok" });
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, any>;
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, any>;
    expect(firstBody.parallel_tool_calls).toBe(true);
    expect(firstBody.tools).toHaveLength(2);
    expect(firstBody.tools.every((tool: Record<string, unknown>) => tool.strict === true)).toBe(true);
    expect(firstBody.tools.map((tool: Record<string, unknown>) => tool.name)).toEqual(["inspect_page_tiles", "inspect_page_region"]);
    expect(secondBody.parallel_tool_calls).toBe(true);
    expect(secondBody.store).toBe(false);
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.input.slice(-5)).toEqual([...firstOutput, ...functionOutputs]);
  });

  it.each(["queued", "in_progress", "incomplete", "failed", "cancelled", ""])(
    "rejects a non-completed Responses status: %s",
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(response({ ...completedMessage(), status: status || undefined }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(callResponsesAgent({
        config,
        baseUrl: "https://example.test/v1",
        apiKey: config.apiKey!,
        model: "vision-model",
        instructions: "return JSON",
        input: [{ role: "user", content: [{ type: "input_text", text: "ok" }] }],
        schemaName: "test_schema",
        schema: { type: "object", additionalProperties: false, required: [], properties: {} },
        round: 1
      })).rejects.toThrow(/不可用状态/);
    }
  );

  it("rejects duplicate function call ids instead of replaying an ambiguous output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      id: "resp_tools",
      status: "completed",
      output: [
        { type: "function_call", id: "fc_1", call_id: "call_same", name: "probe", arguments: "{}" },
        { type: "function_call", id: "fc_2", call_id: "call_same", name: "probe", arguments: "{}" }
      ]
    })));

    await expect(callResponsesAgent({
      config,
      baseUrl: "https://example.test/v1",
      apiKey: config.apiKey!,
      model: "vision-model",
      instructions: "call probe",
      input: [{ role: "user", content: [{ type: "input_text", text: "call" }] }],
      tools: [{ name: "probe", description: "probe", parameters: { type: "object", additionalProperties: false, required: [], properties: {} } }],
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false, required: [], properties: {} },
      round: 1
    })).rejects.toThrow(/重复的 function_call call_id/);
  });

  it("decodes the safe LaTeX token only in final message JSON and validates the decoded formula", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(completedMessage('{"formula":"$[[LATEX_BS]]frac{1}{2}$"}')));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callResponsesAgent({
      config,
      baseUrl: "https://example.test/v1",
      apiKey: config.apiKey!,
      model: "vision-model",
      instructions: "return a formula",
      input: [{ role: "user", content: [{ type: "input_text", text: "formula" }] }],
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false, required: ["formula"], properties: { formula: { type: "string" } } },
      validate: (value) => value as { formula: string },
      round: 1
    });

    expect(result.data).toEqual({ formula: "$\\frac{1}{2}$" });
  });

  it("rejects invalid LaTeX in final message JSON without inspecting reasoning output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(completedMessage('{"formula":"$[[LATEX_BS]]notacommand$","reasoning":"\\\\notacommand"}')));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callResponsesAgent({
      config,
      baseUrl: "https://example.test/v1",
      apiKey: config.apiKey!,
      model: "vision-model",
      instructions: "return a formula",
      input: [{ role: "user", content: [{ type: "input_text", text: "formula" }] }],
      schemaName: "test_schema",
      schema: { type: "object", additionalProperties: false, required: ["formula", "reasoning"], properties: { formula: { type: "string" }, reasoning: { type: "string" } } },
      round: 1
    })).rejects.toThrow(/无法由 KaTeX 渲染的公式/);
  });
});
