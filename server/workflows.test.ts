import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { ModelConfigInput, Rubric } from "../shared/types.js";

vi.mock("./modelClient.js", () => ({
  callStructured: vi.fn(),
  resolveReviewModelConfig: (modelConfig: ModelConfigInput): ModelConfigInput => {
    const reviewModel = modelConfig.reviewModel?.trim();
    if (!reviewModel) throw new Error("未配置局部审验模型");
    const reviewApiKey = modelConfig.reviewApiKey?.trim();
    if (!reviewApiKey) throw new Error("局部审验模型缺少独立 API Key，系统不会使用教师模型密钥代替");
    return {
      ...modelConfig,
      baseUrl: modelConfig.reviewBaseUrl?.trim() || modelConfig.baseUrl,
      apiKey: reviewApiKey,
      reviewModel
    };
  }
}));

vi.mock("./paddleOcr.js", () => ({
  runPaddleOcr: vi.fn()
}));

vi.mock("./responsesAgentGrading.js", () => ({
  gradeLargeQuestionResponsesAgent: vi.fn()
}));

import { callStructured } from "./modelClient.js";
import { runPaddleOcr } from "./paddleOcr.js";
import { gradeLargeQuestionResponsesAgent } from "./responsesAgentGrading.js";
import { rubricSchema } from "./schemas.js";
import { gradeStudentAnswer, refineRubric, structureRubric } from "./workflows.js";

const config: ModelConfigInput = {
  name: "test",
  baseUrl: "https://example.test/v1",
  apiKey: "test",
  visionModel: "teacher-vision",
  textModel: "teacher-text",
  timeoutMs: 1000,
  maxRetries: 0,
  maxConcurrency: 1,
  maxOutputTokens: 4096,
  unreadableReviewThreshold: 2,
  gradingMode: "evidence_pipeline",
  supportsJsonSchema: true,
  supportsJsonObject: true,
  supportsBase64Images: true,
  enabled: true
};

const rubric: Rubric = {
  title: "测试题",
  recognizedQuestionText: "求结果",
  version: 1,
  status: "locked",
  questionType: "large",
  totalScore: 2,
  warnings: [],
  subquestions: [{
    id: "Q1",
    title: "第一问",
    maxScore: 2,
    finalAnswerPolicy: "process_required",
    finalAnswers: [{ expression: "x=2" }],
    scorePoints: [
      { id: "P1", title: "公式", description: "列式", score: 1, type: "formula", expected: "x=1+1" },
      { id: "P2", title: "结果", description: "结果", score: 1, type: "result", expected: "x=2" }
    ],
    deductions: []
  }]
};

const directOcrAudit = {
  provider: "paddleocr" as const,
  model: "PaddleOCR-VL-1.6",
  jobId: "direct-ocr-job",
  rawJsonl: "{\"result\":{\"layoutParsingResults\":[]}}\n",
  markdownText: "x=2",
  imageWidth: 80,
  imageHeight: 60,
  durationMs: 12
};

const extractionResponse = {
  data: {
    lines: [{ id: "L1", text: "x=2", status: "active", confidence: 0.99, alternatives: [] }],
    finalAnswers: [{ subquestionId: "Q1", lineId: "L1", expression: "x=2", unit: "", confidence: 0.99 }],
    ambiguities: []
  },
  durationMs: 10,
  outputMode: "json_schema"
};

const commentaryResponse = {
  data: {
    overallComment: "能够完成主要公式列写，结果仍有一处需要改进。",
    strengths: ["公式列写清晰"],
    lostPoints: [],
    auditConcerns: [],
    reviewItems: [],
    basedOnDecisionIds: ["Q1:P1", "Q1:P2"]
  },
  durationMs: 8,
  outputMode: "json_schema"
};

async function createTestAnswerImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 80,
      height: 60,
      channels: 3,
      background: { r: 248, g: 248, b: 248 }
    }
  }).png().toBuffer();
}

describe("structureRubric final-answer policy", () => {
  beforeEach(() => vi.mocked(callStructured).mockReset());

  it("backfills empty answer-form guidance for legacy score points", () => {
    const parsed = rubricSchema.parse(rubric);

    expect(parsed.subquestions[0].scorePoints[0]).toMatchObject({
      commonResponses: [],
      alternativeMethods: [],
      acceptedEquivalents: []
    });
  });

  it("drops legacy mechanical matching fields from imported rubrics", () => {
    const parsed = rubricSchema.parse({
      ...rubric,
      subquestions: rubric.subquestions.map((subquestion) => ({
        ...subquestion,
        finalAnswers: subquestion.finalAnswers.map((answer) => ({ ...answer, tolerance: 0.01 })),
        scorePoints: subquestion.scorePoints.map((point) => ({ ...point, equivalents: [point.expected] }))
      }))
    });

    expect(parsed.subquestions[0].finalAnswers[0]).not.toHaveProperty("tolerance");
    expect(parsed.subquestions[0].scorePoints[0]).not.toHaveProperty("equivalents");
  });

  it("normalizes generated subquestions to the global final-answer full-credit rule", async () => {
    vi.mocked(callStructured).mockResolvedValueOnce({
      data: {
        title: "过程必需题",
        recognizedQuestionText: "写出完整过程",
        version: 1,
        status: "draft",
        totalScore: 2,
        warnings: [],
        subquestions: [{
          id: "Q1",
          title: "第一问",
          maxScore: 2,
          finalAnswerPolicy: "process_required",
          finalAnswers: [{ expression: "x=2", unit: "", label: "" }],
          scorePoints: [
            { id: "P1", title: "公式", description: "列式", score: 1, type: "formula", expected: "x=1+1", commonResponses: ["x=1+1", "1+1=x"], alternativeMethods: ["由题设关系直接化简得到x=2"], acceptedEquivalents: ["x=2.0", "2=x"] },
            { id: "P2", title: "结果", description: "结果", score: 1, type: "result", expected: "x=2", commonResponses: ["x=2"], alternativeMethods: [], acceptedEquivalents: ["2=x"] }
          ],
          deductions: []
        }]
      },
      durationMs: 10,
      outputMode: "json_schema"
    });

    const result = await structureRubric(config, {
      questionText: "求x并写出过程",
      referenceText: "列式1分，结果1分",
      questionImages: [],
      referenceImages: []
    });

    expect(result.subquestions[0].finalAnswerPolicy).toBe("full_credit");
    const request = vi.mocked(callStructured).mock.calls[0][1];
    expect(request.system).toContain("只能忠实转录和转换输入文档");
    expect(request.prompt).toContain("过程审验不得降低得分");
    expect(request.prompt).toContain("不得把“列公式”和“代入计算”混为同一个类型");
    expect(request.prompt).not.toContain("预测学生卷面上常见的正确作答形式");
    expect(request.prompt).not.toContain("为每个已有评分点补充");
    expect(result.subquestions[0].scorePoints[0]).toMatchObject({
      commonResponses: [],
      alternativeMethods: [],
      acceptedEquivalents: []
    });
  });

  it("accepts both question types and rejects unknown values", () => {
    expect(rubricSchema.parse({ ...rubric, questionType: "large" }).questionType).toBe("large");
    expect(rubricSchema.parse({ ...rubric, questionType: "small" }).questionType).toBe("small");
    expect(() => rubricSchema.parse({ ...rubric, questionType: "hybrid" })).toThrow();
  });

  it("uses the selected small-question policy and overwrites a model-supplied type", async () => {
    vi.mocked(callStructured).mockResolvedValueOnce({
      data: { ...rubric, questionType: "large", status: "draft" },
      durationMs: 10,
      outputMode: "json_schema"
    });

    const result = await structureRubric(config, {
      questionText: "小题题目",
      referenceText: "小题参考答案",
      questionImages: [],
      referenceImages: [],
      questionType: "small"
    });

    expect(result.questionType).toBe("small");
    expect(vi.mocked(callStructured).mock.calls[0]?.[1].system).toContain("小题评分标准结构化工具");
  });
});

