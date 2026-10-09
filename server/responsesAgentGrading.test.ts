import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { ModelConfigInput, Rubric } from "../shared/types.js";
import type { LargeQuestionGradingInput } from "./largeQuestionGrading.js";

vi.mock("./responsesAgentClient.js", () => ({
  callResponsesAgent: vi.fn()
}));

import { callResponsesAgent } from "./responsesAgentClient.js";
import { gradeLargeQuestionResponsesAgent } from "./responsesAgentGrading.js";

type GuardrailedResponsesAgentConfig = NonNullable<ModelConfigInput["responsesAgent"]> & {
  backendGuardrailsEnabled: boolean;
};

const rubric: Rubric = {
  title: "Responses Agent 测试题",
  recognizedQuestionText: "求速度",
  version: 1,
  status: "locked",
  questionType: "large",
  totalScore: 2,
  warnings: [],
  subquestions: [{
    id: "Q1",
    title: "第一问",
    maxScore: 2,
    finalAnswerPolicy: "full_credit",
    finalAnswers: [{ expression: "v=2", unit: "m/s" }],
    scorePoints: [{ id: "P1", title: "结果", description: "写出速度结果", score: 2, type: "result", expected: "v=2" }],
    deductions: []
  }]
};

const responsesAgentConfig: GuardrailedResponsesAgentConfig = {
  baseUrl: "https://responses.example.test/v1",
  apiKey: "sk-responses-secret",
  model: "responses-model",
  reasoningEffort: "low",
  timeoutMs: 10_000,
  maxOutputTokens: 4_096,
  maxToolRounds: 3,
  maxRegions: 6,
  independentVerifierEnabled: false,
  backendGuardrailsEnabled: true
};

const config: ModelConfigInput = {
  name: "responses-agent-test",
  baseUrl: "https://chat.example.test/v1",
  apiKey: "sk-chat-secret",
  visionModel: "vision-model",
  textModel: "text-model",
  timeoutMs: 10_000,
  maxRetries: 0,
  maxConcurrency: 2,
  maxOutputTokens: 4_096,
  unreadableReviewThreshold: 2,
  largeQuestionWorkflow: "responses_agent",
  supportsJsonSchema: true,
  supportsJsonObject: false,
  supportsBase64Images: true,
  enabled: true,
  responsesAgent: responsesAgentConfig
};

async function imageBuffer(color: { r: number; g: number; b: number } = { r: 248, g: 248, b: 248 }): Promise<Buffer> {
  return sharp({ create: { width: 100, height: 80, channels: 3, background: color } }).png().toBuffer();
}

async function gradingInput(overrides: Partial<LargeQuestionGradingInput> = {}): Promise<LargeQuestionGradingInput> {
  const question = await imageBuffer({ r: 220, g: 40, b: 20 });
  const reference = await imageBuffer({ r: 20, g: 80, b: 220 });
  return {
    id: "agent-grade-1",
    studentId: "student-1",
    fileName: "answer.png",
    mimeType: "image/png",
    imageBuffer: await imageBuffer(),
    rubric,
    questionText: "求速度",
    referenceText: "v=2 m/s",
    questionImages: [{ mimeType: "image/png", base64: question.toString("base64"), label: "题目图" }],
    referenceImages: [{ mimeType: "image/png", base64: reference.toString("base64"), label: "参考答案图" }],
    ...overrides
  };
}

function gradeData(options: {
  sourceImageId?: string;
  sourceToolCallIds?: string[];
  region?: [number, number, number, number];
  status?: "correct" | "incorrect" | "missing" | "uncertain";
  reviewRequired?: boolean;
} = {}) {
  const status = options.status ?? "correct";
  return {
    transcription: {
      lines: [{
        id: "line-1",
        subquestionId: "Q1",
        text: "v=2 m/s",
        latex: "v=2\\,m/s",
        region: options.region ?? [100, 200, 300, 120],
        status: "active" as const,
        confidence: 0.99,
        alternatives: [],
        sourceImageId: options.sourceImageId ?? "student-page",
        sourceToolCallIds: options.sourceToolCallIds ?? []
      }],
      ambiguities: []
    },
    finalAnswerJudgements: [{
      subquestionId: "Q1",
      status,
      evidenceLineIds: ["line-1"],
      studentAnswer: "v=2 m/s",
      referenceAnswer: "v=2 m/s",
      reason: "卷面最终答案清晰",
      confidence: 0.99,
      decisionSource: "teacher_model" as const
    }],
    decisions: [{
      subquestionId: "Q1",
      pointId: "P1",
      status: "satisfied" as const,
      evidenceLineIds: ["line-1"],
      evidenceQuote: "v=2 m/s",
      reason: "结果正确",
      confidence: 0.99,
      requiresReview: false,
      awardedScore: 2
    }],
    appliedDeductions: [],
    review_required: options.reviewRequired ?? false,
    review_items: [],
    final_basis: ["line-1"]
  };
}

