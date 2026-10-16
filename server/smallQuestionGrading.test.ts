import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ModelConfigInput, Rubric } from "../shared/types.js";
import {
  gradeSmallQuestionStaged,
  computeSafeCropBox,
  buildBlankLayoutContextMap,
  detectInitialVsSkepticDiscrepancy,
  checkThreeWayConsensus
} from "./smallQuestionGrading.js";
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

  it("triggers blank fast-pass (0 points) in a single model call when paper is empty", async () => {
    vi.mocked(callStructured).mockResolvedValueOnce({
      data: {
        isEntirelyBlank: true,
        blanks: [
          { subquestionId: "sq-1", coordinate: null, hasAnswer: false, status: "missing" },
          { subquestionId: "sq-2", coordinate: null, hasAnswer: false, status: "missing" },
          { subquestionId: "sq-3", coordinate: null, hasAnswer: false, status: "missing" }
        ]
      },
      durationMs: 40
    } as any);

    const result = await gradeSmallQuestionStaged(dummyConfig, input, "op-blank-fast", prepared);

    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(result.score).toBe(0);
    expect(result.maxScore).toBe(6);
    expect(result.status).toBe("completed");
    expect(result.subquestions.every((sq) => sq.finalAnswerStatus === "missing")).toBe(true);
    expect(result.smallQuestionAudit?.recognitions.every((r) => r.finalStatus === "missing")).toBe(true);
  });

  it("triggers full-credit fast-pass (6/6 points) in a single model call when all blanks pass triage and local guardrails", async () => {
    vi.mocked(callStructured).mockResolvedValueOnce({
      data: {
        isEntirelyBlank: false,
        blanks: [
          {
            subquestionId: "sq-1",
            coordinate: [100, 200, 300, 400],
            hasAnswer: true,
            extractedAnswer: "3.80",
            status: "correct",
            confidence: 0.98,
            issues: [],
            reason: "手写3.80清晰保留两位小数"
          },
          {
            subquestionId: "sq-2",
            coordinate: [400, 200, 500, 400],
            hasAnswer: true,
            extractedAnswer: "A",
            status: "correct",
            confidence: 0.99,
            issues: [],
            reason: "选项A清晰"
          },
          {
            subquestionId: "sq-3",
            coordinate: [700, 200, 800, 400],
            hasAnswer: true,
            extractedAnswer: "甲",
            status: "correct",
            confidence: 0.96,
            issues: [],
            reason: "汉字甲"
          }
        ]
      },
      durationMs: 80
    } as any);

    const result = await gradeSmallQuestionStaged(dummyConfig, input, "op-full-fast", prepared);

    // 仅调用了 1 次全景初检定位模型，直接秒级放行！
    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(result.score).toBe(6);
    expect(result.maxScore).toBe(6);
    expect(result.status).toBe("completed");
    expect(result.subquestions.every((sq) => sq.finalAnswerStatus === "correct")).toBe(true);
    // Sharp 本地切图审计证据完整生成
    expect(result.smallQuestionAudit?.crops.length).toBe(3);
    expect(result.smallQuestionAudit?.crops.every((c) => c.hasAnswer && c.artifactFileName)).toBe(true);
  });

  it("targets slicing and deep review only for problematic blanks while clean blanks bypass downstream calls", async () => {
    // 场景：第(1)空和第(3)空初检清晰正确，第(2)空因草写A被初检判定为存疑(issues存在)
    vi.mocked(callStructured)
      // 1. 全景初检
      .mockResolvedValueOnce({
        data: {
          isEntirelyBlank: false,
          blanks: [
            {
              subquestionId: "sq-1",
              coordinate: [100, 200, 300, 400],
              hasAnswer: true,
              extractedAnswer: "3.80",
              status: "correct",
              confidence: 0.98,
              issues: [],
              reason: "3.80正确"
            },
            {
              subquestionId: "sq-2",
              coordinate: [400, 200, 500, 400],
              hasAnswer: true,
              extractedAnswer: "B",
              status: "uncertain", // 未达到直接放行门禁
              confidence: 0.80,
              issues: ["字迹潦草疑似A但形似B"],
              reason: "需局部精检"
            },
            {
              subquestionId: "sq-3",
              coordinate: [700, 200, 800, 400],
              hasAnswer: true,
              extractedAnswer: "甲",
              status: "correct",
              confidence: 0.95,
              issues: [],
              reason: "甲正确"
            }
          ]
        },
        durationMs: 80
      } as any)
      // 2. 仅对 sq-2 调起盲审 A 与挑刺 B
      .mockResolvedValueOnce({
        data: { extractedAnswer: "B", confidence: 0.90, visualNotes: "左竖右圈" },
        durationMs: 50
      } as any)
      .mockResolvedValueOnce({
        data: { extractedAnswer: "A", status: "correct", confidence: 0.95, issues: [], reason: "草写A笔势" },
        durationMs: 50
      } as any)
      // 3. sq-2 盲审与挑刺分歧，调起终审 C
      .mockResolvedValueOnce({
        data: {
          finalExtractedAnswer: "A",
          status: "correct",
          confidence: 0.96,
          visualAnalysis: "微观笔画分析确认为草写A",
          resolutionReason: "微观笔迹动力学裁决为草写A"
        },
        durationMs: 100
      } as any);

    const result = await gradeSmallQuestionStaged(dummyConfig, input, "op-targeted", prepared);

    // 关键验证：总调用次数为 4 次（初检1 + sq-2的A和B共2 + sq-2的C共1 = 4），sq-1 与 sq-3 免除了 4 次重复调用！
    expect(callStructured).toHaveBeenCalledTimes(4);
    expect(result.score).toBe(6);
    expect(result.maxScore).toBe(6);
    expect(result.status).toBe("completed");
    expect(result.subquestions.find((sq) => sq.id === "sq-1")?.finalAnswerStatus).toBe("correct");
    expect(result.subquestions.find((sq) => sq.id === "sq-2")?.finalAnswerStatus).toBe("correct");
    expect(result.subquestions.find((sq) => sq.id === "sq-3")?.finalAnswerStatus).toBe("correct");
    // sq-2 记录了完整的 escalatedReview 审计
    const rec2 = result.smallQuestionAudit?.recognitions.find((r) => r.subquestionId === "sq-2");
    expect(rec2?.decisionSource).toBe("escalated_review_c");
    expect(rec2?.escalatedReview?.finalExtractedAnswer).toBe("A");
  });

  it("correctly identifies substantive vs benign handwriting issues via filterSubstantiveIssues", async () => {
    const { filterSubstantiveIssues } = await import("./smallQuestionGrading.js");

    // 实质性疑点：必须保留
    expect(filterSubstantiveIssues(["疑似涂改"])).toEqual(["疑似涂改"]);
    expect(filterSubstantiveIssues(["字迹潦草疑似A但形似B"])).toEqual(["字迹潦草疑似A但形似B"]);
    expect(filterSubstantiveIssues(["连笔严重导致无法看清"])).toEqual(["连笔严重导致无法看清"]);
    expect(filterSubstantiveIssues(["笔画未闭合疑似数字6"])).toEqual(["笔画未闭合疑似数字6"]);
    expect(filterSubstantiveIssues(["末位有效数字位数不符"])).toEqual(["末位有效数字位数不符"]);
    expect(filterSubstantiveIssues(["存在明显涂改加粗"])).toEqual(["存在明显涂改加粗"]);

    // 良性运笔/草写/规范说明：予以过滤放行
    expect(filterSubstantiveIssues(["草写大写字母A，尖顶连笔略长"])).toEqual([]);
    expect(filterSubstantiveIssues(["草写连笔稍长"])).toEqual([]);
    expect(filterSubstantiveIssues(["书写规范，字迹清晰"])).toEqual([]);
    expect(filterSubstantiveIssues(["无明显涂改，字迹清晰"])).toEqual([]);
    expect(filterSubstantiveIssues(["向右微倾，笔画连贯"])).toEqual([]);
    expect(filterSubstantiveIssues(["手写体a形态"])).toEqual([]);
    expect(filterSubstantiveIssues([])).toEqual([]);
    expect(filterSubstantiveIssues(undefined)).toEqual([]);
  });

  it("triggers full-credit fast-pass in a single model call even when benign cursive notes are in issues", async () => {
    vi.mocked(callStructured).mockResolvedValueOnce({
      data: {
        isEntirelyBlank: false,
        blanks: [
          {
            subquestionId: "sq-1",
            coordinate: [100, 200, 300, 400],
            hasAnswer: true,
            extractedAnswer: "3.80",
            status: "correct",
            confidence: 0.98,
            issues: [],
            reason: "手写3.80清晰保留两位小数"
          },
          {
            subquestionId: "sq-2",
            coordinate: [400, 200, 500, 400],
            hasAnswer: true,
            extractedAnswer: "A",
            status: "correct",
            confidence: 0.95,
            issues: ["草写大写字母A，尖顶连笔略长"],
            reason: "草写A笔势"
          },
          {
            subquestionId: "sq-3",
            coordinate: [700, 200, 800, 400],
            hasAnswer: true,
            extractedAnswer: "甲",
            status: "correct",
            confidence: 0.96,
            issues: [],
            reason: "汉字甲"
          }
        ]
      },
      durationMs: 80
    } as any);

    const result = await gradeSmallQuestionStaged(dummyConfig, input, "op-benign-fast", prepared);

    // 关键验证：良性草写说明不阻断快速通道，全卷仅 1 次模型调用直接 6/6 满分放行！
    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(result.score).toBe(6);
    expect(result.maxScore).toBe(6);
    expect(result.status).toBe("completed");
    expect(result.subquestions.every((sq) => sq.finalAnswerStatus === "correct")).toBe(true);
  });

  it("validates fast pass guardrails correctly via validateFastPassBlank", async () => {
    const { validateFastPassBlank } = await import("./smallQuestionGrading.js");
    const sqChoice = rubric.subquestions[1]; // sq-2, A
    const sqNumeric = rubric.subquestions[0]; // sq-1, 3.80

    // 选择题合法放行
    expect(validateFastPassBlank({
      subquestionId: "sq-2",
      hasAnswer: true,
      extractedAnswer: "A",
      status: "correct",
      confidence: 0.95,
      issues: []
    }, sqChoice, "choice_letter").pass).toBe(true);

    // 选择题良性草写描述放行
    expect(validateFastPassBlank({
      subquestionId: "sq-2",
      hasAnswer: true,
      extractedAnswer: "A",
      status: "correct",
      confidence: 0.95,
      issues: ["草写大写字母A，尖顶连笔略长"]
    }, sqChoice, "choice_letter").pass).toBe(true);

    // 选择题带实质性 issues 拒绝放行
    expect(validateFastPassBlank({
      subquestionId: "sq-2",
      hasAnswer: true,
      extractedAnswer: "A",
      status: "correct",
      confidence: 0.95,
      issues: ["疑似涂改"]
    }, sqChoice, "choice_letter").pass).toBe(false);

    // 选择题低置信度拒绝放行
    expect(validateFastPassBlank({
      subquestionId: "sq-2",
      hasAnswer: true,
      extractedAnswer: "A",
      status: "correct",
      confidence: 0.85,
      issues: []
    }, sqChoice, "choice_letter").pass).toBe(false);

    // 数值题严格保留2位小数(3.80)通过
    expect(validateFastPassBlank({
      subquestionId: "sq-1",
      hasAnswer: true,
      extractedAnswer: "3.80",
      status: "correct",
      confidence: 0.95,
      issues: []
    }, sqNumeric, "numeric").pass).toBe(true);

    // 数值题少写了末尾0 (写了3.8)，硬校验拦截，拒绝放行
    expect(validateFastPassBlank({
      subquestionId: "sq-1",
      hasAnswer: true,
      extractedAnswer: "3.8",
      status: "correct",
      confidence: 0.95,
      issues: []
    }, sqNumeric, "numeric").pass).toBe(false);
  });

  it("bypasses blind transcription A and escalated review C when smallQuestionBlindReviewEnabled is false, adopting skeptic B directly", async () => {
    const configWithBlindDisabled: ModelConfigInput = {
      ...dummyConfig,
      smallQuestionBlindReviewEnabled: false
    };

    vi.mocked(callStructured)
      // 1. 初检：第1空与第3空通过，第2空未达门禁需复核
      .mockResolvedValueOnce({
        data: {
          blanks: [
            {
              subquestionId: "sq-1",
              coordinate: [100, 200, 200, 400],
              hasAnswer: true,
              extractedAnswer: "3.80",
              status: "correct",
              confidence: 0.95,
              issues: [],
              reason: "3.80正确"
            },
            {
              subquestionId: "sq-2",
              coordinate: [400, 200, 500, 400],
              hasAnswer: true,
              extractedAnswer: "A",
              status: "uncertain", // 未达到直接放行门禁
              confidence: 0.80,
              issues: ["需切片审查"],
              reason: "需局部审查"
            },
            {
              subquestionId: "sq-3",
              coordinate: [700, 200, 800, 400],
              hasAnswer: true,
              extractedAnswer: "甲",
              status: "correct",
              confidence: 0.95,
              issues: [],
              reason: "甲正确"
            }
          ]
        },
        durationMs: 80
      } as any)
      // 2. 对 sq-2 仅发起挑刺审查 B（不发起盲审 A，也不发起终审 C）
      .mockResolvedValueOnce({
        data: {
          extractedAnswer: "A",
          status: "correct",
          confidence: 0.93,
          issues: [],
          reason: "草写A整体笔势符合参考答案"
        },
        durationMs: 40
      } as any);

    const result = await gradeSmallQuestionStaged(configWithBlindDisabled, input, "op-bypass-ac", prepared);

    // 关键验证：初检 1 次 + 挑刺审查 B 1 次 = 共 2 次模型调用（彻底绕过了盲审 A 和终审 C）
    expect(callStructured).toHaveBeenCalledTimes(2);
    expect(result.score).toBe(6);
    expect(result.maxScore).toBe(6);
    expect(result.status).toBe("completed");

    const rec2 = result.smallQuestionAudit?.recognitions.find((r) => r.subquestionId === "sq-2");
    expect(rec2?.decisionSource).toBe("skeptic_direct");
    expect(rec2?.finalStatus).toBe("correct");
    expect(rec2?.finalAnswer).toBe("A");
    expect(rec2?.skepticAssessor.extractedAnswer).toBe("A");
    expect(rec2?.blindTranscriber.rawText).toBe("盲审已关闭");
  });

  it("computeSafeCropBox takes full vertical height for flat strips and pads normal images safely", () => {
    // 矮横条图像（如 zhixue:69220964 尺寸 990 x 89）
    const flatBox = computeSafeCropBox([193, 148, 308, 332], 990, 89);
    expect(flatBox.top).toBe(0);
    expect(flatBox.height).toBe(89);
    expect(flatBox.left).toBeLessThan(193 * 990 / 1000);
    expect(flatBox.left + flatBox.width).toBeGreaterThan(308 * 990 / 1000);

    // 正常全卷图像（如 1000 x 1000）
    const normalBox = computeSafeCropBox([100, 200, 300, 400], 1000, 1000);
    expect(normalBox.top).toBeLessThan(200);
    expect(normalBox.top + normalBox.height).toBeGreaterThan(400);
  });

  it("detectInitialVsSkepticDiscrepancy correctly flags status conflicts, answer mismatch and truncation", () => {
    // 1. 初审正确 vs B 存疑
    const conflict1 = detectInitialVsSkepticDiscrepancy(
      { subquestionId: "sq-1", hasAnswer: true, extractedAnswer: "C", status: "correct", confidence: 0.95, issues: [] },
      { extractedAnswer: "截断笔迹", status: "uncertain", confidence: 0.6, issues: ["作答切片严重截断，下半部分缺失"], reason: "截断" }
    );
    expect(conflict1.isDiscrepant).toBe(true);
    expect(conflict1.reason).toContain("存在正误判断冲突");

    // 2. 初审错误 vs B 正确
    const conflict2 = detectInitialVsSkepticDiscrepancy(
      { subquestionId: "sq-1", hasAnswer: true, extractedAnswer: "B", status: "incorrect", confidence: 0.9, issues: [] },
      { extractedAnswer: "A", status: "correct", confidence: 0.95, issues: [], reason: "符合参考答案" }
    );
    expect(conflict2.isDiscrepant).toBe(true);

    // 3. 提取字符不一致
    const conflict3 = detectInitialVsSkepticDiscrepancy(
      { subquestionId: "sq-1", hasAnswer: true, extractedAnswer: "A", status: "uncertain", confidence: 0.7, issues: [] },
      { extractedAnswer: "B", status: "correct", confidence: 0.9, issues: [], reason: "学生写了B" }
    );
    expect(conflict3.isDiscrepant).toBe(true);

    // 4. B 指出切片截断
    const conflict4 = detectInitialVsSkepticDiscrepancy(
      { subquestionId: "sq-1", hasAnswer: true, extractedAnswer: "C", status: "uncertain", confidence: 0.7, issues: [] },
      { extractedAnswer: "C", status: "uncertain", confidence: 0.6, issues: ["作答切片严重截断"], reason: "仅保留字符顶部" }
    );
    expect(conflict4.isDiscrepant).toBe(true);
    expect(conflict4.reason).toContain("严重截断或视野残缺");

    // 5. 无冲突（初审存疑提取A，B审验确认A正确）
    const noConflict = detectInitialVsSkepticDiscrepancy(
      { subquestionId: "sq-1", hasAnswer: true, extractedAnswer: "A", status: "uncertain", confidence: 0.8, issues: [] },
      { extractedAnswer: "A", status: "correct", confidence: 0.95, issues: [], reason: "笔势完全符合A" }
    );
    expect(noConflict.isDiscrepant).toBe(false);
  });

  it("forces escalated review C with dual images when initial triage conflicts with skeptic B, even if blind review is disabled", async () => {
    const configWithBlindDisabled: ModelConfigInput = {
      ...dummyConfig,
      smallQuestionBlindReviewEnabled: false
    };

    vi.mocked(callStructured)
      // 1. 初检：第1空与第3空通过，第2空初检全图判定为 correct ("A")，但置信度稍低(0.85)未达硬放行门禁
      .mockResolvedValueOnce({
        data: {
          blanks: [
            {
              subquestionId: "sq-1",
              coordinate: [100, 200, 200, 400],
              hasAnswer: true,
              extractedAnswer: "3.80",
              status: "correct",
              confidence: 0.95,
              issues: [],
              reason: "3.80正确"
            },
            {
              subquestionId: "sq-2",
              coordinate: [400, 200, 500, 400],
              hasAnswer: true,
              extractedAnswer: "A",
              status: "correct",
              confidence: 0.85,
              issues: [],
              reason: "初检全图识别为大写字母A"
            },
            {
              subquestionId: "sq-3",
              coordinate: [700, 200, 800, 400],
              hasAnswer: true,
              extractedAnswer: "甲",
              status: "correct",
              confidence: 0.95,
              issues: [],
              reason: "甲正确"
            }
          ]
        },
        durationMs: 80
      } as any)
      // 2. 对 sq-2 发起挑刺审查 B：因为切片存疑，判定为 uncertain 且报告切片截断
      .mockResolvedValueOnce({
        data: {
          extractedAnswer: "截断笔迹",
          status: "uncertain",
          confidence: 0.6,
          issues: ["作答切片严重截断，下半部分缺失"],
          reason: "切片打歪截断"
        },
        durationMs: 40
      } as any)
      // 3. 冲突触发！强制调起终审 C（同时传入切片与整卷全图）
      .mockResolvedValueOnce({
        data: {
          finalExtractedAnswer: "A",
          status: "correct",
          confidence: 0.96,
          visualAnalysis: "切片虽有截断，但结合整卷全图可见学生完整书写了大写字母A",
          resolutionReason: "多视角核对全景全图确认A正确"
        },
        durationMs: 60
      } as any);

    const result = await gradeSmallQuestionStaged(configWithBlindDisabled, input, "op-conflict-c", prepared);

    // 关键验证：初检 1 次 + 挑刺审查 B 1 次 + 终审 C 1 次 = 共 3 次模型调用
    expect(callStructured).toHaveBeenCalledTimes(3);

    // 验证调用 C 时同时传入了局部切片与整卷全图 (dualImagesPayload)
    const callCArgs = vi.mocked(callStructured).mock.calls[2][1];
    expect(callCArgs.routeKey).toBe("small_question_escalated_review");
    expect(callCArgs.images).toHaveLength(2); // 1个切片 + 1个整卷全图
    expect(callCArgs.prompt).toContain("多视角");

    expect(result.score).toBe(6);
    expect(result.status).toBe("completed");

    const rec2 = result.smallQuestionAudit?.recognitions.find((r) => r.subquestionId === "sq-2");
    expect(rec2?.decisionSource).toBe("escalated_review_c");
    expect(rec2?.comparisonStatus).toBe("discrepancy");
    expect(rec2?.finalStatus).toBe("correct");
    expect(rec2?.finalAnswer).toBe("A");
    expect(rec2?.escalatedReview?.resolutionReason).toBe("多视角核对全景全图确认A正确");
  });

  it("does not call escalated review C when blind A and skeptic B agree on correct, even if initial triage was uncertain", async () => {
    const singleRubric: Rubric = {
      ...rubric,
      subquestions: [rubric.subquestions[1]] // sq-2, expected "A"
    };

    vi.mocked(callStructured)
      // 1. 初检：sq-2 标记为存疑，进入切片盲审与挑刺
      .mockResolvedValueOnce({
        data: {
          blanks: [
            {
              subquestionId: "sq-2",
              coordinate: [400, 200, 500, 400],
              hasAnswer: true,
              extractedAnswer: "A",
              status: "uncertain",
              confidence: 0.75,
              issues: ["需切片审查"],
              reason: "需局部审查"
            }
          ]
        },
        durationMs: 60
      } as any)
      // 2. 盲审 A 读出 "A"
      .mockResolvedValueOnce({
        data: {
          extractedAnswer: "A",
          confidence: 0.95,
          visualNotes: "清晰手写大写字母A"
        },
        durationMs: 40
      } as any)
      // 3. 挑刺 B 对照参考答案 "A" 也读出 "A"，判定为 correct
      .mockResolvedValueOnce({
        data: {
          extractedAnswer: "A",
          status: "correct",
          confidence: 0.96,
          issues: [],
          reason: "符合参考答案A"
        },
        durationMs: 40
      } as any);

    const result = await gradeSmallQuestionStaged(dummyConfig, { ...input, rubric: singleRubric }, "op-ab-consensus-correct", prepared);

    // 核心验证：初检 1 次 + 盲审 A 1 次 + 挑刺 B 1 次 = 共 3 次模型调用，绝不调用终审 C！
    expect(callStructured).toHaveBeenCalledTimes(3);

    expect(result.score).toBe(2);
    expect(result.status).toBe("completed");

    const rec = result.smallQuestionAudit?.recognitions.find((r) => r.subquestionId === "sq-2");
    expect(rec?.comparisonStatus).toBe("consensus");
    expect(rec?.decisionSource).toBe("consensus_ab");
    expect(rec?.finalStatus).toBe("correct");
    expect(rec?.finalAnswer).toBe("A");
    expect(rec?.escalatedReview).toBeUndefined();
  });

  describe("detectBlankHighRiskSignals & needs_review guardrails", () => {
    it("detects physical truncation, low confidence, cross-stage discrepancy and ambiguity", async () => {
      const { detectBlankHighRiskSignals } = await import("./smallQuestionGrading.js");

      // 案例 1：切片截断导致模型强行给 correct，且 conf 偏低 (对应历史 zhixue:58991b0f)
      const res1 = detectBlankHighRiskSignals({
        subquestionTitle: "第(3)问",
        judgement: {
          subquestionId: "3",
          status: "correct",
          confidence: 0.85,
          evidenceLineIds: [],
          studentAnswer: "B",
          referenceAnswer: "B",
          reason: "切片中手写字符腰部收折，认定为B"
        },
        recognitionAudit: {
          subquestionId: "3",
          blindTranscriber: { extractedAnswer: "B", confidence: 0.85 },
          skepticAssessor: {
            extractedAnswer: "B",
            status: "correct",
            confidence: 0.85,
            issues: ["图像底部存在裁切，仅显示字母上半部分及腰部收折笔势"],
            reason: "符合B特征"
          },
          comparisonStatus: "consensus",
          finalStatus: "correct",
          finalAnswer: "B",
          finalConfidence: 0.85,
          decisionSource: "consensus_ab"
        }
      });
      expect(res1.requiresReview).toBe(true);
      expect(res1.riskReasons.some((r) => r.includes("切片视野裁切或笔画截断风险"))).toBe(true);
      expect(res1.riskReasons.some((r) => r.includes("识别置信度偏低(0.85)"))).toBe(true);

      // 案例 2：切片截断导致模型判错 incorrect (对应历史 zhixue:611d4108)
      const res2 = detectBlankHighRiskSignals({
        subquestionTitle: "第(2)问",
        judgement: {
          subquestionId: "2",
          status: "incorrect",
          confidence: 0.85,
          evidenceLineIds: [],
          studentAnswer: "2.",
          referenceAnswer: "2.4",
          reason: "仅能辨识出2."
        },
        recognitionAudit: {
          subquestionId: "2",
          blindTranscriber: { extractedAnswer: "2.", confidence: 0.85 },
          skepticAssessor: {
            extractedAnswer: "2.",
            status: "incorrect",
            confidence: 0.85,
            issues: ["未能辨别出数字'4'，作答不完整或右侧被截断"],
            reason: "缺失有效数字"
          },
          comparisonStatus: "consensus",
          finalStatus: "incorrect",
          finalAnswer: "2.",
          finalConfidence: 0.85,
          decisionSource: "consensus_ab"
        }
      });
      expect(res2.requiresReview).toBe(true);
      expect(res2.riskReasons.some((r) => r.includes("截断"))).toBe(true);

      // 案例 3：初检全景检测到有效笔迹，切片复核终判为空 (对应历史 zhixue:d9f2c858 切片切偏横线)
      const res3 = detectBlankHighRiskSignals({
        subquestionTitle: "第(2)问",
        judgement: {
          subquestionId: "2",
          status: "missing",
          confidence: 1,
          evidenceLineIds: [],
          studentAnswer: "",
          referenceAnswer: "2.4",
          reason: "未作答"
        },
        recognitionAudit: {
          subquestionId: "2",
          blindTranscriber: { extractedAnswer: "", confidence: 1 },
          skepticAssessor: {
            extractedAnswer: "",
            status: "missing",
            confidence: 1,
            issues: [],
            reason: "未作答"
          },
          comparisonStatus: "consensus",
          finalStatus: "missing",
          finalAnswer: "",
          finalConfidence: 1,
          decisionSource: "blank_missing"
        },
        cropAudit: {
          subquestionId: "2",
          title: "第(2)问",
          coordinate: [100, 200, 300, 400],
          hasAnswer: true // 初检全景检测到了有作答！
        }
      });
      expect(res3.requiresReview).toBe(true);
      expect(res3.riskReasons.some((r) => r.includes("初检全景检测到有效手写笔迹，但切片复核判定为未作答，疑似切片偏离"))).toBe(true);

      // 案例 4：缺少明确小数点与涂改争议 (对应历史 zhixue:85cb39a6)
      const res4 = detectBlankHighRiskSignals({
        subquestionTitle: "第(1)问",
        judgement: {
          subquestionId: "1",
          status: "incorrect",
          confidence: 0.85,
          evidenceLineIds: [],
          studentAnswer: "380",
          referenceAnswer: "3.80",
          reason: "未见清晰的小数点"
        },
        recognitionAudit: {
          subquestionId: "1",
          blindTranscriber: { extractedAnswer: "380", confidence: 0.85 },
          skepticAssessor: {
            extractedAnswer: "380",
            status: "incorrect",
            confidence: 0.85,
            issues: ["缺少明确的小数点（疑似写为380或未点小数点）"],
            reason: "缺少小数点"
          },
          comparisonStatus: "consensus",
          finalStatus: "incorrect",
          finalAnswer: "380",
          finalConfidence: 0.85,
          decisionSource: "consensus_ab"
        }
      });
      expect(res4.requiresReview).toBe(true);
      expect(res4.riskReasons.some((r) => r.includes("存在涂改或小数点清晰度争议"))).toBe(true);

      // 案例 5：完全清晰正常的判定 (不触发复核)
      const res5 = detectBlankHighRiskSignals({
        subquestionTitle: "第(1)问",
        judgement: {
          subquestionId: "1",
          status: "correct",
          confidence: 0.98,
          evidenceLineIds: [],
          studentAnswer: "3.80",
          referenceAnswer: "3.80",
          reason: "字迹清晰规范"
        },
        recognitionAudit: {
          subquestionId: "1",
          blindTranscriber: { extractedAnswer: "3.80", confidence: 0.98 },
          skepticAssessor: {
            extractedAnswer: "3.80",
            status: "correct",
            confidence: 0.98,
            issues: [],
            reason: "符合参考答案3.80"
          },
          comparisonStatus: "consensus",
          finalStatus: "correct",
          finalAnswer: "3.80",
          finalConfidence: 0.98,
          decisionSource: "consensus_ab"
        }
      });
      expect(res5.requiresReview).toBe(false);
      expect(res5.riskReasons).toHaveLength(0);

      // 案例 6：模型明确返回 riskPoints 为 ["无"] 时，即使 issues 包含潜在争议词汇也绝不触发复核（废除自由文本意见原文正则匹配）
      const res6 = detectBlankHighRiskSignals({
        subquestionTitle: "第(1)问",
        judgement: {
          subquestionId: "1",
          status: "correct",
          confidence: 0.95,
          evidenceLineIds: [],
          studentAnswer: "3.80",
          referenceAnswer: "3.80",
          reason: "字迹清晰规范"
        },
        recognitionAudit: {
          subquestionId: "1",
          blindTranscriber: { extractedAnswer: "3.80", confidence: 0.95 },
          skepticAssessor: {
            extractedAnswer: "3.80",
            status: "correct",
            confidence: 0.95,
            issues: ["切片边缘略有裁剪但经核实完整", "曾有轻微笔画涂改痕迹但已废弃"],
            reason: "符合参考答案3.80",
            riskPoints: ["无"]
          },
          comparisonStatus: "consensus",
          finalStatus: "correct",
          finalAnswer: "3.80",
          finalConfidence: 0.95,
          finalRiskPoints: ["无"],
          decisionSource: "consensus_ab"
        }
      });
      expect(res6.requiresReview).toBe(false);
      expect(res6.riskReasons).toHaveLength(0);
    });

    it("escalates whole paper to needs_review when model gave correct status but issues reported truncation and low confidence", async () => {
      const singleRubric: Rubric = {
        ...rubric,
        totalScore: 2,
        subquestions: [
          {
            ...rubric.subquestions[1], // sq-2, expected "A"
            scorePoints: [{ id: "p1", title: "选择题作答", description: "", score: 2, type: "result", expected: "A" }]
          }
        ]
      };

      vi.mocked(callStructured)
        // 1. 初检
        .mockResolvedValueOnce({
          data: {
            blanks: [
              {
                subquestionId: "sq-2",
                coordinate: [400, 200, 500, 400],
                hasAnswer: true,
                status: "uncertain",
                extractedAnswer: "A",
                confidence: 0.8,
                issues: ["初检查验需切片复核"],
                reason: "需局部审查"
              }
            ]
          },
          durationMs: 60
        } as any)
        // 2. 盲审 A 读出 "A", 但置信度 0.85
        .mockResolvedValueOnce({
          data: {
            extractedAnswer: "A",
            confidence: 0.85,
            visualNotes: "手写大写字母A"
          },
          durationMs: 40
        } as any)
        // 3. 挑刺 B: status 虽然强行给 correct，但明确报告切片存在裁切，且置信度仅 0.85
        .mockResolvedValueOnce({
          data: {
            extractedAnswer: "A",
            status: "correct",
            confidence: 0.85,
            riskPoints: ["切片截断"],
            issues: ["切片下边缘略有裁剪，仅显示字母上半部分"],
            reason: "手势笔划符合大写字母A"
          },
          durationMs: 40
        } as any)
        // 4. 终审 C: 即使认定为 correct，但置信度仅 0.85 (< 0.90 门禁)
        .mockResolvedValueOnce({
          data: {
            finalExtractedAnswer: "A",
            status: "correct",
            confidence: 0.85,
            riskPoints: ["切片截断"],
            visualAnalysis: "全图字迹虽有A的轮廓，但仍受轻微裁切影响，置信度一般",
            resolutionReason: "结合全图倾向判定为A"
          },
          durationMs: 50
        } as any);

      const result = await gradeSmallQuestionStaged(dummyConfig, { ...input, rubric: singleRubric }, "op-forced-needs-review", prepared);

      // 验证计分权威：模型判定为 correct，后端计分依然给满分 2 分
      expect(result.score).toBe(2);
      expect(result.maxScore).toBe(2);

      // 验证安全门禁：整卷状态必须被强制升级为 needs_review，绝不静默以 completed 放行！
      expect(result.status).toBe("needs_review");
      expect(result.reviewReasons.length).toBeGreaterThan(0);
      expect(result.reviewReasons.some((r) => r.includes("切片视野裁切或笔画截断风险") || r.includes("识别置信度偏低(0.85)"))).toBe(true);

      // 验证决策记录标记为 small_question_risk_guard 且 requiresReview 为 true
      const sqGrade = result.subquestions[0];
      expect(sqGrade.decisions[0].requiresReview).toBe(true);
      expect(sqGrade.decisions[0].decisionSource).toBe("small_question_risk_guard");
    });

    it("escalates whole paper to needs_review when skeptic B directly adopted reports truncation and confidence < 0.90", async () => {
      const configBlindDisabled: ModelConfigInput = {
        ...dummyConfig,
        smallQuestionBlindReviewEnabled: false
      };
      const singleRubric: Rubric = {
        ...rubric,
        totalScore: 2,
        subquestions: [
          {
            ...rubric.subquestions[1], // sq-2
            scorePoints: [{ id: "p1", title: "选择题作答", description: "", score: 2, type: "result", expected: "A" }]
          }
        ]
      };

      vi.mocked(callStructured)
        // 1. 初检：sq-2 初检与 B 状态一致都是 incorrect，不触发 C
        .mockResolvedValueOnce({
          data: {
            blanks: [
              {
                subquestionId: "sq-2",
                coordinate: [400, 200, 500, 400],
                hasAnswer: true,
                status: "incorrect",
                extractedAnswer: "D",
                confidence: 0.85,
                issues: ["初检判错"],
                reason: "需切片审查"
              }
            ]
          },
          durationMs: 60
        } as any)
        // 2. 挑刺 B: 盲审关闭，直接采信 B；B 报告切片右侧被截断误判为 D，conf 0.85
        .mockResolvedValueOnce({
          data: {
            extractedAnswer: "D",
            status: "incorrect",
            confidence: 0.85,
            riskPoints: ["切片截断"],
            issues: ["作答字符右侧严重截断，笔画缺失，与参考答案B不符"],
            reason: "缺少左竖双弧特征"
          },
          durationMs: 40
        } as any);

      const result = await gradeSmallQuestionStaged(configBlindDisabled, { ...input, rubric: singleRubric }, "op-skeptic-truncation", prepared);

      // 验证直接采信 B 判错：0分
      expect(result.score).toBe(0);
      expect(result.maxScore).toBe(2);
      // 验证因为承认了截断和低置信度，系统强制标记 needs_review
      expect(result.status).toBe("needs_review");
      expect(result.reviewReasons.some((r) => r.includes("截断"))).toBe(true);
      expect(result.reviewReasons.some((r) => r.includes("识别置信度偏低(0.85)"))).toBe(true);

      const sqGrade = result.subquestions[0];
      expect(sqGrade.decisions[0].requiresReview).toBe(true);
      expect(sqGrade.decisions[0].decisionSource).toBe("small_question_risk_guard");
    });

    it("adopts consensus_ab directly without calling C when Blind A and Skeptic B agree on incorrect answer (e.g. both read B for expected C)", async () => {
      const singleRubric: Rubric = {
        ...rubric,
        totalScore: 2,
        subquestions: [
          {
            ...rubric.subquestions[0], // sq-1, expected "3.80"
            scorePoints: [{ id: "p1", title: "选择题作答", description: "", score: 2, type: "result", expected: "C" }],
            finalAnswers: [{ expression: "C" }]
          }
        ]
      };

      vi.mocked(callStructured)
        // 1. 初检
        .mockResolvedValueOnce({
          data: {
            blanks: [
              {
                subquestionId: "sq-1",
                coordinate: [160, 128, 195, 375],
                hasAnswer: true,
                status: "incorrect",
                extractedAnswer: "B",
                confidence: 0.98,
                issues: ["与参考答案不符"],
                reason: "需切片核验"
              }
            ]
          },
          durationMs: 50
        } as any)
        // 2. 盲审 A 读出 "B" (置信度 0.98)
        .mockResolvedValueOnce({
          data: {
            extractedAnswer: "B",
            confidence: 0.98,
            visualNotes: "清晰大写字母B"
          },
          durationMs: 40
        } as any)
        // 3. 挑刺 B 也读出 "B"，判定为 incorrect (置信度 0.98)
        .mockResolvedValueOnce({
          data: {
            extractedAnswer: "B",
            status: "incorrect",
            confidence: 0.98,
            issues: [],
            reason: "学生书写为字母B，与参考答案C不符"
          },
          durationMs: 40
        } as any)
        // 4. 终审 C: 结合全图确认为字母B (置信度 0.99，说明“无任何视野残缺或边缘截断”)
        .mockResolvedValueOnce({
          data: {
            finalExtractedAnswer: "B",
            status: "incorrect",
            confidence: 0.99,
            visualAnalysis: "微观分析显示：无任何视野残缺或边缘截断，确凿为手写大写字母B",
            resolutionReason: "核实确为B，与参考答案C不符，判定错误"
          },
          durationMs: 40
        } as any);

      const result = await gradeSmallQuestionStaged(dummyConfig, { ...input, rubric: singleRubric }, "op-ab-consensus-incorrect", prepared);

      // 验证：终审 C 确认判错，共调用 4 次
      expect(callStructured).toHaveBeenCalledTimes(4);

      expect(result.score).toBe(0);
      expect(result.maxScore).toBe(2);
      expect(result.status).toBe("completed"); // 双方与终审清晰无误判定为错误，否定陈述清洗生效，绝不误报 needs_review！
      expect(result.reviewReasons).toHaveLength(0);

      const rec = result.smallQuestionAudit?.recognitions.find((r) => r.subquestionId === "sq-1");
      expect(rec?.decisionSource).toBe("escalated_review_c");
      expect(rec?.finalStatus).toBe("incorrect");
      expect(rec?.finalAnswer).toBe("B");
    });

    it("does not trigger review when visualAnalysis explicitly states '无任何视野残缺或边缘截断' (negation stripping)", async () => {
      const { detectBlankHighRiskSignals } = await import("./smallQuestionGrading.js");

      const res = detectBlankHighRiskSignals({
        subquestionTitle: "第(1)问",
        judgement: {
          subquestionId: "1",
          status: "incorrect",
          confidence: 0.99,
          evidenceLineIds: [],
          studentAnswer: "B",
          referenceAnswer: "C",
          reason: "终审核实确凿为B"
        },
        recognitionAudit: {
          subquestionId: "1",
          blindTranscriber: { extractedAnswer: "B", confidence: 0.98 },
          skepticAssessor: {
            extractedAnswer: "B",
            status: "incorrect",
            confidence: 0.98,
            issues: [],
            reason: "学生书写B"
          },
          comparisonStatus: "discrepancy",
          escalatedReview: {
            finalExtractedAnswer: "B",
            status: "incorrect",
            confidence: 0.99,
            visualAnalysis: "微观笔画分析显示：字迹清晰完整，无任何涂改或穿透划线痕迹。对照整卷全景图，无任何视野残缺或边缘截断，确凿为手写大写字母'B'。",
            resolutionReason: "核实确为B"
          },
          finalStatus: "incorrect",
          finalAnswer: "B",
          finalConfidence: 0.99,
          decisionSource: "escalated_review_c"
        }
      });

      // 关键验证：否定陈述被安全排除，不应触发待复核！
      expect(res.requiresReview).toBe(false);
      expect(res.riskReasons).toHaveLength(0);
    });
  });

  describe("三方一致性门禁 (首评、A、B) 与切片偏离终审裁决防御 (zhixue:8ffa3436 防御测试)", () => {
    it("checkThreeWayConsensus flags discrepancy when initial triage detects answer but slice A & B return empty/missing", () => {
      // 场景：首评在全景图看到了 "D"，但切片切偏，A 读出空字符串，B 判 missing
      const result = checkThreeWayConsensus({
        layoutBlank: {
          subquestionId: "sq-3",
          hasAnswer: true,
          extractedAnswer: "D",
          status: "incorrect",
          confidence: 0.99
        },
        resA: { extractedAnswer: "", confidence: 0.95 },
        resB: { extractedAnswer: "", status: "missing", confidence: 1.0, issues: ["考生未作答"], reason: "空白" },
        finalAnswers: [{ expression: "B" }]
      });

      expect(result.isConsistent).toBe(false);
      expect(result.reason).toContain("初检全图检测到有效作答");
      expect(result.reason).toContain("切片核验");
      expect(result.reason).toContain("判空");
    });

    it("checkThreeWayConsensus flags discrepancy when initial triage differs from A and B", () => {
      // 场景：首评识别为 "A"，但切片 A 与 B 均识别为 "B"
      const result = checkThreeWayConsensus({
        layoutBlank: {
          subquestionId: "sq-1",
          hasAnswer: true,
          extractedAnswer: "A",
          status: "incorrect",
          confidence: 0.9
        },
        resA: { extractedAnswer: "B", confidence: 0.98 },
        resB: { extractedAnswer: "B", status: "correct", confidence: 0.98, issues: [], reason: "符合参考答案" },
        finalAnswers: [{ expression: "B" }]
      });

      expect(result.isConsistent).toBe(false);
      expect(result.reason).toContain("三者识别作答内容不一致");
    });

    it("checkThreeWayConsensus reaches consensus without calling C when initial, A, and B all agree on correct answer", () => {
      const result = checkThreeWayConsensus({
        layoutBlank: {
          subquestionId: "sq-1",
          hasAnswer: true,
          extractedAnswer: "3.80",
          status: "correct",
          confidence: 0.95
        },
        resA: { extractedAnswer: "3.80", confidence: 0.98 },
        resB: { extractedAnswer: "3.80", status: "correct", confidence: 0.99, issues: [], reason: "符合3.80" },
        finalAnswers: [{ expression: "3.80" }]
      });

      expect(result.isConsistent).toBe(true);
      expect(result.reason).toBe("");
    });

    it("checkThreeWayConsensus reaches consensus when all three genuinely confirm unattempted/missing", () => {
      const result = checkThreeWayConsensus({
        layoutBlank: {
          subquestionId: "sq-2",
          hasAnswer: false,
          extractedAnswer: "",
          status: "missing",
          confidence: 1.0
        },
        resA: { extractedAnswer: "", confidence: 1.0 },
        resB: { extractedAnswer: "", status: "missing", confidence: 1.0, issues: [], reason: "未作答" },
        finalAnswers: [{ expression: "A" }]
      });

      expect(result.isConsistent).toBe(true);
      expect(result.reason).toBe("");
    });

    it("detectInitialVsSkepticDiscrepancy flags discrepancy when initial has answer but B says missing", () => {
      const result = detectInitialVsSkepticDiscrepancy(
        {
          subquestionId: "sq-3",
          hasAnswer: true,
          extractedAnswer: "D",
          status: "incorrect",
          confidence: 0.99
        },
        {
          extractedAnswer: "",
          status: "missing",
          confidence: 1.0,
          issues: ["切片未见作答"],
          reason: "空白横线"
        }
      );

      expect(result.isDiscrepant).toBe(true);
      expect(result.reason).toContain("初检全图检测到有效作答");
      expect(result.reason).toContain("切片审查判定为未作答");
    });

    it("computeSafeCropBox expands rightward sufficiently for flat strips to prevent cropping out right-side answers", () => {
      // 对应 zhixue:8ffa3436 答卷，尺寸 990 x 89，第(3)空模型返回的坐标为印刷标号区域 [693, 120, 745, 308]
      // 真实手写 D 在 x = 779..803 处
      const cropBoxIsolated = computeSafeCropBox([693, 120, 745, 308], 990, 89);
      expect(cropBoxIsolated.top).toBe(0);
      expect(cropBoxIsolated.height).toBe(89);
      expect(cropBoxIsolated.left + cropBoxIsolated.width).toBeGreaterThanOrEqual(825);

      // 当带上整卷小问拓扑时，第(3)空作为最右小空，右边界直接吃满整张答卷宽度 990px
      const contextMap = buildBlankLayoutContextMap([
        { subquestionId: "1", coordinate: [168, 8, 208, 280], hasAnswer: true },
        { subquestionId: "2", coordinate: [468, 120, 527, 282], hasAnswer: true },
        { subquestionId: "3", coordinate: [693, 120, 745, 308], hasAnswer: true }
      ]);
      const cropBoxWithContext3 = computeSafeCropBox([693, 120, 745, 308], 990, 89, contextMap.get("3"));
      expect(cropBoxWithContext3.top).toBe(0);
      expect(cropBoxWithContext3.height).toBe(89);
      expect(cropBoxWithContext3.left).toBeLessThanOrEqual(640);
      expect(cropBoxWithContext3.left + cropBoxWithContext3.width).toBe(990); // 吃满整卷右边缘！

      // 第(1)空延伸到第(2)空前，第(2)空延伸到第(3)空前
      const cropBoxWithContext1 = computeSafeCropBox([168, 8, 208, 280], 990, 89, contextMap.get("1"));
      expect(cropBoxWithContext1.left + cropBoxWithContext1.width).toBeGreaterThanOrEqual(300);
      expect(cropBoxWithContext1.left + cropBoxWithContext1.width).toBeLessThanOrEqual(468 * 990 / 1000);

      const cropBoxWithContext2 = computeSafeCropBox([468, 120, 527, 282], 990, 89, contextMap.get("2"));
      expect(cropBoxWithContext2.left + cropBoxWithContext2.width).toBeGreaterThanOrEqual(600);
      expect(cropBoxWithContext2.left + cropBoxWithContext2.width).toBeLessThanOrEqual(693 * 990 / 1000);
    });

    it("e2e reproduces zhixue:8ffa3436: passes initial results to B and forces escalated review C when slice is cut empty", async () => {
      const singleRubric: Rubric = {
        ...rubric,
        totalScore: 2,
        subquestions: [
          {
            id: "sq-3",
            title: "第(3)空",
            maxScore: 2,
            finalAnswerPolicy: "full_credit",
            finalAnswers: [{ expression: "B" }],
            scorePoints: [{ id: "p3", title: "选择题", description: "", score: 2, type: "result", expected: "B" }],
            deductions: []
          }
        ]
      };

      vi.mocked(callStructured)
        // 1. 初检：整卷全景识别到 "D" (incorrect)，但返回的坐标偏移到了印刷序号
        .mockResolvedValueOnce({
          data: {
            blanks: [
              {
                subquestionId: "sq-3",
                coordinate: [693, 120, 745, 308],
                hasAnswer: true,
                extractedAnswer: "D",
                status: "incorrect",
                confidence: 0.99,
                issues: [],
                reason: "学生手写选项为D，与参考答案B不符"
              }
            ],
            isEntirelyBlank: false
          },
          durationMs: 80
        } as any)
        // 2. 盲审 A：切片中因偏离未见手写笔迹，返回空字符串
        .mockResolvedValueOnce({
          data: {
            extractedAnswer: "",
            confidence: 0.95,
            visualNotes: "切片横线上方为空白"
          },
          durationMs: 40
        } as any)
        // 3. 挑刺 B：切片中未见笔迹，判定为 missing
        .mockResolvedValueOnce({
          data: {
            extractedAnswer: "",
            status: "missing",
            confidence: 1.0,
            issues: ["切片未见有效笔迹/疑似裁切偏离，与初检识别到'D'不符"],
            reason: "切片横线处未见手写笔迹"
          },
          durationMs: 40
        } as any)
        // 4. 终审 C：强制调起！传入局部切片与整卷全图，终审在全图中清晰看到学生写了 "D"，判定为 incorrect
        .mockResolvedValueOnce({
          data: {
            finalExtractedAnswer: "D",
            status: "incorrect",
            confidence: 0.99,
            visualAnalysis: "局部切片虽仅框选了印刷题号(3)右侧空白，但在图2整卷全景图中，清晰可见学生在横线右侧工整书写了选项'D'。作答确凿为D，与参考答案B不符。",
            resolutionReason: "对照全景全图确认学生实际书写了选项D，判定为错误"
          },
          durationMs: 90
        } as any);

      const result = await gradeSmallQuestionStaged(dummyConfig, { ...input, rubric: singleRubric }, "op-8ffa3436-repro", prepared);

      // 验证 1：挑刺审查 B 的 prompt 中成功注入了首评信息
      const callBArgs = vi.mocked(callStructured).mock.calls[2][1];
      expect(callBArgs.prompt).toContain("【整卷全景初检（首评）识别结果参考】");
      expect(callBArgs.prompt).toContain("全景初检识别作答：\"D\"");
      expect(callBArgs.prompt).toContain("极可能是切片算法定位偏移、坐标框偏或切到了空白区域");

      // 验证 2：虽然 A 与 B 在空切片上均判空，但因首评识别出 "D"，三方一致性校验判定分歧，强制调起终审 C！
      expect(callStructured).toHaveBeenCalledTimes(4);

      // 验证 3：终审 C 同时接收了局部切片与整卷全景图
      const callCArgs = vi.mocked(callStructured).mock.calls[3][1];
      expect(callCArgs.routeKey).toBe("small_question_escalated_review");
      expect(callCArgs.images).toHaveLength(2); // 切片 + 全景
      expect(callCArgs.prompt).toContain("整卷全景初检识别为: \"D\"");

      // 验证 4：批改结果由终审 C 权威裁决，最终答案确认为 "D"，得分 0 分
      expect(result.score).toBe(0);
      expect(result.subquestions[0].studentFinalAnswer).toBe("D");
      expect(result.subquestions[0].finalAnswerStatus).toBe("incorrect");

      const rec = result.smallQuestionAudit?.recognitions[0];
      expect(rec?.comparisonStatus).toBe("discrepancy");
      expect(rec?.decisionSource).toBe("escalated_review_c");
      expect(rec?.escalatedReview?.finalExtractedAnswer).toBe("D");
    });
  });
});
