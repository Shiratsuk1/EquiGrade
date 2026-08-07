import type { ModelConfigInput } from "../shared/types.js";

type JsonSchema = Record<string, unknown>;

interface StructuredRequest {
  model: string;
  system: string;
  prompt: string;
  images?: Array<{ mimeType: string; base64: string; label?: string }>;
  schemaName: string;
  schema: JsonSchema;
}

function extractContent(payload: unknown): string {
  const body = payload as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item.text ?? "").join("");
  throw new Error("模型响应中缺少 choices[0].message.content");
}

function parseJson(content: string): unknown {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("模型未返回有效 JSON");
  }
}

async function request(
  config: ModelConfigInput,
  body: Record<string, unknown>,
  signal: AbortSignal
): Promise<{ json: unknown; durationMs: number }> {
  const startedAt = performance.now();
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey ?? ""}`
    },
    body: JSON.stringify(body),
    signal
  });
  const raw = await response.text();
  if (!response.ok) {
    const safeMessage = raw.slice(0, 800).replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
    throw new Error(`模型服务返回 ${response.status}: ${safeMessage}`);
  }
  return { json: JSON.parse(raw), durationMs: Math.round(performance.now() - startedAt) };
}

export async function callStructured<T>(
  config: ModelConfigInput,
  input: StructuredRequest
): Promise<{ data: T; durationMs: number; outputMode: string }> {
  const userContent: Array<Record<string, unknown>> = [{ type: "text", text: input.prompt }];
  for (const image of input.images ?? []) {
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
  let lastError: Error | null = null;

  for (const mode of modes) {
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const body: Record<string, unknown> = {
          model: input.model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: userContent }
          ],
          temperature: 0,
          max_tokens: config.maxOutputTokens
        };
        if (mode === "json_schema") {
          body.response_format = {
            type: "json_schema",
            json_schema: { name: input.schemaName, strict: true, schema: input.schema }
          };
        } else if (mode === "json_object") {
          body.response_format = { type: "json_object" };
        }
        const result = await request(config, body, controller.signal);
        return {
          data: parseJson(extractContent(result.json)) as T,
          durationMs: result.durationMs,
          outputMode: mode
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < config.maxRetries) continue;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  throw lastError ?? new Error("模型调用失败");
}

export async function testModelConnection(
  config: ModelConfigInput,
  mode: "text" | "vision"
): Promise<{ ok: true; durationMs: number; model: string; message: string }> {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=";
  const result = await callStructured<{ status: string }>({ ...config, maxRetries: 0 }, {
    model: mode === "vision" ? config.visionModel : config.textModel,
    system: "Return only valid JSON. Do not include markdown.",
    prompt: mode === "vision"
      ? "Confirm that an image was supplied. Return {\"status\":\"ok\"}."
      : "Return {\"status\":\"ok\"}.",
    images: mode === "vision" ? [{ mimeType: "image/png", base64: tinyPng, label: "[连接测试图片]" }] : undefined,
    schemaName: "connection_test",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { status: { type: "string" } },
      required: ["status"]
    }
  });
  return {
    ok: true,
    durationMs: result.durationMs,
    model: mode === "vision" ? config.visionModel : config.textModel,
    message: `连接成功，结构化输出模式：${result.outputMode}`
  };
}