function finalResponse(data: unknown, status = "completed") {
  const text = JSON.stringify(data);
  return {
    data: status === "completed" ? data : undefined,
    raw: JSON.stringify({ id: "resp-final", status, output_text: text }),
    response: { id: "resp-final", status },
    outputItems: [{ type: "message", content: [{ type: "output_text", text }] }],
    functionCalls: [],
    messageText: text,
    responseId: "resp-final",
    status,
    durationMs: 1,
    reasoningItemCount: 0
  };
}

function toolResponse(callId: string, name: string, args: Record<string, unknown>) {
  const functionCall = {
    id: `fc-${callId}`,
    callId,
    name,
    arguments: JSON.stringify(args)
  };
  const outputItems = [
    { type: "reasoning", id: `rs-${callId}`, encrypted_content: `opaque-${callId}` },
    { type: "function_call", id: functionCall.id, call_id: callId, name, arguments: functionCall.arguments }
  ];
  return {
    data: undefined,
    raw: JSON.stringify({ id: `resp-${callId}`, status: "completed", output: outputItems }),
    response: { id: `resp-${callId}`, status: "completed", output: outputItems },
    outputItems,
    functionCalls: [functionCall],
    responseId: `resp-${callId}`,
    status: "completed",
    durationMs: 1,
    reasoningItemCount: 1
  };
}

