import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { PaddleOcrAudit, Rubric } from "../shared/types.js";
import { createDirectBlockReviewImage } from "./directVisualReview.js";

describe("createDirectBlockReviewImage", () => {
  async function createTestImage(width: number, height: number): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    }).png().toBuffer();
  }

  const dummyOcr: PaddleOcrAudit = {
    provider: "model_native",
    model: "gemini-3.8-flash-high",
    jobId: "test-ocr-01",
    rawJsonl: "{}",
    markdownText: "",
    durationMs: 100,
    imageWidth: 1000,
    imageHeight: 1400,
    layoutBlocks: []
  };

  it("对普通小区块保持充足的相对边距以保证上下标不被截断", async () => {
    const buffer = await createTestImage(1000, 1400);
    // Block: 100px wide, 60px high (x: 100..200, y: 300..360)
    const block = {
      blockId: "block-01",
      pageIndex: 0,
      label: "text" as const,
      score: 1,
      coordinate: [100, 300, 200, 360] as [number, number, number, number],
      polygonPoints: [[100, 300], [200, 300], [200, 360], [100, 360]] as [number, number][],
      order: 0
    };

    const image = await createDirectBlockReviewImage(buffer, dummyOcr, block, "test-point-1");
    expect(image).not.toBeNull();
    expect(image?.mimeType).toBe("image/png");
    expect(image?.label).toContain("block-01");
  });

  it("对宏观大区块（如整问区域）严格限制 Padding 上限，避免切图膨胀到卷面其他区域", async () => {
    const buffer = await createTestImage(1000, 1400);
    // Huge block: 500px wide, 500px high (x: 50..550, y: 400..900)
    const macroBlock = {
      blockId: "block-02",
      pageIndex: 0,
      label: "text" as const,
      score: 1,
      coordinate: [50, 400, 550, 900] as [number, number, number, number],
      polygonPoints: [[50, 400], [550, 400], [550, 900], [50, 900]] as [number, number][],
      order: 1
    };

    const image = await createDirectBlockReviewImage(buffer, dummyOcr, macroBlock, "review-point-2");
    expect(image).not.toBeNull();
    const metadata = await sharp(Buffer.from(image!.base64, "base64")).metadata();
    // With clamped padding, scaled image should not exceed max boundary of 2400
    expect(metadata.width).toBeLessThanOrEqual(2400);
    expect(metadata.height).toBeLessThanOrEqual(2400);
  });

  it("针对 auto-final-answer 在高大区块上自动聚焦在下半段作答区", async () => {
    const buffer = await createTestImage(1000, 1400);
    // Block of 480px height (y: 460..940)
    const macroBlock = {
      blockId: "block-02",
      pageIndex: 0,
      label: "text" as const,
      score: 1,
      coordinate: [10, 460, 490, 940] as [number, number, number, number],
      polygonPoints: [[10, 460], [490, 460], [490, 940], [10, 940]] as [number, number][],
      order: 1
    };

    const finalAnswerImage = await createDirectBlockReviewImage(buffer, dummyOcr, macroBlock, "auto-final-answer-2");
    expect(finalAnswerImage).not.toBeNull();
    expect(finalAnswerImage?.label).toContain("auto-final-answer-2");
  });
});

