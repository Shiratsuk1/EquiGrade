import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ModelConfigInput, Rubric } from "../shared/types.js";
import { gradeSmallQuestionStaged } from "./smallQuestionGrading.js";
import { callStructured } from "./modelClient.js";

vi.mock("./modelClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./modelClient.js")>();
  return {
    ...actual,
    callStructured: vi.fn()
  };
});

describe("server/smallQuestionGrading", () => {
  const dummyConfig: ModelConfigInput = {
    name: "Test Config",
    baseUrl: "https://api.test.com/v1",
    apiKey: "test-key",
    visionModel: "test-flash",
    textModel: "test-flash",
    reviewModel: "test-pro",
    timeoutMs: 30000,
    maxRetries: 1,
    maxConcurrency: 5,
    maxOutputTokens: 4096,
    unreadableReviewThreshold: 20,
    gradingMode: "vision_direct",
    largeQuestionWorkflow: "staged",
    stagedLayoutEngine: "model_native",
    teacherReasoningEffort: "medium",
    reviewReasoningEffort: "high",
    supportsJsonSchema: true,
    supportsJsonObject: true,
    supportsBase64Images: true,
    enabled: true
  };

  const rubric: Rubric = {
    title: "小题测试",
    recognizedQuestionText: "小题",
    status: "locked",
    warnings: [],
    questionType: "small",
    totalScore: 6,
    version: 1,
    subquestions: [
      {
        id: "sq-1",
        title: "第(1)空",
        maxScore: 2,
        finalAnswerPolicy: "full_credit",
        finalAnswers: [{ expression: "3.80" }],
        scorePoints: [],
        deductions: []
      },
      {
        id: "sq-2",
        title: "第(2)空",
        maxScore: 2,
        finalAnswerPolicy: "full_credit",
        finalAnswers: [{ expression: "A" }],
        scorePoints: [],
        deductions: []
      },
      {
        id: "sq-3",
        title: "第(3)空",
        maxScore: 2,
        finalAnswerPolicy: "full_credit",
        finalAnswers: [{ expression: "甲" }],
        scorePoints: [],
        deductions: []
      }
    ]
  };

  const dummyImage = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );

  const prepared = {
    preparation: {
      buffer: dummyImage,
      mimeType: "image/png",
      audit: {
        provider: "local",
        mode: "original",
        applied: false,
        inputMimeType: "image/png",
        outputMimeType: "image/png",
        inputBytes: dummyImage.length,
        outputBytes: dummyImage.length,
        geometryPreserved: true,
        sourceWidth: 100,
        sourceHeight: 100,
        processedWidth: 100,
        processedHeight: 100,
        stepDurations: []
      } as any
    },
    studentImage: { mimeType: "image/png", base64: dummyImage.toString("base64") },
    modelImages: [{ mimeType: "image/png", base64: dummyImage.toString("base64") }]
  };

  const input = {
    id: "record-1",
    studentId: "student-1",
    fileName: "ans.png",
    mimeType: "image/png",
    imageBuffer: dummyImage,
    rubric
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("triggers all-correct fast-path when dual recognitions (Blind A & Skeptic B) reach consensus", async () => {
    // 1. 定位返回 3 个空
    vi.mocked(callStructured)
      .mockResolvedValueOnce({
        data: {
          blanks: [
            { subquestionId: "sq-1", coordinate: [100, 200, 300, 400], hasAnswer: true },
            { subquestionId: "sq-2", coordinate: [400, 200, 500, 400], hasAnswer: true },
            { subquestionId: "sq-3", coordinate: [700, 200, 800, 400], hasAnswer: true }
          ]
        },
        durationMs: 100
      } as any)
      // sq-1 A & B
      .mockResolvedValueOnce({
        data: { extractedAnswer: "3.80", confidence: 0.98, visualNotes: "清晰数字" },
        durationMs: 50
      } as any)
      .mockResolvedValueOnce({
        data: { extractedAnswer: "3.80", status: "correct", confidence: 0.99, issues: [], reason: "符合3.80" },
        durationMs: 50
      } as any)
      // sq-2 A & B
      .mockResolvedValueOnce({
        data: { extractedAnswer: "A", confidence: 1.0, visualNotes: "大写字母A" },
        durationMs: 50
      } as any)
      .mockResolvedValueOnce({
        data: { extractedAnswer: "A", status: "correct", confidence: 1.0, issues: [], reason: "符合A" },
        durationMs: 50
      } as any)
      // sq-3 A & B
      .mockResolvedValueOnce({
        data: { extractedAnswer: "甲", confidence: 0.95, visualNotes: "汉字甲" },
        durationMs: 50
      } as any)
      .mockResolvedValueOnce({
        data: { extractedAnswer: "甲", status: "correct", confidence: 0.98, issues: [], reason: "符合甲" },
        durationMs: 50
      } as any);

    const result = await gradeSmallQuestionStaged(dummyConfig, input, "op-1", prepared);

    expect(result.score).toBe(6);
    expect(result.maxScore).toBe(6);
    expect(result.status).toBe("completed");
    expect(result.gradingPipeline).toBe("small_question_staged");
    expect(result.smallQuestionAudit?.recognitions.every((r) => r.comparisonStatus === "consensus")).toBe(true);
    expect(result.smallQuestionAudit?.recognitions.every((r) => r.decisionSource === "consensus_ab")).toBe(true);
    expect(result.teacherCommentary).toBeDefined();
  });

  it("handles blank missing without model calls and grants 0 for that blank", async () => {
    // 定位返回第(1)空有手写，第(2)、(3)空空白未作答
    vi.mocked(callStructured)
      .mockResolvedValueOnce({
        data: {
          blanks: [
            { subquestionId: "sq-1", coordinate: [100, 200, 300, 400], hasAnswer: true },
            { subquestionId: "sq-2", coordinate: null, hasAnswer: false },
            { subquestionId: "sq-3", coordinate: null, hasAnswer: false }
          ]
        },
        durationMs: 100
      } as any)
      // sq-1 A & B
      .mockResolvedValueOnce({
        data: { extractedAnswer: "3.80", confidence: 0.98, visualNotes: "" },
        durationMs: 50
      } as any)
      .mockResolvedValueOnce({
        data: { extractedAnswer: "3.80", status: "correct", confidence: 0.98, issues: [], reason: "正确" },
        durationMs: 50
      } as any);

    const result = await gradeSmallQuestionStaged(dummyConfig, input, "op-2", prepared);

    expect(result.score).toBe(2);
    expect(result.maxScore).toBe(6);
    expect(result.subquestions.find((s) => s.id === "sq-1")?.finalAnswerStatus).toBe("correct");
    expect(result.subquestions.find((s) => s.id === "sq-2")?.finalAnswerStatus).toBe("missing");
    expect(result.subquestions.find((s) => s.id === "sq-3")?.finalAnswerStatus).toBe("missing");
    expect(result.smallQuestionAudit?.crops.filter((c) => !c.hasAnswer).length).toBe(2);
  });

  it("escalates to Request C with high reasoning when Blind A and Skeptic B have discrepancy", async () => {
    // 单空测试
    const singleRubric: Rubric = {
      ...rubric,
      subquestions: [rubric.subquestions[0]]
    };

    vi.mocked(callStructured)
      // 1. 定位
      .mockResolvedValueOnce({
        data: {
          blanks: [{ subquestionId: "sq-1", coordinate: [100, 200, 300, 400], hasAnswer: true }]
        },
        durationMs: 100
      } as any)
      // 2. 盲审 A 读出 "3.86"
      .mockResolvedValueOnce({
        data: { extractedAnswer: "3.86", confidence: 0.90, visualNotes: "末位似6" },
        durationMs: 50
      } as any)
      // 3. 挑刺 B 迎合答案读出 "3.80"，但指出有涂改疑点
      .mockResolvedValueOnce({
        data: { extractedAnswer: "3.80", status: "correct", confidence: 0.85, issues: ["末位数字有涂改加粗"], reason: "基本符合" },
        durationMs: 50
      } as any)
      // 4. 分歧触发 C 级终审 (High Reasoning Effort)
      .mockResolvedValueOnce({
        data: {
          finalExtractedAnswer: "3.86",
          status: "incorrect",
          confidence: 0.97,
          visualAnalysis: "末位数字为清晰带有右上起笔向左下内勾的6，不是闭合的0",
          resolutionReason: "微观分析确认学生书写为3.86，不符合参考答案3.80"
        },
        durationMs: 120
      } as any);

    const result = await gradeSmallQuestionStaged(dummyConfig, { ...input, rubric: singleRubric }, "op-3", prepared);

    expect(result.score).toBe(0);
    expect(result.subquestions[0].finalAnswerStatus).toBe("incorrect");
    expect(result.subquestions[0].studentFinalAnswer).toBe("3.86");
    const rec = result.smallQuestionAudit?.recognitions[0];
    expect(rec?.comparisonStatus).toBe("discrepancy");
    expect(rec?.decisionSource).toBe("escalated_review_c");
    expect(rec?.escalatedReview?.finalExtractedAnswer).toBe("3.86");
  });

  it("accurately classifies blank semantic domains via detectBlankDomain", async () => {
    const { detectBlankDomain } = await import("./smallQuestionGrading.js");
    expect(detectBlankDomain([{ expression: "A" }])).toBe("choice_letter");
    expect(detectBlankDomain([{ expression: "B" }, { expression: "C" }])).toBe("choice_letter");
    expect(detectBlankDomain([{ expression: "3.80" }])).toBe("numeric");
    expect(detectBlankDomain([{ expression: "-2.5" }])).toBe("numeric");
    expect(detectBlankDomain([{ expression: "1.2*10^3" }])).toBe("numeric");
    expect(detectBlankDomain([{ expression: "甲" }])).toBe("chinese_text");
    expect(detectBlankDomain([{ expression: "增大" }])).toBe("chinese_text");
    expect(detectBlankDomain([{ expression: "\\frac{U}{I}" }])).toBe("formula");
    expect(detectBlankDomain([{ expression: "mg/k" }])).toBe("formula");
    expect(detectBlankDomain([{ expression: "R_1" }])).toBe("formula");
    expect(detectBlankDomain([{ expression: "\\sqrt{2gh}" }])).toBe("formula");
  });

  it("handles physics literal algebraic formula correctly with consensus", async () => {
    const formulaRubric: Rubric = {
      ...rubric,
      totalScore: 3,
      subquestions: [
        {
          id: "sq-formula",
          title: "第(1)空 表达式",
          maxScore: 3,
          finalAnswerPolicy: "full_credit",
          finalAnswers: [{ expression: "\\frac{U}{I}" }],
          scorePoints: [{ id: "p1", title: "公式", description: "欧姆定律表达式", score: 3, type: "formula", expected: "\\frac{U}{I}" }],
          deductions: []
        }
      ]
    };

    vi.mocked(callStructured)
      .mockResolvedValueOnce({
        data: {
          blanks: [{ subquestionId: "sq-formula", coordinate: [100, 200, 300, 400], hasAnswer: true }]
        },
        durationMs: 100
      } as any)
      .mockResolvedValueOnce({
        data: { extractedAnswer: "\\frac{U}{I}", confidence: 0.95, visualNotes: "分式形式 U 比 I" },
        durationMs: 50
      } as any)
      .mockResolvedValueOnce({
        data: { extractedAnswer: "\\frac{U}{I}", status: "correct", confidence: 0.98, issues: [], reason: "符合参考答案" },
        durationMs: 50
      } as any);

    const result = await gradeSmallQuestionStaged(dummyConfig, { ...input, rubric: formulaRubric }, "op-formula", prepared);

    expect(result.score).toBe(3);
    expect(result.maxScore).toBe(3);
    expect(result.subquestions[0].finalAnswerStatus).toBe("correct");
    expect(result.subquestions[0].studentFinalAnswer).toBe("\\frac{U}{I}");
  });
});
