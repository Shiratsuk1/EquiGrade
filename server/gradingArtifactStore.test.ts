import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GradingResult, Rubric } from "../shared/types.js";
import {
  deleteGradingArtifacts,
  getGradingArtifactDirectory,
  resolveGradingArtifactPath,
  saveGradingArtifacts,
  type GradingArtifactSource
} from "./gradingArtifactStore.js";

const rubric: Rubric = {
  title: "缓存测试题",
  recognizedQuestionText: "题目",
  version: 1,
  status: "saved",
  questionType: "large",
  totalScore: 1,
  subquestions: [],
  warnings: []
};

const result: GradingResult = {
  id: "artifact-result-1",
  studentId: "student-1",
  fileName: "answer.png",
  score: 1,
  maxScore: 1,
  status: "completed",
  reviewReasons: [],
  evidence: { lines: [], finalAnswers: [], ambiguities: [] },
  subquestions: [],
  metrics: { ruleCoverage: 1, evidenceTraceability: 1, autoDecisionRate: 1, ambiguityRate: 0, durationMs: 1 },
  modelName: "teacher",
  gradingPipeline: "large_question",
  gradingMode: "vision_direct",
  rubricVersion: 1,
  ocrAudit: {
    provider: "paddleocr",
    model: "paddleocr-vl",
    jobId: "ocr-job-1",
    rawJsonl: "{\"text\":\"v=1\"}",
    markdownText: "v=1",
    durationMs: 2,
    layoutBlocks: []
  }
};

describe("grading artifact store", () => {
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it("writes the enhanced image and every audit/result artifact without copying the raw answer", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "hengzhun-artifacts-"));
    vi.stubEnv("HENGZHUN_GRADING_ARTIFACT_DIR", temporaryDirectory);
    const source: GradingArtifactSource = {
      preprocessedStudentAnswer: { buffer: Buffer.from("enhanced-answer"), mimeType: "image/png", fileName: "answer.png" },
      questionImages: [{ mimeType: "image/png", base64: Buffer.from("question-image").toString("base64"), label: "题目" }],
      referenceImages: [{ mimeType: "image/jpeg", base64: Buffer.from("reference-image").toString("base64"), label: "参考答案" }],
      questionText: "题目",
      referenceText: "参考答案",
      rubric
    };

    const artifacts = await saveGradingArtifacts({ result, source, modelCalls: [] });
    const directory = path.join(getGradingArtifactDirectory(), result.id);
    const names = await readdir(directory);

    expect(names).toEqual(expect.arrayContaining([
      "student-answer-preprocessed.png",
      "question-01.png",
      "reference-01.jpg",
      "ocr.raw.jsonl",
      "ocr.markdown.md",
      "ocr.layout-blocks.json",
      "ocr.audit.json",
      "model-calls.json",
      "grading-context.json",
      "grading-result.json",
      "artifact-manifest.json"
    ]));
    expect(names).not.toContain("student-answer-original.png");
    expect(artifacts.find((artifact) => artifact.id === "student-answer-preprocessed.png")?.url)
      .toBe("/api/grading-artifacts/artifact-result-1/student-answer-preprocessed.png");
    expect(await readFile(resolveGradingArtifactPath(result.id, "student-answer-preprocessed.png")!)).toEqual(Buffer.from("enhanced-answer"));
    expect(resolveGradingArtifactPath(result.id, "../outside.json")).toBeNull();

    await deleteGradingArtifacts([result.id]);
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists Responses Agent WebP audit artifacts without creating a PaddleOCR bundle", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "hengzhun-agent-artifacts-"));
    vi.stubEnv("HENGZHUN_GRADING_ARTIFACT_DIR", temporaryDirectory);
    const agentResult: GradingResult = {
      ...result,
      id: "artifact-agent-result",
      gradingPipeline: "large_question_responses_agent",
      ocrAudit: undefined,
      responsesAgentAudit: {
        provider: "openai_responses",
        workflow: "responses_agent",
        store: false,
        model: "responses-model",
        baseUrl: "https://example.test/v1",
        startedAt: "2026-08-31T00:00:00.000Z",
        durationMs: 10,
        maxToolRounds: 3,
        maxRegions: 6,
        rounds: [{
          round: 1,
          responseId: "resp-1",
          status: "completed",
          durationMs: 10,
          outputItemTypes: ["reasoning", "message"],
          functionCallIds: [],
          toolCalls: [],
          rawResponse: '{"status":"completed"}'
        }],
        inputImages: [{
          label: "学生答卷整页",
          mimeType: "image/webp",
          sha256: "student-hash",
          bytes: 14,
          role: "student",
          artifactFileName: "responses-agent-student-page.webp",
          audit: {
            inputMimeType: "image/png",
            outputMimeType: "image/webp",
            inputBytes: 20,
            outputBytes: 14,
            width: 80,
            height: 60,
            quality: 90,
            grayscale: true,
            geometryPreserved: true,
            operations: ["grayscale", "webp_q90"]
          }
        }],
        transcriptionLineCount: 1,
        finalAnswerCount: 1,
        finalBasis: ["L1"],
        reviewReasons: [],
        reasoningItemCount: 1
      }
    };
    const webp = Buffer.from("agent-webp-bytes");
    const source: GradingArtifactSource = {
      preprocessedStudentAnswer: { buffer: webp, mimeType: "image/webp", fileName: "answer.webp" },
      questionImages: [{ mimeType: "image/webp", base64: webp.toString("base64"), label: "题目" }],
      referenceImages: [{ mimeType: "image/webp", base64: webp.toString("base64"), label: "参考答案" }],
      questionText: "题目",
      referenceText: "参考答案",
      rubric,
      agentArtifacts: [
        { fileName: "responses-agent-student-grid.webp", mimeType: "image/webp", category: "agent_region", buffer: webp },
        { fileName: "responses-agent-region-1.webp", mimeType: "image/webp", category: "agent_region", buffer: webp }
      ]
    };

    await saveGradingArtifacts({ result: agentResult, source, modelCalls: [] });
    const directory = path.join(getGradingArtifactDirectory(), agentResult.id);
    const names = await readdir(directory);

    expect(names).toEqual(expect.arrayContaining([
      "student-answer-preprocessed.webp",
      "question-01.webp",
      "reference-01.webp",
      "agent-responses-agent-student-grid.webp",
      "agent-responses-agent-region-1.webp",
      "grading-result.json",
      "artifact-manifest.json"
    ]));
    expect(names).not.toContain("ocr.raw.jsonl");
    expect(await readFile(path.join(directory, "agent-responses-agent-region-1.webp"))).toEqual(webp);
    const persistedResult = JSON.parse(await readFile(path.join(directory, "grading-result.json"), "utf8")) as GradingResult;
    expect(persistedResult.gradingPipeline).toBe("large_question_responses_agent");
    expect(persistedResult.responsesAgentAudit?.store).toBe(false);
    expect(persistedResult.responsesAgentAudit?.inputImages[0]?.audit?.quality).toBe(90);
  });
});
