import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PaddleOcrAudit, Rubric } from "../shared/types.js";

vi.mock("./paddleOcr.js", async () => {
  const actual = await vi.importActual<typeof import("./paddleOcr.js")>("./paddleOcr.js");
  return { ...actual, runPaddleOcr: vi.fn() };
});

import { extractPaddleOcrLayoutMetadata, runPaddleOcr } from "./paddleOcr.js";
import { readModelConfig } from "./configStore.js";
import { loadCachedPaddleOcrAudit } from "./largeQuestionReplay.js";
import { rubricSchema } from "./schemas.js";
import { gradeStudentAnswer } from "./workflows.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 不是对象`);
  }
  return value as JsonRecord;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 缺少有效字符串`);
  return value;
}

async function readJson(filePath: string): Promise<JsonRecord> {
  return asRecord(JSON.parse(await readFile(filePath, "utf8")) as unknown, filePath);
}

async function loadLatestLargeRecord() {
  const history = await readJson(path.resolve(".data/history.json"));
  const templates = Array.isArray(history.templates) ? history.templates.map((item) => asRecord(item, "history.templates[]")) : [];
  const candidates: Array<{ template: JsonRecord; record: JsonRecord; rubric: Rubric }> = [];

  for (const template of templates) {
    if (template.builtIn === true) continue;
    const records = Array.isArray(template.records) ? template.records : [];
    for (const recordValue of records) {
      const record = asRecord(recordValue, "history.templates[].records[]");
      const rubricValue = record.rubricSnapshot ?? template.rubric;
      let rubric: Rubric;
      try {
        rubric = rubricSchema.parse(rubricValue);
      } catch {
        continue;
      }
      if ((rubric.questionType ?? "large") !== "large") continue;
      candidates.push({ template, record, rubric });
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
  return {
    mimeType: asString(file.mimeType, "history image.mimeType"),
    base64: buffer.toString("base64"),
    label
  };
}

describe("cached large-question OCR replay", () => {
  it("marks a saved OCR audit as replay data and rebuilds bbox metadata", async () => {
    const rawJsonl = JSON.stringify({
      result: {
        dataInfo: { width: 80, height: 60 },
        layoutParsingResults: [{
          markdown: { text: "x=2" },
          prunedResult: { layout_det_res: { boxes: [{ label: "display_formula", score: 0.9, coordinate: [5, 6, 30, 20], order: 0 }] } }
        }]
      }
    }) + "\n";
    const audit = await loadCachedPaddleOcrAudit({
      provider: "paddleocr",
      model: "PaddleOCR-VL-1.6",
      jobId: "live-job",
      rawJsonl,
      markdownText: "x=2",
      durationMs: 10
    });

    expect(audit).toMatchObject({ source: "cached_replay", jobId: "live-job", imageWidth: 80, imageHeight: 60 });
    expect(audit.rawJsonl).toBe(rawJsonl);
    expect(audit.layoutBlocks).toEqual([expect.objectContaining({ blockId: "block-00", label: "display_formula", coordinate: [5, 6, 30, 20] })]);
  });
});

describe("large-question real-record replay", () => {
  if (process.env.HENGZHUN_RUN_REAL_LARGE_REPLAY !== "1") {
    it.skip("设置 HENGZHUN_RUN_REAL_LARGE_REPLAY=1 后执行最近真实大题记录重放", () => undefined);
    return;
  }

  it("replays cached PaddleOCR through the complete large-question grading chain", async () => {
    const { template, record, rubric } = await loadLatestLargeRecord();
    const templateId = asString(template.id, "template.id");
    const recordId = asString(record.id, "record.id");
    const answerImage = asRecord(record.answerImage, "record.answerImage");
    const answerDiskName = asString(answerImage.diskName, "record.answerImage.diskName");
    const answerBuffer = await readFile(path.resolve(".data/history-assets", templateId, answerDiskName));

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
    const markdownText = asString(cachedOcr.markdownText, "cached OCR markdownText");
    const metadata = extractPaddleOcrLayoutMetadata(rawJsonl);
    const replayAudit: PaddleOcrAudit = {
      provider: "paddleocr",
      model: asString(cachedOcr.model, "cached OCR model"),
      jobId: asString(cachedOcr.jobId, "cached OCR jobId"),
      rawJsonl,
      markdownText,
      durationMs: typeof cachedOcr.durationMs === "number" ? cachedOcr.durationMs : 0,
      ...metadata
    };

    const config = await readModelConfig();
    if (!config?.enabled || !config.apiKey) throw new Error("当前本地模型配置不可用，无法执行真实记录重放");
    const questionImages = Array.isArray(template.questionImages)
      ? await Promise.all(template.questionImages.map((image, index) => toModelImage(image, templateId, `[题目图片 ${index + 1}]`)))
      : [];
    const referenceImages = Array.isArray(template.referenceImages)
      ? await Promise.all(template.referenceImages.map((image, index) => toModelImage(image, templateId, `[参考答案图片 ${index + 1}]`)))
      : [];

    const { result } = await gradeStudentAnswer(config, {
      id: crypto.randomUUID(),
      studentId: `真实记录重放-${recordId.slice(0, 8)}`,
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

    const decisions = result.subquestions.flatMap((subquestion) => subquestion.decisions.map((decision) => ({
      pointKey: `${subquestion.id}:${decision.pointId}`,
      status: decision.status,
      awardedScore: decision.awardedScore,
      scoringDisposition: decision.scoringDisposition,
      decisionSource: decision.decisionSource,
      requiresReview: decision.requiresReview,
      reason: decision.reason,
      evidenceLineIds: decision.evidenceLineIds
    })));
    const reviewAudit = result.directVisualReviewAudit;
    const labelCounts = (result.ocrAudit?.layoutBlocks ?? []).reduce<Record<string, number>>((counts, block) => {
      counts[block.label] = (counts[block.label] ?? 0) + 1;
      return counts;
    }, {});
    console.log("REAL_LARGE_REPLAY_SUMMARY", JSON.stringify({
      recordId,
      templateId,
      score: result.score,
      maxScore: result.maxScore,
      status: result.status,
      gradingPipeline: result.gradingPipeline,
      ocr: {
        jobId: result.ocrAudit?.jobId,
        imageWidth: result.ocrAudit?.imageWidth,
        imageHeight: result.ocrAudit?.imageHeight,
        blockCount: result.ocrAudit?.layoutBlocks?.length ?? 0,
        labelCounts
      },
      transcription: result.ocrTranscription ? {
        blockCount: result.ocrTranscription.blockCount,
        verifiedBlockCount: result.ocrTranscription.verifiedBlockCount,
        missingBlockIds: result.ocrTranscription.missingBlockIds,
        lines: result.ocrTranscription.lines.map((line) => ({
          id: line.id,
          blockId: line.blockId,
          text: line.text,
          latex: line.latex,
          status: line.status,
          confidence: line.confidence
        }))
      } : null,
      review: reviewAudit ? {
        reviewRequired: reviewAudit.reviewRequired,
        itemCount: reviewAudit.reviewItems.length,
        resultCount: reviewAudit.results.length,
        initialScore: reviewAudit.initialScore,
        finalScore: reviewAudit.finalScore,
        items: reviewAudit.reviewItems.map((item) => ({
          reviewId: item.reviewId,
          blockId: item.blockId,
          criterionId: item.criterionId,
          recognized: item.recognized,
          candidates: item.candidates,
          scoreEffect: item.scoreEffect
        })),
        results: reviewAudit.results.map((item) => ({
          reviewId: item.reviewId,
          result: item.result,
          certainty: item.certainty,
          reason: item.reason
        }))
      } : null,
      decisions,
      evidenceLines: result.evidence.lines.map((line) => ({
        id: line.id,
        text: line.text,
        latex: line.latex,
        status: line.status,
        confidence: line.confidence
      })),
      finalAnswers: result.subquestions.map((subquestion) => ({ id: subquestion.id, status: subquestion.finalAnswerStatus, reason: subquestion.finalAnswerReason }))
    }));

    expect(result.gradingPipeline).toBe("large_question");
    expect(runPaddleOcr).not.toHaveBeenCalled();
    expect(result.maxScore).toBe(rubric.totalScore);
    expect(result.ocrAudit?.jobId).toBe(replayAudit.jobId);
    expect(result.ocrAudit?.layoutBlocks?.length).toBeGreaterThan(0);
    expect(result.ocrTranscription).toBeDefined();
    expect(result.ocrTranscription?.verifiedBlockCount).toBeLessThanOrEqual(result.ocrTranscription?.blockCount ?? -1);
    expect(result.ocrTranscription?.lines).toHaveLength(result.ocrTranscription?.verifiedBlockCount ?? -1);
    expect(reviewAudit).toBeDefined();
    expect(reviewAudit?.initialScore).toBeGreaterThanOrEqual(0);
    expect(reviewAudit?.finalScore).toBe(result.score);
    expect(result.subquestions.find((subquestion) => subquestion.id === "1")).toMatchObject({
      score: 3,
      maxScore: 3,
      finalAnswerStatus: "correct",
      finalAnswerDecisionSource: "visual_local_review"
    });
  }, 600_000);
});
