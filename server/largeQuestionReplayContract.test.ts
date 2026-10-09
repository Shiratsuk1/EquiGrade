import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PaddleOcrAudit, Rubric } from "../shared/types.js";

vi.mock("./modelClient.js", async () => {
  const actual = await vi.importActual<typeof import("./modelClient.js")>("./modelClient.js");
  return { ...actual, callStructured: vi.fn() };
});

vi.mock("./paddleOcr.js", async () => {
  const actual = await vi.importActual<typeof import("./paddleOcr.js")>("./paddleOcr.js");
  return { ...actual, runPaddleOcr: vi.fn() };
});

import { callStructured } from "./modelClient.js";
import { extractPaddleOcrLayoutMetadata, runPaddleOcr } from "./paddleOcr.js";
import { rubricSchema } from "./schemas.js";
import { gradeStudentAnswer } from "./workflows.js";

type JsonRecord = Record<string, unknown>;

const recordFixtureAvailable = existsSync(path.resolve(".data/history.json"))
  && existsSync(path.resolve(".data/reconstruction-rubric-ab-result.json"));

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 不是对象`);
  return value as JsonRecord;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 缺少有效字符串`);
  return value;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function readJson(filePath: string): Promise<JsonRecord> {
  return asRecord(JSON.parse(await readFile(filePath, "utf8")) as unknown, filePath);
}

async function loadLatestLargeRecord() {
  const history = await readJson(path.resolve(".data/history.json"));
  const candidates: Array<{ template: JsonRecord; record: JsonRecord; rubric: Rubric }> = [];
  for (const templateValue of asArray(history.templates)) {
    const template = asRecord(templateValue, "history.templates[]");
    if (template.builtIn === true) continue;
    for (const recordValue of asArray(template.records)) {
      const record = asRecord(recordValue, "history.templates[].records[]");
      try {
        const rubric = rubricSchema.parse(record.rubricSnapshot ?? template.rubric);
        const hasSubquestion1 = rubric.subquestions.some((subquestion) => subquestion.id === "1");
        const has3Subquestions = rubric.subquestions.length >= 3;
        const storedResult = record.result && typeof record.result === "object" && !Array.isArray(record.result) ? record.result as Record<string, unknown> : undefined;
        const hasOcr = Boolean(storedResult?.ocrAudit);
        if ((rubric.questionType ?? "large") === "large" && hasSubquestion1 && has3Subquestions && hasOcr) {
          candidates.push({ template, record, rubric });
        }
      } catch {
        // Ignore legacy or incomplete records; select the newest usable large-question record.
      }
    }
  }
  candidates.sort((left, right) => asString(right.record.createdAt, "record.createdAt").localeCompare(asString(left.record.createdAt, "record.createdAt")));
  const selected = candidates[0];
  if (!selected) throw new Error("没有找到可重放的真实大题批改记录");
  return selected;
}

async function toModelImage(fileValue: unknown, templateId: string, label: string) {
  const file = asRecord(fileValue, "history image");
  const diskName = asString(file.diskName, "history image.diskName");
  const buffer = await readFile(path.resolve(".data/history-assets", templateId, diskName));
  return { mimeType: asString(file.mimeType, "history image.mimeType"), base64: buffer.toString("base64"), label };
}