describe("refineRubric", () => {
  beforeEach(() => vi.mocked(callStructured).mockReset());

  const refinedResponse = (overrides: Partial<Rubric> = {}) => ({
    data: {
      ...rubric,
      status: "draft" as const,
      subquestions: rubric.subquestions.map((subquestion) => ({
        ...subquestion,
        finalAnswerPolicy: "full_credit" as const,
        scorePoints: subquestion.scorePoints.map((point) => ({
          ...point,
          description: `${point.description}，接受等价物理表达`,
          commonResponses: [point.expected],
          alternativeMethods: [],
          acceptedEquivalents: [point.expected]
        }))
      })),
      ...overrides
    },
    durationMs: 10,
    outputMode: "json_schema" as const
  });

  it("sends the complete rubric and teacher instruction while preserving scoring structure", async () => {
    vi.mocked(callStructured).mockResolvedValueOnce(refinedResponse());

    const result = await refineRubric(config, rubric, "补充代数等价形式");

    const request = vi.mocked(callStructured).mock.calls[0][1];
    expect(request.model).toBe(config.textModel);
    expect(request.schemaName).toBe("physics_rubric_refinement");
    expect(request.prompt).toContain("补充代数等价形式");
    expect(request.prompt).toContain(JSON.stringify(rubric, null, 2));
    expect(request.system).toContain("不是封闭答案白名单");
    expect(result.status).toBe("draft");
    expect(result.version).toBe(rubric.version);
    expect(result.subquestions[0].finalAnswerPolicy).toBe("full_credit");
    expect(result.subquestions[0].scorePoints[0].description).toContain("接受等价物理表达");
  });

  it("rejects a model response that changes a protected score", async () => {
    vi.mocked(callStructured).mockResolvedValueOnce(refinedResponse({ totalScore: 3 }));

    await expect(refineRubric(config, rubric, "完善说明")).rejects.toThrow("受保护的评分结构（总分）");
  });

  it("rejects a model response that changes a score-point id", async () => {
    const response = refinedResponse();
    response.data.subquestions[0].scorePoints[0].id = "CHANGED";
    vi.mocked(callStructured).mockResolvedValueOnce(response);

    await expect(refineRubric(config, rubric, "完善说明")).rejects.toThrow("评分点的 ID 或顺序");
  });

  it("rejects a model response that changes the evidence type", async () => {
    const response = refinedResponse();
    response.data.subquestions[0].scorePoints[0].type = "result";
    vi.mocked(callStructured).mockResolvedValueOnce(response);

    await expect(refineRubric(config, rubric, "完善说明")).rejects.toThrow("评分点类型");
  });

  it("rejects a model response that changes the question type", async () => {
    vi.mocked(callStructured).mockResolvedValueOnce(refinedResponse({ questionType: "small" }));

    await expect(refineRubric(config, rubric, "完善说明")).rejects.toThrow("题型保存后不可修改");
  });
});

