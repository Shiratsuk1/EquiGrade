import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Rubric } from "../shared/types.js";
import { computeSafeCropBox } from "./smallQuestionGrading.js";
import { requireModelConfig } from "./configStore.js";
import { gradeStudentAnswer } from "./workflows.js";

const FIXTURE_IMAGE_PATH = path.resolve(
  ".data/history-assets/211deccf-3d0f-4d64-8e30-01ca83e560c9/answer-a35742d1-ddea-4057-9810-3e5580acd024.png"
);

const fixtureAvailable = existsSync(FIXTURE_IMAGE_PATH);

describe("zhixue:69220964 真实答卷切片与端到端 E2E 测试", () => {
  it.skipIf(!fixtureAvailable)("切片几何防御性校验：验证扁平横条答卷(高度89px)各空切片纵向全高保留且不截断", async () => {
    const buffer = await readFile(FIXTURE_IMAGE_PATH);
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(990);
    expect(meta.height).toBe(89);

    const width = meta.width!;
    const height = meta.height!;

    // 历史记录中第 (1) 空定位 coordinate: [193, 148, 308, 332]
    // 之前因纵向只切 46px 导致下半截字符缺失报错“视野受限/严重截断”
    const crop1 = computeSafeCropBox([193, 148, 308, 332], width, height);
    expect(crop1.top).toBe(0);
    expect(crop1.height).toBe(89); // 纵向全高保留
    expect(crop1.left).toBeLessThanOrEqual(160);
    expect(crop1.left + crop1.width).toBeGreaterThanOrEqual(330);

    const crop1Buffer = await sharp(buffer)
      .extract({ left: crop1.left, top: crop1.top, width: crop1.width, height: crop1.height })
      .webp({ quality: 95 })
      .toBuffer();
    const crop1Meta = await sharp(crop1Buffer).metadata();
    expect(crop1Meta.width).toBe(crop1.width);
    expect(crop1Meta.height).toBe(89);

    // 第 (2) 空定位 coordinate: [447, 161, 526, 329]
    const crop2 = computeSafeCropBox([447, 161, 526, 329], width, height);
    expect(crop2.top).toBe(0);
    expect(crop2.height).toBe(89);

    // 第 (3) 空定位 coordinate: [777, 150, 832, 351]
    const crop3 = computeSafeCropBox([777, 150, 832, 351], width, height);
    expect(crop3.top).toBe(0);
    expect(crop3.height).toBe(89);
  });

  it.skipIf(!fixtureAvailable)("真实模型端到端 E2E 批改：验证切片正常传入模型且第(1)问不截断、能正确判定作答", async () => {
    let config;
    try {
      config = await requireModelConfig();
    } catch (e) {
      console.warn("未能读取模型配置，跳过真实模型外呼 E2E 测试:", e);
      return;
    }

    const imageBuffer = await readFile(FIXTURE_IMAGE_PATH);

    const rubric: Rubric = {
      title: "第13题 实验题",
      recognizedQuestionText: "略",
      version: 2,
      status: "saved",
      questionType: "small",
      totalScore: 6,
      warnings: [],
      subquestions: [
        {
          id: "1",
          title: "(1)",
          maxScore: 2,
          finalAnswerPolicy: "full_credit",
          finalAnswers: [
            {
              expression: "C",
              unit: "",
              label: "(1)",
              signPolicy: "unspecified",
              positiveDirection: "",
              subject: "",
              signConvention: ""
            }
          ],
          scorePoints: [
            {
              id: "1-1",
              title: "第(1)问答案",
              description: "选填 C",
              score: 2,
              type: "result",
              expected: "C",
              commonResponses: ["C"],
              alternativeMethods: [],
              acceptedEquivalents: []
            }
          ],
          deductions: []
        },
        {
          id: "2",
          title: "(2)",
          maxScore: 2,
          finalAnswerPolicy: "full_credit",
          finalAnswers: [
            {
              expression: "2.4",
              unit: "",
              label: "(2)",
              signPolicy: "unspecified",
              positiveDirection: "",
              subject: "",
              signConvention: ""
            }
          ],
          scorePoints: [
            {
              id: "2-1",
              title: "第(2)问答案",
              description: "填入 2.4。必须严格保留两位有效数字。",
              score: 2,
              type: "result",
              expected: "2.4",
              commonResponses: ["2.4"],
              alternativeMethods: [],
              acceptedEquivalents: []
            }
          ],
          deductions: []
        },
        {
          id: "3",
          title: "(3)",
          maxScore: 2,
          finalAnswerPolicy: "full_credit",
          finalAnswers: [
            {
              expression: "B",
              unit: "",
              label: "(3)",
              signPolicy: "unspecified",
              positiveDirection: "",
              subject: "",
              signConvention: ""
            }
          ],
          scorePoints: [
            {
              id: "3-1",
              title: "第(3)问答案",
              description: "选填 B",
              score: 2,
              type: "result",
              expected: "B",
              commonResponses: ["B"],
              alternativeMethods: [],
              acceptedEquivalents: []
            }
          ],
          deductions: []
        }
      ]
    };

    const startTime = Date.now();
    let gradeRes;
    try {
      gradeRes = await gradeStudentAnswer(config, {
        id: "e2e-test-zhixue-69220964",
        studentId: "网页答卷 zhixue:69220964",
        fileName: "answer-a35742d1-ddea-4057-9810-3e5580acd024.png",
        mimeType: "image/png",
        imageBuffer,
        rubric,
        questionText: "略"
      });
    } catch (err: any) {
      if (err?.message?.includes("fetch failed") || err?.message?.includes("ENOTFOUND") || err?.message?.includes("ECONNREFUSED")) {
        console.warn("无法连接模型在线 API 端点，跳过真实外呼测试:", err.message);
        return;
      }
      throw err;
    }
    const durationMs = Date.now() - startTime;
    const { result } = gradeRes;

    console.log("E2E_GRADING_RESULT_SUMMARY", JSON.stringify({
      score: `${result.score}/${result.maxScore}`,
      status: result.status,
      durationMs,
      reviewReasons: result.reviewReasons,
      subquestions: result.subquestions?.map(sq => ({
        id: sq.id,
        score: sq.score
      })),
      crops: result.smallQuestionAudit?.crops?.map(c => ({
        subquestionId: c.subquestionId,
        cropWidth: c.cropWidth,
        cropHeight: c.cropHeight
      })),
      recognitions: result.smallQuestionAudit?.recognitions
    }, null, 2));

    // 1. 验证切片全高保护机制在端到端运行中生效：切片高度等于图像原始高度 89
    const crops = result.smallQuestionAudit?.crops ?? [];
    expect(crops.length).toBeGreaterThan(0);
    for (const crop of crops) {
      if (crop.hasAnswer) {
        expect(crop.cropHeight).toBe(89);
      }
    }

    // 2. 验证不会再因为“切片打歪/下半部分缺失/视野残缺”而误报截断错误
    const reviewReasonsStr = result.reviewReasons.join("; ");
    expect(reviewReasonsStr).not.toMatch(/截断|残缺|视野受限/);

    // 3. 验证得分与小问判定：三个小问应全部判定为 correct 并得到满分 6 分
    expect(result.score).toBe(6);
    expect(result.maxScore).toBe(6);
  }, 90000); // 预留 90 秒供多阶段模型调用
});