describe("Responses Agent large-question grading", () => {
  beforeEach(() => {
    vi.mocked(callResponsesAgent).mockReset();
  });

  it("grades directly from visual input without PaddleOCR and records WebP audit metadata", async () => {
    const data = gradeData();
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(data));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-1");
    const audit = grading.result.responsesAgentAudit;

    expect(vi.mocked(callResponsesAgent)).toHaveBeenCalledTimes(1);
    expect(grading.result.gradingPipeline).toBe("large_question_responses_agent");
    expect(grading.result.ocrAudit).toBeUndefined();
    expect(grading.result.score).toBe(2);
    expect(grading.result.scoreResolved).toBe(true);
    expect(grading.result.status).toBe("completed");
    expect(audit).toMatchObject({
      provider: "openai_responses",
      workflow: "responses_agent",
      store: false,
      maxToolRounds: 3,
      maxRegions: 6
    });
    expect(audit?.inputImages.every((image) => image.mimeType === "image/webp")).toBe(true);
    expect(audit?.inputImages.find((image) => image.role === "student")?.audit).toMatchObject({ quality: 90, grayscale: true, outputMimeType: "image/webp" });
    expect(audit?.inputImages.find((image) => image.role === "question")?.audit).toMatchObject({ quality: 90, grayscale: false, outputMimeType: "image/webp" });
    expect(audit?.inputImages.find((image) => image.role === "reference")?.audit).toMatchObject({ quality: 90, grayscale: false, outputMimeType: "image/webp" });
    expect(grading.artifactSource.agentArtifacts?.every((artifact) => artifact.mimeType === "image/webp")).toBe(true);
  });

  it("replays complete output items and removes tools on the forced final turn after three tool rounds", async () => {
    const toolRequests = [
      ["call-1", "inspect_page_tiles", { tileIds: ["r1c1"] }],
      ["call-2", "inspect_page_tiles", { tileIds: ["r1c2"] }],
      ["call-3", "inspect_page_tiles", { tileIds: ["r1c3"] }]
    ] as const;
    let callIndex = 0;
    vi.mocked(callResponsesAgent).mockImplementation(async () => {
      const request = toolRequests[callIndex];
      callIndex += 1;
      if (request) return toolResponse(request[0], request[1], request[2]);
      return finalResponse(gradeData());
    });

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-2");
    const calls = vi.mocked(callResponsesAgent).mock.calls;
    const finalCall = calls[3]?.[0] as unknown as Record<string, unknown> | undefined;
    const finalInput = Array.isArray(finalCall?.input) ? finalCall.input : [];

    expect(calls).toHaveLength(4);
    expect(grading.result.responsesAgentAudit?.rounds).toHaveLength(4);
    expect(finalCall?.tools).toBeUndefined();
    expect(finalCall?.toolChoice).toBeUndefined();
    expect(finalInput.some((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "reasoning")).toBe(true);
    expect(finalInput.filter((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "function_call")).toHaveLength(3);
    expect(finalInput.filter((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "function_call_output")).toHaveLength(3);
    expect(grading.result.score).toBe(2);
  });

  it("marks a legal result for review when the configured tool-round quota is actually exhausted", async () => {
    const cappedConfig: ModelConfigInput = {
      ...config,
      responsesAgent: { ...config.responsesAgent!, maxToolRounds: 1 }
    };
    vi.mocked(callResponsesAgent)
      .mockResolvedValueOnce(toolResponse("quota-call", "inspect_page_tiles", { tileIds: ["r1c1"] }))
      .mockResolvedValueOnce(finalResponse(gradeData()));

    const grading = await gradeLargeQuestionResponsesAgent(cappedConfig, await gradingInput(), "agent-operation-quota");

    expect(grading.result.score).toBe(2);
    expect(grading.result.scoreResolved).toBe(true);
    expect(grading.result.status).toBe("needs_review");
    expect(grading.result.reviewReasons.join("\n")).toContain("工具轮次上限 1");
  });

  it("marks a legal result for review when the configured unique-region quota is actually exhausted", async () => {
    const cappedConfig: ModelConfigInput = {
      ...config,
      responsesAgent: { ...config.responsesAgent!, maxRegions: 1 }
    };
    vi.mocked(callResponsesAgent)
      .mockResolvedValueOnce(toolResponse("region-quota-call", "inspect_page_tiles", { tileIds: ["r1c1"] }))
      .mockResolvedValueOnce(finalResponse(gradeData()));

    const grading = await gradeLargeQuestionResponsesAgent(cappedConfig, await gradingInput(), "agent-operation-region-quota");

    expect(grading.result.score).toBe(2);
    expect(grading.result.scoreResolved).toBe(true);
    expect(grading.result.status).toBe("needs_review");
    expect(grading.result.reviewReasons.join("\n")).toContain("局部区域上限 1");
  });

  it("shares the six-region budget across tile and rectangle tools, deduplicates equivalent coordinates, and rejects the seventh", async () => {
    const toolRequests = [
      ["call-1", "inspect_page_tiles", { tileIds: ["r1c1", "r1c2"] }],
      ["call-2", "inspect_page_region", { x: 0, y: 0, width: 250, height: 250 }],
      ["call-3", "inspect_page_tiles", { tileIds: ["r1c3", "r1c4", "r2c1", "r2c2", "r2c3"] }]
    ] as const;
    let callIndex = 0;
    vi.mocked(callResponsesAgent).mockImplementation(async () => {
      const request = toolRequests[callIndex];
      callIndex += 1;
      if (request) return toolResponse(request[0], request[1], request[2]);
      return finalResponse(gradeData());
    });

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-3");
    const toolAudits = grading.result.responsesAgentAudit?.rounds.flatMap((round) => round.toolCalls) ?? [];
    const regions = toolAudits.flatMap((tool) => tool.regions);
    const materialized = regions.filter((region) => region.imageSha256);
    const duplicate = regions.find((region) => region.sourceToolCallIds.includes("call-2"));
    const rejected = regions.find((region) => region.regionId === "r2c3");

    expect(materialized).toHaveLength(6);
    // Identical pixels may legitimately have the same hash; region identity is
    // tracked by the canonical coordinate-derived regionId.
    expect(new Set(materialized.map((region) => region.regionId)).size).toBe(6);
    expect(duplicate).toMatchObject({ regionId: "tile-1", normalizedRegion: [0, 0, 250, 250], mimeType: "image/webp" });
    expect(toolAudits[1]?.status).toBe("deduplicated");
    expect(rejected?.imageSha256).toBe("");
    expect(rejected?.sourceToolCallIds).toEqual(["call-3"]);
    expect(grading.result.status).toBe("needs_review");
    expect(grading.result.score).toBe(2);
    expect(grading.result.scoreResolved).toBe(true);
    expect(grading.result.gradingPipeline).toBe("large_question_responses_agent");
    expect(grading.artifactSource.agentArtifacts?.filter((artifact) => artifact.fileName.includes("tile-"))).toHaveLength(6);
  });

  it("marks out-of-bounds local inspection as review while retaining a safe resolved score", async () => {
    vi.mocked(callResponsesAgent)
      .mockResolvedValueOnce(toolResponse("bad-call", "inspect_page_region", { x: 900, y: 900, width: 200, height: 200 }))
      .mockResolvedValueOnce(finalResponse(gradeData()));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-4");
    const toolAudit = grading.result.responsesAgentAudit?.rounds[0]?.toolCalls[0];

    expect(toolAudit?.status).toBe("rejected");
    expect(toolAudit?.regions).toEqual([]);
    expect(grading.result.status).toBe("needs_review");
    expect(grading.result.score).toBe(2);
    expect(grading.result.scoreResolved).toBe(true);
    expect(grading.result.reviewReasons.join("\n")).toMatch(/越界|无效|失败/);
  });

  it.each(["incomplete", "failed"] as const)("discards a %s response and never falls back to the staged chain", async (status) => {
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(gradeData(), status));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), `agent-operation-${status}`);

    expect(grading.result.gradingPipeline).toBe("large_question_responses_agent");
    expect(grading.result.status).toBe("needs_review");
    expect(grading.result.score).toBe(0);
    expect(grading.result.scoreResolved).toBe(false);
    expect(grading.result.responsesAgentAudit?.rounds[0]?.status).toBe(status);
    expect(grading.result.reviewReasons.join("\n")).toContain("结果已作废");
  });

  it("rejects fabricated sourceImageId/sourceToolCallIds and lowers evidence confidence", async () => {
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(gradeData({
      sourceImageId: "not-from-this-run",
      sourceToolCallIds: ["not-a-real-call"]
    })));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-source");
    const line = grading.result.evidence.lines[0];

    expect(line).toMatchObject({ id: "line-1", status: "uncertain" });
    expect(line?.confidence).toBeLessThan(0.5);
    expect(grading.result.status).toBe("needs_review");
    expect(grading.result.reviewReasons.join("\n")).toContain("来源图像或工具调用未通过审计关联校验");
    expect(grading.result.gradingPipeline).toBe("large_question_responses_agent");
  });

  it.each(["question-1", "reference-1"] as const)("does not allow %s material images as student evidence sources", async (sourceImageId) => {
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(gradeData({ sourceImageId })));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-material-source");
    const line = grading.result.evidence.lines[0];

    expect(line).toMatchObject({ status: "uncertain" });
    expect(grading.result.reviewReasons.join("\n")).toContain("来源图像或工具调用未通过审计关联校验");
    expect(grading.result.score).toBe(2);
    expect(grading.result.scoreResolved).toBe(true);
    expect(grading.result.status).toBe("needs_review");
  });

  it("does not mark a successful duplicate inspection as a risk by itself", async () => {
    vi.mocked(callResponsesAgent)
      .mockResolvedValueOnce(toolResponse("duplicate-call-1", "inspect_page_tiles", { tileIds: ["r1c1"] }))
      .mockResolvedValueOnce(toolResponse("duplicate-call-2", "inspect_page_region", { x: 0, y: 0, width: 250, height: 250 }))
      .mockResolvedValueOnce(finalResponse(gradeData({ sourceImageId: "tile-1", sourceToolCallIds: ["duplicate-call-2"], region: [20, 20, 100, 100] })));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-duplicate-only");
    const duplicateAudit = grading.result.responsesAgentAudit?.rounds[1]?.toolCalls[0];

    expect(duplicateAudit?.status).toBe("deduplicated");
    expect(duplicateAudit?.regions[0]).toMatchObject({
      regionId: "tile-1",
      normalizedRegion: [0, 0, 250, 250],
      sourceToolCallIds: ["duplicate-call-2"]
    });
    expect(grading.result.status).toBe("completed");
    expect(grading.result.scoreResolved).toBe(true);
    expect(grading.result.evidence.lines[0]).toMatchObject({ status: "active" });
    expect(grading.result.reviewReasons).toEqual([]);
  });

  it("rejects a crop source whose claimed full-page line region lies outside that crop", async () => {
    vi.mocked(callResponsesAgent)
      .mockResolvedValueOnce(toolResponse("crop-call", "inspect_page_tiles", { tileIds: ["r1c1"] }))
      .mockResolvedValueOnce(finalResponse(gradeData({
        sourceImageId: "tile-1",
        sourceToolCallIds: ["crop-call"],
        region: [700, 700, 100, 100]
      })));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-cross-region-source");

    expect(grading.result.evidence.lines[0]).toMatchObject({ status: "uncertain" });
    expect(grading.result.reviewReasons.join("\n")).toContain("来源图像或工具调用未通过审计关联校验");
    expect(grading.result.score).toBe(2);
    expect(grading.result.status).toBe("needs_review");
  });

  it("keeps a correct full-credit score but marks missing final-answer evidence for review", async () => {
    const data = gradeData();
    data.finalAnswerJudgements[0].evidenceLineIds = [];
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(data));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-no-final-evidence");

    expect(grading.result.score).toBe(2);
    expect(grading.result.status).toBe("needs_review");
    expect(grading.result.scoreResolved).toBe(true);
    expect(grading.result.subquestions[0]).toMatchObject({
      finalAnswerStatus: "correct",
      finalAnswerEvidenceLineIds: [],
      score: 2
    });
    expect(grading.result.reviewReasons.join("\n")).toContain("correct 但没有有效 evidenceLineIds");
  });

  it.each([
    ["no evidence", [] as string[]],
    ["partially invalid evidence", ["line-1", "fabricated-line"] as string[]]
  ])("ignores a known deduction with %s", async (_caseName, evidenceLineIds) => {
    const deductionRubric: Rubric = {
      ...rubric,
      subquestions: [{
        ...rubric.subquestions[0]!,
        deductions: [{ id: "D1", reason: "单位错误", deduct: 1, exclusiveGroup: "unit" }]
      }]
    };
    const data = gradeData({ status: "incorrect" }) as {
      appliedDeductions: Array<{
        subquestionId: string;
        ruleId: string;
        evidenceLineIds: string[];
        reason: string;
        confidence: number;
      }>;
      [key: string]: unknown;
    };
    data.appliedDeductions = [{
      subquestionId: "Q1",
      ruleId: "D1",
      evidenceLineIds,
      reason: "单位错误",
      confidence: 0.99
    }];
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(data));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput({ rubric: deductionRubric }), "agent-operation-bad-deduction");

    expect(grading.result.score).toBe(2);
    expect(grading.result.subquestions[0]?.auditDeductions).toEqual([]);
    expect(grading.result.subquestions[0]?.deductions).toEqual([]);
    expect(grading.result.status).toBe("needs_review");
    expect(grading.result.reviewReasons.join("\n")).toContain("已忽略扣分");
  });

  it("does not award a model score for a satisfied point without active visual evidence", async () => {
    const data = gradeData({ status: "incorrect" });
    data.decisions[0].evidenceLineIds = [];
    data.decisions[0].awardedScore = 2;
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(data));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-bad-point-evidence");
    const point = grading.result.subquestions[0]?.decisions[0];

    expect(point).toMatchObject({ status: "unreadable", awardedScore: 0, requiresReview: true });
    expect(grading.result.score).toBe(0);
    expect(grading.result.scoreResolved).toBe(false);
  });

  it("normalizes a satisfied point to the locked rubric full value instead of trusting a partial model score", async () => {
    const data = gradeData({ status: "incorrect" });
    data.decisions[0].awardedScore = 0.5;
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(data));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-satisfied-partial-score");

    expect(grading.result.subquestions[0]?.decisions[0]).toMatchObject({ status: "satisfied", awardedScore: 2 });
    expect(grading.result.score).toBe(2);
  });

  it("downgrades incorrect or missing final answers without auditable evidence", async () => {
    const incorrect = gradeData({ status: "incorrect" });
    incorrect.finalAnswerJudgements[0].evidenceLineIds = [];
    const missing = gradeData({ status: "missing" });
    missing.finalAnswerJudgements[0].evidenceLineIds = [];
    vi.mocked(callResponsesAgent)
      .mockResolvedValueOnce(finalResponse(incorrect))
      .mockResolvedValueOnce(finalResponse(missing));

    const first = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-bad-incorrect-evidence");
    const second = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-bad-missing-evidence");

    expect(first.result.subquestions[0]?.finalAnswerStatus).toBe("uncertain");
    expect(first.result.scoreResolved).toBe(false);
    expect(second.result.subquestions[0]?.finalAnswerStatus).toBe("uncertain");
    expect(second.result.scoreResolved).toBe(false);
  });

  it("records an unsupported function tool as unknown instead of disguising it as a region tool", async () => {
    vi.mocked(callResponsesAgent)
      .mockResolvedValueOnce(toolResponse("unknown-call", "write_score", { score: 2 }))
      .mockResolvedValueOnce(finalResponse(gradeData()));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-unknown-tool");
    const audit = grading.result.responsesAgentAudit?.rounds[0]?.toolCalls[0];

    expect(audit).toMatchObject({ name: "unknown", requestedName: "write_score", status: "rejected" });
    expect(audit?.regions).toEqual([]);
    expect(audit?.resultSummary).toContain("未知只读工具");
    expect(grading.result.status).toBe("needs_review");
  });

  it.each(["incorrect", "missing"] as const)("raises %s to needs_review when backend guardrails are enabled", async (status) => {
    const guardedConfig: ModelConfigInput = {
      ...config,
      responsesAgent: {
        ...config.responsesAgent!,
        backendGuardrailsEnabled: true,
        independentVerifierEnabled: false
      } as GuardrailedResponsesAgentConfig
    };
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(gradeData({ status })));

    const grading = await gradeLargeQuestionResponsesAgent(guardedConfig, await gradingInput(), `agent-operation-guardrail-${status}`);

    expect(grading.result.status).toBe("needs_review");
    expect(grading.result.score).toBe(2);
    expect(grading.result.scoreResolved).toBe(true);
  });

  it.each(["incorrect", "missing"] as const)("can trigger the independent verifier for %s under backend guardrails", async (status) => {
    const guardedConfig: ModelConfigInput = {
      ...config,
      responsesAgent: {
        ...config.responsesAgent!,
        backendGuardrailsEnabled: true,
        independentVerifierEnabled: true
      } as GuardrailedResponsesAgentConfig
    };
    const verifierData = {
      verdict: "agree" as const,
      review_required: false,
      summary: "候选结果与卷面证据一致",
      conflicts: []
    };
    vi.mocked(callResponsesAgent)
      .mockResolvedValueOnce(finalResponse(gradeData({ status })))
      .mockResolvedValueOnce(finalResponse(verifierData));

    const grading = await gradeLargeQuestionResponsesAgent(guardedConfig, await gradingInput(), `agent-operation-guardrail-verifier-${status}`);
    const verifierAudit = grading.result.responsesAgentAudit?.independentVerifier;

    expect(vi.mocked(callResponsesAgent)).toHaveBeenCalledTimes(2);
    expect(verifierAudit).toMatchObject({ status: "completed", verdict: "agree" });
    expect(grading.result.status).toBe("needs_review");
  });

  it.each(["incorrect", "missing"] as const)("does not add a backend guardrail review for %s when disabled", async (status) => {
    const unguardedConfig: ModelConfigInput = {
      ...config,
      responsesAgent: {
        ...config.responsesAgent!,
        backendGuardrailsEnabled: false,
        independentVerifierEnabled: false
      } as GuardrailedResponsesAgentConfig
    };
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(gradeData({ status })));

    const grading = await gradeLargeQuestionResponsesAgent(unguardedConfig, await gradingInput(), `agent-operation-no-guardrail-${status}`);

    expect(vi.mocked(callResponsesAgent)).toHaveBeenCalledTimes(1);
    expect(grading.result.status).toBe("completed");
    expect(grading.result.score).toBe(2);
    expect(grading.result.scoreResolved).toBe(true);
  });

  it("does not invoke the optional verifier when backend guardrails are disabled", async () => {
    const unguardedConfig: ModelConfigInput = {
      ...config,
      responsesAgent: {
        ...config.responsesAgent!,
        backendGuardrailsEnabled: false,
        independentVerifierEnabled: true
      } as GuardrailedResponsesAgentConfig
    };
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(gradeData({ reviewRequired: true })));

    await gradeLargeQuestionResponsesAgent(unguardedConfig, await gradingInput(), "agent-operation-no-guardrail-verifier");

    expect(vi.mocked(callResponsesAgent)).toHaveBeenCalledTimes(1);
  });

  it("keeps evidence-source safety enforced when backend guardrails are disabled", async () => {
    const unguardedConfig: ModelConfigInput = {
      ...config,
      responsesAgent: {
        ...config.responsesAgent!,
        backendGuardrailsEnabled: false,
        independentVerifierEnabled: false
      } as GuardrailedResponsesAgentConfig
    };
    vi.mocked(callResponsesAgent).mockResolvedValueOnce(finalResponse(gradeData({
      status: "incorrect",
      sourceImageId: "not-from-this-run"
    })));

    const grading = await gradeLargeQuestionResponsesAgent(unguardedConfig, await gradingInput(), "agent-operation-evidence-safety-off");

    expect(grading.result.evidence.lines[0]).toMatchObject({ status: "uncertain" });
    expect(grading.result.status).toBe("needs_review");
    expect(grading.result.reviewReasons.join("\n")).toContain("来源图像或工具调用未通过审计关联校验");
  });

  it("runs the independent verifier in a fresh call and filters fabricated conflict evidence", async () => {
    const verifierConfig: ModelConfigInput = {
      ...config,
      responsesAgent: { ...config.responsesAgent!, independentVerifierEnabled: true }
    };
    const verifierData = {
      verdict: "conflict" as const,
      review_required: true,
      summary: "最终答案可能漏读单位",
      conflicts: [{
        subquestionId: "Q1",
        pointId: null,
        kind: "final_answer" as const,
        primaryStatus: "correct",
        verifierStatus: "uncertain",
        evidenceLineIds: ["line-1", "fabricated-line"],
        reason: "单位需要人工核对"
      }]
    };
    const primaryData = gradeData();
    primaryData.finalAnswerJudgements[0].evidenceLineIds = [];
    vi.mocked(callResponsesAgent)
      .mockResolvedValueOnce(finalResponse(primaryData))
      .mockResolvedValueOnce(finalResponse(verifierData));

    const grading = await gradeLargeQuestionResponsesAgent(verifierConfig, await gradingInput(), "agent-operation-verifier");
    const verifierAudit = grading.result.responsesAgentAudit?.independentVerifier;

    expect(vi.mocked(callResponsesAgent)).toHaveBeenCalledTimes(2);
    expect(verifierAudit).toMatchObject({ status: "completed", verdict: "conflict", reviewRequired: true });
    expect(verifierAudit?.conflicts[0]).toMatchObject({ subquestionId: "Q1", evidenceLineIds: ["line-1"] });
    expect(verifierAudit?.conflicts[0]?.reason).toContain("fabricated-line");
    expect(grading.result.score).toBe(2);
    expect(grading.result.status).toBe("needs_review");
  });

  it("runs local review crop recheck when final answer is uncertain with valid evidence lines", async () => {
    const primaryData = gradeData({ status: "uncertain" });
    const localReviewData = {
      finalAnswers: [{
        subquestionId: "Q1",
        status: "correct" as const,
        studentAnswer: "v=2 m/s",
        confidence: 0.95,
        reason: "局部放大后可确认结果为 v=2 m/s",
        requiresReview: false
      }],
      reviews: []
    };
    vi.mocked(callResponsesAgent)
      .mockResolvedValueOnce(finalResponse(primaryData))
      .mockResolvedValueOnce(finalResponse(localReviewData));

    const grading = await gradeLargeQuestionResponsesAgent(config, await gradingInput(), "agent-operation-local-review");

    expect(vi.mocked(callResponsesAgent)).toHaveBeenCalledTimes(2);
    expect(grading.result.responsesAgentAudit?.localReview).toMatchObject({
      status: "completed",
      cropCount: 1
    });
    expect(grading.result.subquestions[0]?.finalAnswerStatus).toBe("correct");
  });
});