describe("gradeStudentAnswer call sequence", () => {
  beforeEach(() => vi.mocked(callStructured).mockReset());

  it("audits every process point without lowering a correct final answer", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(extractionResponse)
      .mockResolvedValueOnce({
        data: { finalAnswerJudgements: [{ subquestionId: "Q1", status: "correct", evidenceLineIds: ["L1"], studentAnswer: "x=2", referenceAnswer: "x=2", reason: "答案一致", confidence: 0.99 }] },
        durationMs: 12,
        outputMode: "json_schema"
      })
      .mockResolvedValueOnce({
        data: {
          decisions: [
            { subquestionId: "Q1", pointId: "P1", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=1+1", reason: "公式正确", confidence: 0.98, requiresReview: false, reviewReason: "" },
            { subquestionId: "Q1", pointId: "P2", status: "not_satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=2", reason: "过程未满足", confidence: 0.98, requiresReview: false, reviewReason: "" }
          ],
          appliedDeductions: [],
          teacherCommentary: commentaryResponse.data
        },
        durationMs: 14,
        outputMode: "json_schema"
      });

    const { result } = await gradeStudentAnswer(config, {
      id: "all-correct", studentId: "S1", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: Buffer.from("image"), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(3);
    expect(vi.mocked(callStructured).mock.calls.map((call) => call[1].schemaName)).toEqual([
      "answer_evidence",
      "final_answer_judgements",
      "process_point_judgement_with_commentary"
    ]);
    expect(result.score).toBe(2);
    expect(result.subquestions[0].decisions[1].status).toBe("not_satisfied");
    expect(result.subquestions[0].decisions.every((item) => item.scoringDisposition === "not_deducted_by_final_answer")).toBe(true);
    expect(result.subquestions[0].decisions.every((item) => item.awardedScore === item.maxScore)).toBe(true);
    expect(result.teacherCommentary?.status).toBe("completed");
    expect(vi.mocked(callStructured).mock.calls[2][1].prompt).toContain("任何过程问题都不能降低该小问最终得分");
  });

  it("audits process points after an incorrect final-answer judgement and generates commentary", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(extractionResponse)
      .mockResolvedValueOnce({
        data: { finalAnswerJudgements: [{ subquestionId: "Q1", status: "incorrect", evidenceLineIds: ["L1"], studentAnswer: "x=3", referenceAnswer: "x=2", reason: "结果不同", confidence: 0.99 }] },
        durationMs: 12,
        outputMode: "json_schema"
      })
      .mockResolvedValueOnce({
        data: {
          decisions: [
            { subquestionId: "Q1", pointId: "P1", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=1+1", reason: "公式正确", confidence: 0.98, requiresReview: false, reviewReason: "" },
            { subquestionId: "Q1", pointId: "P2", status: "not_satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=3", reason: "结果错误", confidence: 0.98, requiresReview: false, reviewReason: "" }
          ],
          appliedDeductions: [],
          teacherCommentary: commentaryResponse.data
        },
        durationMs: 14,
        outputMode: "json_schema"
      });

    const { result } = await gradeStudentAnswer(config, {
      id: "incorrect", studentId: "S2", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: Buffer.from("image"), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(3);
    expect(vi.mocked(callStructured).mock.calls[2][1].schemaName).toBe("process_point_judgement_with_commentary");
    expect(vi.mocked(callStructured).mock.calls[2][1].system).toContain("禁止从具体数值、计算顺序、上下文或期望答案反推");
    expect(vi.mocked(callStructured).mock.calls[2][1].system).toContain("来源不明的数字拼接");
    expect(result.score).toBe(1);
  });

  it("marks the result for review and uses fallback commentary when process audit fails", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(extractionResponse)
      .mockResolvedValueOnce({
        data: { finalAnswerJudgements: [{ subquestionId: "Q1", status: "correct", evidenceLineIds: ["L1"], studentAnswer: "x=2", referenceAnswer: "x=2", reason: "答案一致", confidence: 0.99 }] },
        durationMs: 12,
        outputMode: "json_schema"
      })
      .mockResolvedValueOnce({
        data: {
          decisions: [
            { subquestionId: "Q1", pointId: "P1", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=1+1", reason: "公式正确", confidence: 0.98, requiresReview: false, reviewReason: "" },
            { subquestionId: "Q1", pointId: "P2", status: "insufficient_evidence", evidenceLineIds: ["L1"], evidenceQuote: "x=2", reason: "书写略有覆盖", confidence: 0.6, requiresReview: true, reviewReason: "需核对原卷" }
          ],
          appliedDeductions: []
        },
        durationMs: 14,
        outputMode: "json_schema"
      });

    const { result } = await gradeStudentAnswer(config, {
      id: "commentary-fallback", studentId: "S3", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: Buffer.from("image"), rubric
    });

    expect(result.score).toBe(2);
    expect(result.maximumPossibleScore).toBe(2);
    expect(result.status).toBe("needs_review");
    expect(result.reviewPolicy).toEqual({
      unreadableScoreThreshold: 2,
      unreadableAffectedScore: 0,
      unreadableReviewTriggered: false
    });
    expect(result.teacherCommentary?.status).toBe("fallback");
    expect(result.teacherCommentary?.auditConcerns).toHaveLength(2);
  });

  it("sanitizes commentary references against the actual scoring decisions", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(extractionResponse)
      .mockResolvedValueOnce({
        data: { finalAnswerJudgements: [{ subquestionId: "Q1", status: "incorrect", evidenceLineIds: ["L1"], studentAnswer: "x=3", referenceAnswer: "x=2", reason: "结果不同", confidence: 0.99 }] },
        durationMs: 12,
        outputMode: "json_schema"
      })
      .mockResolvedValueOnce({
        data: {
          decisions: [
            { subquestionId: "Q1", pointId: "P1", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=1+1", reason: "公式正确", confidence: 0.98, requiresReview: false, reviewReason: "" },
            { subquestionId: "Q1", pointId: "P2", status: "not_satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=3", reason: "结果错误", confidence: 0.98, requiresReview: false, reviewReason: "" }
          ],
          appliedDeductions: [],
          teacherCommentary: {
            overallComment: "模型随意生成的总结",
            strengths: [],
            lostPoints: [
              { subquestionId: "Q1", pointId: "P2", scoreLost: 99, reason: "伪造原因", evidenceLineIds: ["fake"] },
              { subquestionId: "Q1", pointId: "UNKNOWN", scoreLost: 1, reason: "不存在", evidenceLineIds: [] }
            ],
            auditConcerns: [
              { subquestionId: "Q1", pointId: "P2", kind: "uncertain_evidence", reason: "伪造提醒", evidenceLineIds: ["fake"] },
              { subquestionId: "Q1", pointId: "UNKNOWN", kind: "confirmed_issue", reason: "不存在", evidenceLineIds: [] }
            ],
            reviewItems: ["模型新增的复核事项"],
            basedOnDecisionIds: ["Q1:P1", "Q1:P2", "Q1:UNKNOWN"]
          }
        },
        durationMs: 14,
        outputMode: "json_schema"
      });

    const { result } = await gradeStudentAnswer(config, {
      id: "commentary-sanitize", studentId: "S4", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: Buffer.from("image"), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(3);
    expect(result.teacherCommentary?.lostPoints).toEqual([{
      subquestionId: "Q1",
      pointId: "P2",
      scoreLost: 1,
      reason: "结果错误",
      evidenceLineIds: ["L1"]
    }]);
    expect(result.teacherCommentary?.auditConcerns).toEqual([{
      subquestionId: "Q1",
      pointId: "P2",
      kind: "confirmed_issue",
      reason: "结果错误",
      evidenceLineIds: ["L1"]
    }]);
    expect(result.teacherCommentary?.basedOnDecisionIds).toEqual(["Q1:P1", "Q1:P2"]);
    expect(result.teacherCommentary?.reviewItems).toEqual(result.reviewReasons);
  });
});

describe("small-question staged vision grading pipeline", () => {
  const smallRubric: Rubric = { ...structuredClone(rubric), questionType: "small" };

  beforeEach(() => {
    vi.mocked(callStructured).mockReset();
    vi.mocked(runPaddleOcr).mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  function mockLayoutResponse(blanks: Array<{
    subquestionId: string;
    coordinate: [number, number, number, number] | null;
    hasAnswer: boolean;
  }> = [
    { subquestionId: "Q1", coordinate: [100, 200, 300, 400], hasAnswer: true }
  ]) {
    return {
      data: { blanks },
      durationMs: 15,
      outputMode: "json_schema" as const
    };
  }

  function mockBlindTranscriptionResponse(extractedAnswer = "x=2", confidence = 0.98, visualNotes = "清晰手写") {
    return {
      data: { extractedAnswer, confidence, visualNotes },
      durationMs: 12,
      outputMode: "json_schema" as const
    };
  }

  function mockSkepticAssessmentResponse(
    extractedAnswer = "x=2",
    status: "correct" | "incorrect" = "correct",
    issues: string[] = [],
    reason = "符合参考答案",
    confidence = 0.98
  ) {
    return {
      data: { extractedAnswer, status, confidence, issues, reason },
      durationMs: 12,
      outputMode: "json_schema" as const
    };
  }

  function mockEscalatedReviewResponse(
    finalExtractedAnswer = "x=2",
    status: "correct" | "incorrect" | "uncertain" | "missing" = "correct",
    confidence = 0.97,
    visualAnalysis = "微观笔画清晰",
    resolutionReason = "终审确认为x=2"
  ) {
    return {
      data: {
        finalExtractedAnswer,
        status,
        confidence,
        visualAnalysis,
        resolutionReason
      },
      durationMs: 25,
      outputMode: "json_schema" as const
    };
  }

  async function createTestImageBuffer(): Promise<Buffer> {
    return sharp({
      create: {
        width: 120,
        height: 80,
        channels: 3,
        background: { r: 245, g: 245, b: 245 }
      }
    }).composite([{
      input: Buffer.from('<svg width="120" height="80"><text x="20" y="40" font-size="20">x=2</text></svg>')
    }]).png().toBuffer();
  }

  it("always uses staged layout, blind transcription, and skeptic assessment without PaddleOCR", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(mockLayoutResponse())
      .mockResolvedValueOnce(mockBlindTranscriptionResponse("x=2"))
      .mockResolvedValueOnce(mockSkepticAssessmentResponse("x=2", "correct"));

    const answerBytes = await createTestImageBuffer();
    const questionImage = { mimeType: "image/png", base64: "question-image", label: "[题目图片]" };
    const referenceImage = { mimeType: "image/png", base64: "reference-image", label: "[参考答案图片]" };
    const { result } = await gradeStudentAnswer({ ...config, gradingMode: "vision_direct" }, {
      id: "small-correct", studentId: "S-small", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: answerBytes, rubric: smallRubric,
      questionText: "CONFIDENTIAL_QUESTION_TEXT", referenceText: "CONFIDENTIAL_REFERENCE_TEXT",
      questionImages: [questionImage], referenceImages: [referenceImage]
    });

    expect(runPaddleOcr).not.toHaveBeenCalled();
    expect(callStructured).toHaveBeenCalledTimes(3);
    expect(vi.mocked(callStructured).mock.calls.map((call) => call[1].schemaName)).toEqual([
      "small_question_blank_layout",
      "small_question_blind_transcriber",
      "small_question_skeptic_assessor"
    ]);

    const blindRequest = vi.mocked(callStructured).mock.calls[1][1];
    expect(blindRequest.system).not.toContain("CONFIDENTIAL_REFERENCE_TEXT");
    expect(blindRequest.prompt).not.toContain("CONFIDENTIAL_REFERENCE_TEXT");

    const skepticRequest = vi.mocked(callStructured).mock.calls[2][1];
    expect(skepticRequest.prompt).toContain("x=2");

    expect(result.score).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.gradingPipeline).toBe("small_question_staged");
    expect(result.ocrAudit).toBeUndefined();
    expect(result.smallQuestionAudit).toBeDefined();
    expect(result.smallQuestionAudit?.recognitions[0].comparisonStatus).toBe("consensus");
    expect(result.smallQuestionAudit?.recognitions[0].decisionSource).toBe("consensus_ab");
  });

  it("preprocesses the student image before blank layout detection", async () => {
    vi.stubEnv("HENGZHUN_STUDENT_IMAGE_PREPROCESSING", "dual");
    vi.mocked(callStructured)
      .mockResolvedValueOnce(mockLayoutResponse())
      .mockResolvedValueOnce(mockBlindTranscriptionResponse("x=2"))
      .mockResolvedValueOnce(mockSkepticAssessmentResponse("x=2", "correct"));

    const answerBytes = await createTestImageBuffer();

    const { result } = await gradeStudentAnswer(config, {
      id: "small-preprocessed", studentId: "S-preprocessed", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: answerBytes, rubric: smallRubric
    });

    expect(runPaddleOcr).not.toHaveBeenCalled();
    expect(result.imagePreprocessAudit).toMatchObject({ mode: "enhanced", applied: true, geometryPreserved: true });
    const layoutRequest = vi.mocked(callStructured).mock.calls[0]?.[1];
    expect(layoutRequest?.images).toHaveLength(1);
    expect(layoutRequest?.images?.[0]?.label).toContain("本地预处理结果");
  });

  it("awards 0 score for incorrect final answer when both recognitions agree and does not trust a model total", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(mockLayoutResponse())
      .mockResolvedValueOnce(mockBlindTranscriptionResponse("x=3"))
      .mockResolvedValueOnce(mockSkepticAssessmentResponse("x=3", "incorrect", [], "与参考答案x=2不符"))
      .mockResolvedValueOnce(mockEscalatedReviewResponse("x=3", "incorrect", 0.99, "计算错误", "确认写的是x=3，与参考答案x=2不符"));

    const answerBytes = await createTestImageBuffer();
    const { result } = await gradeStudentAnswer(config, {
      id: "small-partial", studentId: "S-partial", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: answerBytes, rubric: smallRubric
    });

    expect(result.score).toBe(0);
    expect(result.maxScore).toBe(2);
    expect(result.subquestions[0].finalAnswerStatus).toBe("incorrect");
    expect(result.status).toBe("completed");
  });

  it("escalates to Request C when skeptic assessor marks incorrect and respects escalated review decision", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(mockLayoutResponse())
      .mockResolvedValueOnce(mockBlindTranscriptionResponse("x=2.0"))
      .mockResolvedValueOnce(mockSkepticAssessmentResponse("x=2.0", "incorrect", [], "与字符串x=2不符"))
      .mockResolvedValueOnce(mockEscalatedReviewResponse("x=2.0", "correct", 0.98, "微观审阅与物理规则确认x=2.0与x=2等价", "终审判定为正确"));

    const answerBytes = await createTestImageBuffer();
    const { result } = await gradeStudentAnswer(config, {
      id: "small-equiv", studentId: "S-equiv", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: answerBytes, rubric: smallRubric
    });

    expect(result.score).toBe(2);
    expect(result.subquestions[0].finalAnswerStatus).toBe("correct");
    expect(result.subquestions[0].finalAnswerDecisionSource).toBe("visual_local_review");
    expect(callStructured).toHaveBeenCalledTimes(4);
  });

  it("escalates to Request C when Blind A and Skeptic B diverge", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(mockLayoutResponse())
      .mockResolvedValueOnce(mockBlindTranscriptionResponse("x=3", 0.85, "字迹有轻微涂改"))
      .mockResolvedValueOnce(mockSkepticAssessmentResponse("x=2", "correct", ["字迹有涂改疑点"], "可能是2", 0.8))
      .mockResolvedValueOnce(mockEscalatedReviewResponse("x=2", "correct", 0.98, "微观分析确认学生书写为x=2", "终审判定为正确"));

    const answerBytes = await createTestImageBuffer();
    const { result } = await gradeStudentAnswer(config, {
      id: "small-arbitration-override", studentId: "S-arb-override", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: answerBytes, rubric: smallRubric
    });

    expect(callStructured).toHaveBeenCalledTimes(4);
    expect(vi.mocked(callStructured).mock.calls[3][1].schemaName).toBe("small_question_escalated_review");
    expect(result.score).toBe(2);
    expect(result.subquestions[0].finalAnswerStatus).toBe("correct");
    expect(result.smallQuestionAudit?.recognitions[0].comparisonStatus).toBe("discrepancy");
    expect(result.smallQuestionAudit?.recognitions[0].decisionSource).toBe("escalated_review_c");
  });

  it("handles blank without handwritten answer without calling recognitions and scores 0", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(mockLayoutResponse([
        { subquestionId: "Q1", coordinate: null, hasAnswer: false }
      ]));

    const answerBytes = await createTestImageBuffer();
    const { result } = await gradeStudentAnswer(config, {
      id: "small-missing", studentId: "S-missing", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: answerBytes, rubric: smallRubric
    });

    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(result.score).toBe(0);
    expect(result.subquestions[0].finalAnswerStatus).toBe("missing");
    expect(result.status).toBe("completed");
  });

  it("marks needs_review when escalated review is uncertain", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(mockLayoutResponse())
      .mockResolvedValueOnce(mockBlindTranscriptionResponse("x=?", 0.4, "关键数字严重涂改"))
      .mockResolvedValueOnce(mockSkepticAssessmentResponse("x=2", "correct", ["严重涂改"], "存疑", 0.6))
      .mockResolvedValueOnce(mockEscalatedReviewResponse("x=?", "uncertain", 0.5, "笔画完全重叠无法辨识", "字迹无法确认"));

    const answerBytes = await createTestImageBuffer();
    const { result } = await gradeStudentAnswer(config, {
      id: "small-review", studentId: "S-review", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: answerBytes, rubric: smallRubric
    });

    expect(callStructured).toHaveBeenCalledTimes(4);
    expect(result.status).toBe("needs_review");
    expect(result.reviewReasons.join(" ")).toContain("字迹无法确认");
  });

  it("does not call recognitions when layout detection fails", async () => {
    vi.mocked(callStructured).mockRejectedValueOnce(new Error("版面检测模型网络失败"));

    const answerBytes = await createTestImageBuffer();
    await expect(gradeStudentAnswer(config, {
      id: "small-layout-failed", studentId: "S-failed", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: answerBytes, rubric: smallRubric
    })).rejects.toThrow("版面检测模型网络失败");
    expect(callStructured).toHaveBeenCalledTimes(1);
  });

  it("fails when escalated review fails during divergence", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(mockLayoutResponse())
      .mockResolvedValueOnce(mockBlindTranscriptionResponse("x=3"))
      .mockResolvedValueOnce(mockSkepticAssessmentResponse("x=2", "correct"))
      .mockRejectedValueOnce(new Error("终审模型响应超时"));

    const answerBytes = await createTestImageBuffer();
    await expect(gradeStudentAnswer(config, {
      id: "small-escalation-failed", studentId: "S-failed", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: answerBytes, rubric: smallRubric
    })).rejects.toThrow("终审模型响应超时");
    expect(callStructured).toHaveBeenCalledTimes(4);
  });

  it("reruns the small-question staged chain for a regrade and keeps lineage metadata", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(mockLayoutResponse())
      .mockResolvedValueOnce(mockBlindTranscriptionResponse("x=2"))
      .mockResolvedValueOnce(mockSkepticAssessmentResponse("x=2", "correct"));

    const answerBytes = await createTestImageBuffer();
    const { result } = await gradeStudentAnswer(config, {
      id: "small-regrade-v2",
      studentId: "S-regrade",
      fileName: "answer.png",
      mimeType: "image/png",
      imageBuffer: answerBytes,
      rubric: smallRubric,
      previousResultId: "small-regrade-v1",
      regradedAt: "2026-08-28T12:00:00.000Z",
      regradeReason: "重新核对小题识别"
    });

    expect(runPaddleOcr).not.toHaveBeenCalled();
    expect(result.previousResultId).toBe("small-regrade-v1");
    expect(result.regradedAt).toBe("2026-08-28T12:00:00.000Z");
    expect(result.regradeReason).toBe("重新核对小题识别");
    expect(result.gradingPipeline).toBe("small_question_staged");
    expect(result.smallQuestionAudit).toBeDefined();
  });
});

