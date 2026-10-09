import { describe, expect, it } from "vitest";
import { extractStructuredModelResult, logScopeLabel, logStatusLabel } from "./logPresentation";
import type { ModelCallLogDetails } from "../shared/types";

function details(response: ModelCallLogDetails["response"]): ModelCallLogDetails {
  return {
    kind: "model_call",
    model: "test-model",
    schemaName: "test_schema",
    outputMode: "json_schema",
    attempt: 1,
    maxAttempts: 1,
    request: {
      systemPrompt: "system",
      userPrompt: "user",
      images: []
    },
    response
  };
}

describe("log presentation", () => {
  it("extracts structured chat-completion content and decodes safe LaTeX tokens", () => {
    const payload = {
      finalAnswerJudgements: [{
        subquestionId: "1-1",
        status: "correct",
        studentAnswer: "v=[[LATEX_BS]]frac{1}{2} m/s"
      }]
    };
    const result = extractStructuredModelResult(details({
      status: 200,
      raw: JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] })
    }));

    expect(result).toEqual({
      finalAnswerJudgements: [{
        subquestionId: "1-1",
        status: "correct",
        studentAnswer: "v=\\frac{1}{2} m/s"
      }]
    });
  });

  it("extracts output_text from a Responses envelope without showing the envelope", () => {
    const result = extractStructuredModelResult(details({
      status: 200,
      raw: JSON.stringify({
        id: "resp-test",
        output: [{ type: "message", content: [{ type: "output_text", text: "```json\n{\"review_required\":true,\"final_basis\":[\"x=[[LATEX_BS]]sqrt{2}\"]}\n```" }] }]
      })
    }));

    expect(result).toEqual({ review_required: true, final_basis: ["x=\\sqrt{2}"] });
  });

  it("returns null for an unusable provider response and keeps labels human-readable", () => {
    expect(extractStructuredModelResult(details({ status: 502, raw: "upstream unavailable" }))).toBeNull();
    expect(logScopeLabel("model")).toBe("模型调用");
    expect(logStatusLabel("completed")).toBe("完成");
  });
});