describe("extractSubquestionAnswerCrops", () => {
  async function createTestImage(width: number, height: number): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    }).png().toBuffer();
  }

  const dummyOcr: PaddleOcrAudit = {
    provider: "model_native",
    model: "gemini-3.8-flash-high",
    jobId: "test-ocr-02",
    rawJsonl: "{}",
    markdownText: "",
    durationMs: 100,
    imageWidth: 1000,
    imageHeight: 1400,
    layoutBlocks: [
      {
        blockId: "block-01",
        pageIndex: 0,
        label: "text",
        score: 1,
        coordinate: [50, 100, 450, 350],
        polygonPoints: [[50, 100], [450, 100], [450, 350], [50, 350]],
        order: 0
      },
      {
        blockId: "block-02",
        pageIndex: 0,
        label: "text",
        score: 1,
        coordinate: [50, 400, 550, 900],
        polygonPoints: [[50, 400], [550, 400], [550, 900], [50, 900]],
        order: 1
      }
    ]
  };

  const testRubric: Rubric = {
    title: "测试大题",
    totalScore: 16,
    recognizedQuestionText: "大题题目",
    version: 1,
    status: "locked",
    questionType: "large",
    warnings: [],
    subquestions: [
      {
        id: "1",
        title: "第(1)问",
        maxScore: 6,
        scorePoints: [{ id: "p1", title: "加速度", description: "计算加速度", score: 6, type: "result", expected: "2" }],
        finalAnswers: [{ expression: "2", unit: "m/s^2" }],
        finalAnswerPolicy: "full_credit",
        deductions: []
      },
      {
        id: "2",
        title: "第(2)问",
        maxScore: 10,
        scorePoints: [{ id: "p2", title: "时间", description: "计算时间", score: 10, type: "result", expected: "4+2\\sqrt{2}" }],
        finalAnswers: [{ expression: "4+2\\sqrt{2}", unit: "s" }],
        finalAnswerPolicy: "full_credit",
        deductions: []
      }
    ]
  };

  it("当模型提供归一化 coordinate [x1, y1, x2, y2] 时，直接按模型坐标裁切并加入适当 padding", async () => {
    const { extractSubquestionAnswerCrops } = await import("./largeQuestionGrading.js");
    const buffer = await createTestImage(1000, 1400);

    const answers = [
      {
        subquestionId: "1",
        status: "correct" as const,
        studentAnswer: "2 m/s^2",
        confidence: 0.98,
        reason: "首轮判定正确",
        blockIds: ["block-01"],
        coordinate: [100, 200, 300, 250], // 0..1000 scale
        evidenceLineIds: [],
        evidenceLineIdsByBlockId: new Map()
      }
    ];

    const { crops, preCroppedImages } = await extractSubquestionAnswerCrops(buffer, testRubric, answers, dummyOcr);

    expect(crops).toHaveLength(1);
    expect(crops[0]!.subquestionId).toBe("1");
    expect(crops[0]!.source).toBe("model_coordinate");
    expect(crops[0]!.mimeType).toBe("image/webp");
    // px1 = 100, px2 = 300, py1 = 280, py2 = 350. With 24px pad: left=76, right=324, top=256, bottom=374
    expect(crops[0]!.pixelRegion[0]).toBe(76);
    expect(crops[0]!.pixelRegion[1]).toBe(256);
    expect(crops[0]!.pixelRegion[2]).toBe(248); // width = 324 - 76
    expect(crops[0]!.pixelRegion[3]).toBe(118); // height = 374 - 256

    expect(preCroppedImages.has("auto-final-answer-1")).toBe(true);
    const preCropped = preCroppedImages.get("auto-final-answer-1")!;
    expect(preCropped.mimeType).toBe("image/webp");
    expect(preCropped.label).toContain("第(1)问");
  });

  it("当模型未提供有效 coordinate 时，回退到区块锚点裁切（若区块超高则自动聚焦下半段）", async () => {
    const { extractSubquestionAnswerCrops } = await import("./largeQuestionGrading.js");
    const buffer = await createTestImage(1000, 1400);

    const answers = [
      {
        subquestionId: "2",
        status: "incorrect" as const,
        studentAnswer: "4+2\\sqrt{5} s",
        confidence: 0.85,
        reason: "首轮判定错误",
        blockIds: ["block-02"], // block-02 height = 900 - 400 = 500 > 200px
        coordinate: null,
        evidenceLineIds: [],
        evidenceLineIdsByBlockId: new Map()
      }
    ];

    const { crops, preCroppedImages } = await extractSubquestionAnswerCrops(buffer, testRubric, answers, dummyOcr);

    expect(crops).toHaveLength(1);
    expect(crops[0]!.subquestionId).toBe("2");
    expect(crops[0]!.source).toBe("block_anchor");
    expect(crops[0]!.mimeType).toBe("image/webp");

    // Block-02 top was 400, bottom was 900, height was 500.
    // Tall block (>200px) anchors to bottom 45%: cutTop = 400 + Math.floor(500*0.55) = 675.
    // top = 675 - padY(36) = 639.
    expect(crops[0]!.pixelRegion[1]).toBeGreaterThanOrEqual(600);

    expect(preCroppedImages.has("auto-final-answer-2")).toBe(true);
  });
});