describe("large-question staged answer triage and conditional reviews", () => {
  const stagedRubric: Rubric = {
    ...structuredClone(rubric),
    title: "物理大题首轮答案核验测试",
    totalScore: 3,
    subquestions: [{
      ...structuredClone(rubric.subquestions[0]),
      id: "Q1",
      title: "（1）木板速度",
      maxScore: 3,
      finalAnswers: [{ expression: "v_1=\\frac{\\sqrt{10}}5", unit: "m/s" }],
      scorePoints: [
        { id: "P1", title: "受力关系", description: "写出受力关系", score: 1, type: "formula", expected: "f=\\mu mg" },
        { id: "P2", title: "加速度关系", description: "写出加速度关系", score: 1, type: "formula", expected: "a=\\mu g" },
        { id: "P3", title: "最终数值", description: "读出最终数值", score: 1, type: "result", expected: "5" }
      ],
      deductions: []
    }]
  };

  const expectedFinalAnswer = "v_1=\\frac{\\sqrt{10}}5 m/s";
  const wrongFinalAnswer = "v_1=\\frac{\\sqrt{10}}3 m/s";
  const stagedConfig: ModelConfigInput = {
    ...config,
    gradingMode: "vision_direct",
    reviewModel: "review-vision",
    reviewApiKey: "review-key",
    reviewBaseUrl: "https://review.example.test/v1"
  };

  function bboxOcrAudit() {
    return {
      ...directOcrAudit,
      markdownText: "OCR block-00: 受力关系；OCR block-01: v₁=√10/3 m/s",
      layoutBlocks: [
        { blockId: "block-00", pageIndex: 0, label: "inline_formula", score: 0.93, coordinate: [5, 5, 20, 20] as [number, number, number, number], polygonPoints: [[5, 5], [20, 5], [20, 20], [5, 20]] as Array<[number, number]>, order: 0 },
        { blockId: "block-01", pageIndex: 0, label: "inline_formula", score: 0.92, coordinate: [25, 10, 50, 25] as [number, number, number, number], polygonPoints: [[25, 10], [50, 10], [50, 25], [25, 25]] as Array<[number, number]>, order: 1 }
      ]
    };
  }

  function triageResponse(
    status: "correct" | "incorrect" | "missing" | "uncertain",
    studentAnswer: string,
    blockIds = ["block-01"],
    confidence = 0.96,
    transcriptionBlockIds = ["block-00", "block-01"]
  ) {
    return {
      data: {
        answers: [{
          subquestionId: "Q1",
          blockIds,
          status,
          studentAnswer,
          confidence,
          reason: status === "correct" ? "最终答案与评分标准一致" : "首轮读数需要独立核对"
        }],
        transcription: {
          lines: transcriptionBlockIds.map((blockId) => blockId === "block-00"
            ? { blockId, text: "受力关系", latex: "", status: "active" as const, confidence: 0.93, alternatives: [] }
            : { blockId, text: "v₁=√10/3 m/s", latex: "v_1=\\frac{\\sqrt{10}}3\\,m/s", status: "active" as const, confidence: 0.92, alternatives: [] })
        }
      },
      durationMs: 20,
      outputMode: "json_schema" as const
    };
  }

  function localReviewResponse(
    result: string,
    certainty: "clear" | "uncertain" | "insufficient_visual_evidence" = "clear"
  ) {
    return {
      data: {
        reviews: [{
          review_id: "auto-final-answer-Q1",
          result,
          certainty,
          reason: certainty === "clear" ? "局部原图已确认" : "局部原图仍无法可靠区分"
        }]
      },
      durationMs: 9,
      outputMode: "json_schema" as const
    };
  }

  function pointReviewResponse(status: "not_present" | "unreadable" = "not_present") {
    return {
      data: {
        reviews: [{
          subquestionId: "Q1",
          decisions: stagedRubric.subquestions[0].scorePoints.map((point) => ({
            pointId: point.id,
            status,
            evidenceBlockIds: status === "unreadable" ? ["block-01"] : ["block-00"],
            evidenceQuote: "",
            reason: status === "unreadable" ? "局部笔迹无法可靠辨认" : "已在整页图逐个检查所有区块，未发现相关作答",
            confidence: status === "unreadable" ? 0.35 : 0.9
          })),
          appliedDeductions: []
        }]
      },
      durationMs: 11,
      outputMode: "json_schema" as const
    };
  }

  function wholePagePointReviewResponse() {
    return {
      data: {
        reviews: [{
          subquestionId: "Q1",
          decisions: stagedRubric.subquestions[0].scorePoints.map((point) => ({
            pointId: point.id,
            status: "satisfied" as const,
            evidenceBlockIds: ["block-00"],
            evidenceQuote: point.id === "P1" ? "f=μmg" : point.id === "P2" ? "a=μg" : "v₁=√10/5 m/s",
            reason: "整页图中找到实际卷面证据",
            confidence: 0.9
          })),
          appliedDeductions: []
        }]
      },
      durationMs: 11,
      outputMode: "json_schema" as const
    };
  }

  function installStagedResponses(options: {
    triage: ReturnType<typeof triageResponse>;
    local?: ReturnType<typeof localReviewResponse>;
    point?: ReturnType<typeof pointReviewResponse> | ReturnType<typeof wholePagePointReviewResponse>;
    pointError?: string;
  }) {
    vi.mocked(callStructured).mockImplementation(async (_modelConfig, request) => {
      let response: {
        data: unknown;
        durationMs: number;
        outputMode: string;
      };
      if (request.schemaName === "large_question_answer_triage") {
        response = options.triage;
      } else if (request.schemaName === "direct_visual_review") {
        if (!options.local) throw new Error("测试未配置局部视觉复核结果");
        response = options.local;
      } else if (request.schemaName === "large_question_point_review") {
        if (options.pointError) throw new Error(options.pointError);
        if (!options.point) throw new Error("测试未配置小分审验结果");
        response = options.point;
      } else {
        throw new Error("意外的模型 schema：" + request.schemaName);
      }
      return {
        data: request.validate ? request.validate(response.data) : response.data,
        durationMs: response.durationMs,
        outputMode: response.outputMode
      };
    });
  }

  async function runCase(id: string, overrides: Partial<ModelConfigInput> = {}, rubricOverride: Rubric = stagedRubric) {
    return gradeStudentAnswer({ ...stagedConfig, ...overrides }, {
      id,
      studentId: "S-" + id,
      fileName: "answer.png",
      mimeType: "image/png",
      imageBuffer: await createTestAnswerImage(),
      rubric: rubricOverride
    });
  }

  beforeEach(() => {
    vi.mocked(callStructured).mockReset();
    vi.mocked(runPaddleOcr).mockReset().mockResolvedValue(bboxOcrAudit());
  });

  it("清晰正确时只调用一次首轮教师模型，并直接给满分", async () => {
    installStagedResponses({ triage: triageResponse("correct", expectedFinalAnswer) });

    const { result, artifactSource } = await runCase("staged-clear-correct");

    expect(runPaddleOcr).toHaveBeenCalledTimes(1);
    expect(callStructured).toHaveBeenCalledTimes(1);
    const request = vi.mocked(callStructured).mock.calls[0][1];
    expect(request.schemaName).toBe("large_question_answer_triage");
    expect(request.prompt).toContain("transcription.lines 恰好逐个覆盖");
    expect(request.prompt).not.toContain("不要输出 transcription");
    expect(request.prompt).toContain("block-00");
    expect(result.score).toBe(3);
    expect(result.status).toBe("completed");
    expect(artifactSource?.subquestionCrops).toBeDefined();
    expect(artifactSource?.subquestionCrops?.length).toBe(1);
    expect(artifactSource?.subquestionCrops?.[0]?.fileName).toContain("subquestion-Q1-crop.webp");
    expect(result.subquestions[0]).toMatchObject({
      score: 3,
      maxScore: 3,
      finalAnswerStatus: "correct",
      finalAnswerDecisionSource: "teacher_model"
    });
    expect(result.subquestions[0].decisions.every((decision) => decision.decisionSource === "final_answer_authority")).toBe(true);
    expect(result.directVisualReviewAudit).toMatchObject({
      reviewRequired: false,
      reviewItems: [],
      results: [],
      initialScore: 3,
      finalScore: 3
    });
    expect(result.ocrTranscription).toMatchObject({
      blockCount: 2,
      verifiedBlockCount: 2,
      missingBlockIds: []
    });
  });

  it("作用主体反转导致的功的符号差异不会直接落为错误", async () => {
    const signRubric: Rubric = {
      ...structuredClone(stagedRubric),
      subquestions: [{
        ...structuredClone(stagedRubric.subquestions[0]),
        finalAnswers: [{
          expression: "W=-10",
          unit: "J",
          signPolicy: "role_reversal",
          subject: "外力对系统做功"
        }]
      }]
    };
    installStagedResponses({
      triage: triageResponse("incorrect", "系统对外做功10J"),
      local: localReviewResponse("系统对外做功10J"),
      point: pointReviewResponse()
    });

    const { result } = await runCase("staged-role-reversal-sign", {}, signRubric);

    expect(result.score).toBe(3);
    expect(result.subquestions[0].finalAnswerStatus).toBe("correct");
    expect(result.reviewReasons.join("\n")).toContain("符号约定");
  });

  it("缓存 OCR 回放走完整大题链路但不重新请求 PaddleOCR", async () => {
    installStagedResponses({ triage: triageResponse("correct", expectedFinalAnswer) });
    const replayAudit = bboxOcrAudit();

    const { result } = await gradeStudentAnswer({ ...stagedConfig }, {
      id: "staged-cached-ocr",
      studentId: "S-staged-cached-ocr",
      fileName: "answer.png",
      mimeType: "image/png",
      imageBuffer: await createTestAnswerImage(),
      rubric: stagedRubric,
      ocrAudit: replayAudit
    });

    expect(runPaddleOcr).not.toHaveBeenCalled();
    expect(result.ocrAudit).toMatchObject({ source: "cached_replay", jobId: replayAudit.jobId });
    expect(result.score).toBe(3);
    expect(result.status).toBe("completed");
  });

  it("首轮转录漏掉 OCR 区块时保留分数但标记转录复核", async () => {
    installStagedResponses({
      triage: triageResponse("correct", expectedFinalAnswer, ["block-01"], 0.96, ["block-01"])
    });

    const { result } = await runCase("staged-incomplete-transcription");

    expect(result.ocrTranscription).toMatchObject({
      blockCount: 2,
      verifiedBlockCount: 1,
      missingBlockIds: ["block-00"]
    });
    expect(result.score).toBe(3);
    expect(result.status).toBe("needs_review");
    expect(result.reviewReasons.join("\n")).toContain("教师模型未返回 1 个 OCR 区块的转录");
  });

  it("首轮判错时并行执行局部最终答案复核和小分审验，并可纠正根式分式误读", async () => {
    installStagedResponses({
      triage: triageResponse("incorrect", wrongFinalAnswer),
      local: localReviewResponse(expectedFinalAnswer),
      point: pointReviewResponse()
    });

    const { result } = await runCase("staged-wrong-corrected");

    expect(callStructured).toHaveBeenCalledTimes(3);
    expect(vi.mocked(callStructured).mock.calls.map((call) => call[1].schemaName).sort()).toEqual([
      "direct_visual_review",
      "large_question_answer_triage",
      "large_question_point_review"
    ].sort());
    const localRequest = vi.mocked(callStructured).mock.calls.find((call) => call[1].schemaName === "direct_visual_review")?.[1];
    const pointRequest = vi.mocked(callStructured).mock.calls.find((call) => call[1].schemaName === "large_question_point_review")?.[1];
    expect(localRequest?.images).toHaveLength(3);
    expect(localRequest?.images?.[0]?.label).toContain("block-01");
    expect(localRequest?.images?.[1]?.label).toContain("bbox定位索引图");
    expect(localRequest?.prompt).toContain("候选集合");
    expect(localRequest?.prompt).not.toContain("score_effect");
    expect(localRequest?.prompt).not.toContain("maxScore");
    expect(pointRequest?.prompt).toContain("P1");
    expect(pointRequest?.system).toContain("不要重新判定最终答案");
    expect(pointRequest?.prompt).toContain("评分标准");
    expect(result.score).toBe(3);
    expect(result.status).toBe("completed");
    expect(result.directVisualReviewAudit).toMatchObject({
      reviewRequired: true,
      reviewItems: [{ reviewId: "auto-final-answer-Q1", blockId: "block-01" }],
      results: [{ reviewId: "auto-final-answer-Q1", result: expectedFinalAnswer, certainty: "clear" }],
      initialScore: 0,
      finalScore: 3
    });
    expect(result.subquestions[0]).toMatchObject({
      score: 3,
      finalAnswerStatus: "correct",
      finalAnswerDecisionSource: "visual_local_review",
      studentFinalAnswer: expectedFinalAnswer
    });
    expect(result.subquestions[0].finalAnswerReason).toBe(
      `首轮识别为“${wrongFinalAnswer}”；局部视觉复核确认最终答案为“${expectedFinalAnswer}”。`,
    );
  });

  it("局部视觉复核返回候选集之外的真实新转录时动态判分并采纳真实转录", async () => {
    const unlistedRealAnswer = "v_1=\\frac{\\sqrt{2}}3 m/s";
    installStagedResponses({
      triage: triageResponse("incorrect", wrongFinalAnswer),
      local: localReviewResponse(unlistedRealAnswer),
      point: pointReviewResponse()
    });

    const { result } = await runCase("staged-unlisted-real-answer");

    expect(result.subquestions[0]).toMatchObject({
      score: 0,
      finalAnswerStatus: "incorrect",
      finalAnswerDecisionSource: "visual_local_review",
      studentFinalAnswer: unlistedRealAnswer
    });
    expect(result.subquestions[0].finalAnswerReason).toBe(
      `首轮识别为“${wrongFinalAnswer}”；局部视觉复核确认最终答案为“${unlistedRealAnswer}”。`
    );
    expect(result.directVisualReviewAudit?.results[0]).toMatchObject({
      reviewId: "auto-final-answer-Q1",
      result: unlistedRealAnswer,
      certainty: "clear"
    });
  });

  it("小分审验在整页图中查找证据，首轮 blockId 只作为定位提示", async () => {
    installStagedResponses({
      triage: triageResponse("incorrect", wrongFinalAnswer, ["block-01"]),
      local: localReviewResponse(expectedFinalAnswer),
      point: wholePagePointReviewResponse()
    });

    const { result } = await runCase("staged-whole-page-point-evidence");

    const pointRequest = vi.mocked(callStructured).mock.calls.find((call) => call[1].schemaName === "large_question_point_review")?.[1];
    expect(pointRequest?.system).toContain("不受首轮定位提示限制");
    expect(pointRequest?.prompt).toContain("不是“允许引用范围”");
    expect(pointRequest?.prompt).not.toContain("allowedBlockIds");
    expect(pointRequest?.images).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "[学生答卷图（预处理后小分审验上下文）]" })
    ]));
    expect(result.evidence.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "point-review-Q1-point-P1-block-00", text: "f=μmg", region: [5, 5, 15, 15] })
    ]));
    expect(result.subquestions[0]?.decisions.find((decision) => decision.pointId === "P1")?.evidenceLineIds)
      .toContain("point-review-Q1-point-P1-block-00");
    expect(result.reviewReasons.join("\n")).not.toContain("不属于该小问");
  });

  it("首轮判空时仍发起局部复核，复核确认答案存在后给满分", async () => {
    installStagedResponses({
      triage: triageResponse("missing", "", ["block-01"]),
      local: localReviewResponse(expectedFinalAnswer),
      point: pointReviewResponse()
    });

    const { result } = await runCase("staged-missing-correct");

    expect(callStructured).toHaveBeenCalledTimes(3);
    const localRequest = vi.mocked(callStructured).mock.calls.find((call) => call[1].schemaName === "direct_visual_review")?.[1];
    expect(localRequest?.prompt).toContain("未写出最终答案");
    expect(result.score).toBe(3);
    expect(result.status).toBe("completed");
    expect(result.subquestions[0]).toMatchObject({
      finalAnswerStatus: "correct",
      finalAnswerDecisionSource: "visual_local_review"
    });
  });

  it("首轮判空且没有 OCR 区块绑定时锁定为无有效作答并跳过局部复核", async () => {
    installStagedResponses({
      triage: triageResponse("missing", "", []),
      local: localReviewResponse(expectedFinalAnswer),
      point: pointReviewResponse()
    });

    const { result } = await runCase("staged-missing-unmapped-correct");

    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callStructured).mock.calls.some((call) => call[1].schemaName === "direct_visual_review")).toBe(false);
    expect(result.score).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.scoreResolved).toBe(true);
    expect(result.reviewReasons).toEqual([]);
    expect(result.subquestions[0]).toMatchObject({
      finalAnswerStatus: "missing",
      finalAnswerDecisionSource: "teacher_model"
    });
    expect(result.subquestions[0]?.decisions.every((decision) => decision.requiresReview === false)).toBe(true);
  });

  it("局部视觉复核不确定时只添加人工复核标记，不阻断并返回当前分数", async () => {
    installStagedResponses({
      triage: triageResponse("incorrect", wrongFinalAnswer),
      local: localReviewResponse("uncertain", "insufficient_visual_evidence"),
      point: pointReviewResponse()
    });

    const { result } = await runCase("staged-local-uncertain");

    expect(callStructured).toHaveBeenCalledTimes(3);
    expect(result.score).toBe(0);
    expect(result.status).toBe("needs_review");
    expect(result.maximumPossibleScore).toBe(0);
    expect(result.subquestions[0]).toMatchObject({
      finalAnswerStatus: "uncertain",
      finalAnswerDecisionSource: "visual_local_review"
    });
    expect(result.directVisualReviewAudit?.results[0]).toMatchObject({
      reviewId: "auto-final-answer-Q1",
      certainty: "insufficient_visual_evidence"
    });
    expect(result.reviewReasons.join("\n")).toContain("需要人工复核");
  });

  it("小分审验失败时只保留人工复核标记，仍完成写分所需的评分结果", async () => {
    installStagedResponses({
      triage: triageResponse("incorrect", wrongFinalAnswer),
      local: localReviewResponse(expectedFinalAnswer),
      pointError: "小分审验服务失败"
    });

    const { result } = await runCase("staged-point-review-failed");

    expect(callStructured).toHaveBeenCalledTimes(3);
    expect(result.score).toBe(3);
    expect(result.status).toBe("needs_review");
    expect(result.reviewReasons.join("\n")).toContain("小分审验调用失败");
    expect(result.subquestions[0]).toMatchObject({
      score: 3,
      finalAnswerStatus: "correct"
    });
  });

  it("局部复核确认确实没有最终答案时，结果为缺失而不是伪造的普通错误", async () => {
    installStagedResponses({
      triage: triageResponse("missing", "", ["block-01"]),
      local: localReviewResponse("未写出最终答案"),
      point: pointReviewResponse()
    });

    const { result } = await runCase("staged-missing-confirmed");

    expect(callStructured).toHaveBeenCalledTimes(3);
    expect(result.score).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.subquestions[0]).toMatchObject({
      finalAnswerStatus: "missing",
      finalAnswerDecisionSource: "visual_local_review"
    });
  });

  it("小分判空没有可定位搜索区块和缺失说明时强制复核", async () => {
    const unauditedPointReview = pointReviewResponse();
    for (const decision of unauditedPointReview.data.reviews[0].decisions) {
      decision.evidenceBlockIds = [];
      decision.reason = "没有";
    }
    installStagedResponses({
      triage: triageResponse("missing", "", ["block-01"]),
      local: localReviewResponse("未写出最终答案"),
      point: unauditedPointReview
    });

    const { result } = await runCase("staged-missing-without-audit");

    expect(result.status).toBe("needs_review");
    expect(result.subquestions[0].decisions.every((decision) => decision.status === "unreadable")).toBe(true);
    expect(result.reviewReasons.join("\n")).toContain("缺失审验依据");
  });
});