describe("large-question record-backed complete-chain contract", () => {
  it.skipIf(!recordFixtureAvailable)("用最近真实大题记录回放新三段链路并确认第1问为3分", async () => {
    vi.mocked(callStructured).mockReset();
    vi.mocked(runPaddleOcr).mockReset();

    const { template, record, rubric } = await loadLatestLargeRecord();
    const templateId = asString(template.id, "template.id");
    const recordId = asString(record.id, "record.id");
    const answerImage = asRecord(record.answerImage, "record.answerImage");
    const answerBuffer = await readFile(path.resolve(
      ".data/history-assets",
      templateId,
      asString(answerImage.diskName, "record.answerImage.diskName")
    ));

    const cache = await readJson(path.resolve(".data/reconstruction-rubric-ab-result.json"));
    const storedResult = record.result && typeof record.result === "object" && !Array.isArray(record.result)
      ? asRecord(record.result, "record.result")
      : undefined;
    const storedOcr = storedResult?.ocrAudit && typeof storedResult.ocrAudit === "object" && !Array.isArray(storedResult.ocrAudit)
      ? asRecord(storedResult.ocrAudit, "record.result.ocrAudit")
      : undefined;
    const cachedOcr = storedOcr?.rawJsonl
      ? storedOcr
      : asRecord(cache.ocr, "reconstruction cache.ocr");
    const rawJsonl = asString(cachedOcr.rawJsonl, "cached OCR rawJsonl");
    const replayAudit: PaddleOcrAudit = {
      provider: "paddleocr",
      model: asString(cachedOcr.model, "cached OCR model"),
      jobId: asString(cachedOcr.jobId, "cached OCR jobId"),
      rawJsonl,
      markdownText: asString(cachedOcr.markdownText, "cached OCR markdownText"),
      durationMs: typeof cachedOcr.durationMs === "number" ? cachedOcr.durationMs : 0,
      ...extractPaddleOcrLayoutMetadata(rawJsonl)
    };

    const usableBlocks = replayAudit.layoutBlocks ?? [];
    const q1Block = usableBlocks.find((block) => block.blockId === "block-16")
      ?? usableBlocks.find((block) => block.label === "display_formula");
    const q2Block = usableBlocks.find((block) => block.blockId === "block-14")
      ?? usableBlocks.find((block) => block.blockId !== q1Block?.blockId);
    const q3Block = usableBlocks.find((block) => block.blockId === "block-17")
      ?? usableBlocks.find((block) => block.blockId !== q1Block?.blockId && block.blockId !== q2Block?.blockId);
    const targetSubquestion = rubric.subquestions.find((subquestion) => subquestion.id === "1");
    if (!q1Block || !q2Block || !q3Block || !targetSubquestion) {
      throw new Error("真实记录缺少三段大题链路回放所需的评分小问或 OCR 区块");
    }
    const expectedAnswer = [targetSubquestion.finalAnswers[0]?.expression, targetSubquestion.finalAnswers[0]?.unit]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(" ");
    const wrongAnswer = "v_1=\\frac{\\sqrt{10}}3 m/s";
    const blockBySubquestion = new Map([
      ["1", q1Block.blockId],
      ["2", q2Block.blockId],
      ["3", q3Block.blockId]
    ]);

    const triageResponse = {
      data: {
        answers: rubric.subquestions.map((subquestion) => ({
          subquestionId: subquestion.id,
          blockIds: [blockBySubquestion.get(subquestion.id) ?? q1Block.blockId],
          status: subquestion.id === "1" ? "incorrect" as const : "missing" as const,
          studentAnswer: subquestion.id === "1" ? wrongAnswer : "",
          confidence: subquestion.id === "1" ? 0.42 : 0.88,
          reason: subquestion.id === "1" ? "首轮把最终分式分母读成3，必须独立核对原图" : "首轮没有读到明确最终答案"
        })),
        transcription: {
          lines: usableBlocks.map((block) => ({
            blockId: block.blockId,
            text: "",
            latex: "",
            status: "uncertain" as const,
            confidence: 0,
            alternatives: []
          }))
        }
      },
      durationMs: 1,
      outputMode: "json_schema" as const
    };
    const localResponse = {
      data: {
        reviews: rubric.subquestions.map((subquestion) => ({
          review_id: "auto-final-answer-" + subquestion.id,
          result: subquestion.id === "1" ? expectedAnswer : "未写出最终答案",
          certainty: "clear" as const,
          reason: subquestion.id === "1" ? "原图局部确认分母为5" : "原图未见该小问明确最终答案"
        }))
      },
      durationMs: 1,
      outputMode: "json_schema" as const
    };
    const pointResponse = {
      data: {
        reviews: rubric.subquestions.map((subquestion) => ({
          subquestionId: subquestion.id,
          decisions: subquestion.scorePoints.map((point) => ({
            pointId: point.id,
            status: "not_present" as const,
            evidenceBlockIds: [],
            evidenceQuote: "",
            reason: "本次回放只验证新链路调用与最终答案权威，不伪造过程证据",
            confidence: 0.9
          })),
          appliedDeductions: []
        }))
      },
      durationMs: 1,
      outputMode: "json_schema" as const
    };
    vi.mocked(callStructured).mockImplementation(async (_config, request) => {
      const response = request.schemaName === "large_question_answer_triage"
        ? triageResponse
        : request.schemaName === "direct_visual_review"
          ? localResponse
          : request.schemaName === "large_question_point_review"
            ? pointResponse
            : (() => { throw new Error("unexpected schema " + request.schemaName); })();
      return {
        data: request.validate ? request.validate(response.data) : response.data,
        durationMs: response.durationMs,
        outputMode: response.outputMode
      };
    });

    const questionImages = Array.isArray(template.questionImages)
      ? await Promise.all(template.questionImages.map((image, index) => toModelImage(image, templateId, "[题目图片 " + (index + 1) + "]")))
      : [];
    const referenceImages = Array.isArray(template.referenceImages)
      ? await Promise.all(template.referenceImages.map((image, index) => toModelImage(image, templateId, "[参考答案图片 " + (index + 1) + "]")))
      : [];
    const replayConfig = {
      name: "record-backed-staged-contract",
      baseUrl: "https://model.contract.test/v1",
      apiKey: "contract-teacher-key",
      visionModel: "contract-teacher",
      textModel: "contract-text",
      reviewBaseUrl: "https://review.contract.test/v1",
      reviewApiKey: "contract-review-key",
      reviewModel: "contract-review",
      timeoutMs: 1_000,
      maxRetries: 0,
      maxConcurrency: 1,
      maxOutputTokens: 8_192,
      unreadableReviewThreshold: 3,
      gradingMode: "vision_direct" as const,
      supportsJsonSchema: true,
      supportsJsonObject: true,
      supportsBase64Images: true,
      enabled: true
    };
    const { result } = await gradeStudentAnswer(replayConfig, {
      id: "record-backed-staged-" + recordId,
      studentId: typeof storedResult?.studentId === "string" ? storedResult.studentId : recordId,
      fileName: asString(answerImage.fileName, "record.answerImage.fileName"),
      mimeType: asString(answerImage.mimeType, "record.answerImage.mimeType"),
      imageBuffer: answerBuffer,
      ocrAudit: replayAudit,
      rubric,
      questionText: typeof template.questionText === "string" ? template.questionText : "",
      referenceText: typeof template.referenceText === "string" ? template.referenceText : "",
      questionImages,
      referenceImages
    });

    expect(vi.mocked(runPaddleOcr)).not.toHaveBeenCalled();
    expect(vi.mocked(callStructured)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(callStructured).mock.calls.map((call) => call[1].schemaName).sort()).toEqual([
      "direct_visual_review",
      "large_question_answer_triage",
      "large_question_point_review"
    ].sort());
    expect(result.ocrAudit?.jobId).toBe(replayAudit.jobId);
    expect(result.ocrTranscription).toMatchObject({
      blockCount: usableBlocks.length,
      verifiedBlockCount: usableBlocks.length,
      missingBlockIds: []
    });
    expect(result.directVisualReviewAudit).toMatchObject({
      reviewRequired: true,
      finalScore: 3
    });
    expect(result.status).toBe("needs_review");
    expect(result.score).toBe(3);
    expect(result.subquestions.find((subquestion) => subquestion.id === "1")).toMatchObject({
      score: 3,
      maxScore: 3,
      finalAnswerStatus: "correct",
      finalAnswerDecisionSource: "visual_local_review",
      studentFinalAnswer: expectedAnswer
    });
    expect(result.subquestions.find((subquestion) => subquestion.id === "2")).toMatchObject({
      score: 0,
      finalAnswerStatus: "missing"
    });
    expect(result.subquestions.find((subquestion) => subquestion.id === "3")).toMatchObject({
      score: 0,
      finalAnswerStatus: "missing"
    });
    console.log("RECORD_BACKED_STAGED_SUMMARY", JSON.stringify({
      recordId,
      ocrBlocks: usableBlocks.length,
      verifiedBlocks: result.ocrTranscription?.verifiedBlockCount,
      modelCalls: vi.mocked(callStructured).mock.calls.length,
      score: result.score + "/" + result.maxScore,
      q1: result.subquestions.find((subquestion) => subquestion.id === "1")?.score,
      status: result.status
    }));
  }, 120_000);
});