describe("large-question workflow selector", () => {
  beforeEach(() => {
    vi.mocked(callStructured).mockReset();
    vi.mocked(runPaddleOcr).mockReset();
    vi.mocked(gradeLargeQuestionResponsesAgent).mockReset();
  });

  function inputFor(questionType: "large" | "small" = "large") {
    return {
      id: `workflow-${questionType}`,
      studentId: "workflow-student",
      fileName: "answer.png",
      mimeType: "image/png",
      imageBuffer: Buffer.from("image-not-decoded-by-agent-test"),
      rubric: { ...structuredClone(rubric), questionType }
    };
  }

  it("routes only a large question with responses_agent to the Agent and skips PaddleOCR", async () => {
    const agentResult = {
      id: "agent-result",
      studentId: "workflow-student",
      fileName: "answer.png",
      score: 2,
      maxScore: 2,
      scoreResolved: true,
      status: "completed" as const,
      reviewReasons: [],
      evidence: { lines: [], finalAnswers: [], ambiguities: [] },
      subquestions: [],
      metrics: { ruleCoverage: 1, evidenceTraceability: 1, autoDecisionRate: 1, ambiguityRate: 0, durationMs: 1 },
      modelName: "responses-model",
      gradingPipeline: "large_question_responses_agent" as const,
      rubricVersion: rubric.version
    };
    const artifactSource = {
      preprocessedStudentAnswer: { buffer: Buffer.from("agent-webp"), mimeType: "image/webp", fileName: "answer.webp" },
      questionImages: [],
      referenceImages: [],
      rubric
    };
    vi.mocked(gradeLargeQuestionResponsesAgent).mockResolvedValueOnce({ result: agentResult, artifactSource });

    const result = await gradeStudentAnswer({ ...config, largeQuestionWorkflow: "responses_agent" }, inputFor("large"));

    expect(gradeLargeQuestionResponsesAgent).toHaveBeenCalledTimes(1);
    expect(result.result.gradingPipeline).toBe("large_question_responses_agent");
    expect(runPaddleOcr).not.toHaveBeenCalled();
    expect(callStructured).not.toHaveBeenCalled();
  });

  it("keeps the stable large-question workflow on PaddleOCR when Agent mode is not selected", async () => {
    vi.mocked(runPaddleOcr).mockRejectedValueOnce(new Error("stable PaddleOCR sentinel"));

    await expect(gradeStudentAnswer({ ...config, gradingMode: "vision_direct", largeQuestionWorkflow: "staged" }, inputFor("large")))
      .rejects.toThrow("stable PaddleOCR sentinel");

    expect(runPaddleOcr).toHaveBeenCalledTimes(1);
    expect(gradeLargeQuestionResponsesAgent).not.toHaveBeenCalled();
    expect(callStructured).not.toHaveBeenCalled();
  });

  it("keeps the small-question workflow OCR-free without contacting PaddleOCR", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce({
        data: { blanks: [{ subquestionId: "Q1", coordinate: [100, 200, 300, 400], hasAnswer: true }] },
        durationMs: 10
      } as any)
      .mockResolvedValueOnce({
        data: { extractedAnswer: "x=2", confidence: 0.99, visualNotes: "" },
        durationMs: 10
      } as any)
      .mockResolvedValueOnce({
        data: { extractedAnswer: "x=2", status: "correct", confidence: 0.99, issues: [], reason: "正确" },
        durationMs: 10
      } as any);

    const { result } = await gradeStudentAnswer({ ...config, largeQuestionWorkflow: "responses_agent" }, inputFor("small"));

    expect(runPaddleOcr).not.toHaveBeenCalled();
    expect(result.gradingPipeline).toBe("small_question_staged");
    expect(gradeLargeQuestionResponsesAgent).not.toHaveBeenCalled();
  });
});
