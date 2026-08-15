import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { callStructured } from "./modelClient.js";
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

function directVisionResponse(pointStatus: "satisfied" | "unreadable", contradictoryReview = false) {
  return {
    data: {
      evidence: {
        lines: [{ id: "L1", text: pointStatus === "unreadable" ? "x=?" : "x=2", region: [12, 10, 36, 20], status: pointStatus === "unreadable" ? "uncertain" : "active", confidence: pointStatus === "unreadable" ? 0.45 : 0.99, alternatives: [] }],
        finalAnswers: [],
        ambiguities: pointStatus === "unreadable" ? [{ lineId: "L1", reason: "数字被覆盖", scoreImpact: "possible" }] : []
      },
      finalAnswerJudgements: [{ subquestionId: "Q1", status: "missing", evidenceLineIds: [], studentAnswer: "", referenceAnswer: "x=2", reason: "未见明确最终答案", confidence: 0.95 }],
      decisions: [
        { subquestionId: "Q1", pointId: "P1", status: "not_present", evidenceLineIds: [], evidenceQuote: "", reason: "未见列式", confidence: 0.98, requiresReview: false, reviewReason: "" },
        { subquestionId: "Q1", pointId: "P2", status: pointStatus, evidenceLineIds: ["L1"], evidenceQuote: pointStatus === "unreadable" ? "x=?" : "x=2", reason: pointStatus === "unreadable" ? "关键数字被覆盖" : "结果清楚", confidence: pointStatus === "unreadable" ? 0.45 : 0.99, requiresReview: pointStatus === "unreadable" || contradictoryReview, reviewReason: pointStatus === "unreadable" ? "需要局部复查" : contradictoryReview ? "下标较潦草" : "" }
      ],
      appliedDeductions: [],
      teacherCommentary: commentaryResponse.data
    },
    durationMs: 20,
    outputMode: "json_schema" as const
  };
}

function directNumericResponse(studentAnswer = "x=2") {
  return {
    data: {
      evidence: {
        lines: [{ id: "L1", text: studentAnswer, region: [12, 10, 36, 20], status: "active", confidence: 0.99, alternatives: [] }],
        finalAnswers: [{ subquestionId: "Q1", lineId: "L1", expression: studentAnswer, unit: "", confidence: 0.99 }],
        ambiguities: []
      },
      finalAnswerJudgements: [{ subquestionId: "Q1", status: "correct", evidenceLineIds: ["L1"], studentAnswer, referenceAnswer: "x=2", reason: "最终答案正确", confidence: 0.99 }],
      decisions: [
        { subquestionId: "Q1", pointId: "P1", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: studentAnswer, reason: "作答成立", confidence: 0.98, requiresReview: false, reviewReason: "" },
        { subquestionId: "Q1", pointId: "P2", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: studentAnswer, reason: "结果正确", confidence: 0.99, requiresReview: false, reviewReason: "" }
      ],
      appliedDeductions: [],
      teacherCommentary: commentaryResponse.data
    },
    durationMs: 20,
    outputMode: "json_schema" as const
  };
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

describe("vision-direct unreadable local review", () => {
  beforeEach(() => vi.mocked(callStructured).mockReset());

  it("uses exactly one model call when the direct result has no unreadable target", async () => {
    vi.mocked(callStructured).mockResolvedValueOnce(directVisionResponse("satisfied"));

    const { result } = await gradeStudentAnswer({
      ...config,
      gradingMode: "vision_direct",
      reviewModel: "fast-review",
      reviewApiKey: "review-secret"
    }, {
      id: "direct-readable", studentId: "S5", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: await createTestAnswerImage(), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callStructured).mock.calls[0][1].schemaName).toBe("direct_vision_grading");
    expect(vi.mocked(callStructured).mock.calls[0][1].system).toContain("不能从纯数字算式反推未写出的字母公式");
    expect(vi.mocked(callStructured).mock.calls[0][1].system).toContain("每个 satisfied 的 evidenceQuote 必须逐字引用");
    expect(result.subquestions[0].decisions[1].status).toBe("satisfied");
  });

  it("uses one conditional second call and adopts a clear local-review decision", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(directVisionResponse("unreadable"))
      .mockResolvedValueOnce({
        data: {
          reviews: [{ subquestionId: "Q1", pointId: "P2", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=2", reason: "局部放大后数字2清晰可见", confidence: 0.98, requiresReview: false }],
          finalAnswers: []
        },
        durationMs: 9,
        outputMode: "json_schema"
      });

    const { result } = await gradeStudentAnswer({
      ...config,
      gradingMode: "vision_direct",
      reviewModel: "fast-review",
      reviewApiKey: "review-secret"
    }, {
      id: "direct-reviewed", studentId: "S6", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: await createTestAnswerImage(), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callStructured).mock.calls.map((call) => call[1].schemaName)).toEqual([
      "direct_vision_grading",
      "unreadable_local_review"
    ]);
    expect(vi.mocked(callStructured).mock.calls[1][1].images).toHaveLength(2);
    expect(vi.mocked(callStructured).mock.calls[1][1].system).toContain("只有具体数字组成的算式");
    expect(vi.mocked(callStructured).mock.calls[1][1].prompt).toContain('"type":"result"');
    expect(result.subquestions[0].decisions[1]).toMatchObject({
      status: "satisfied",
      requiresReview: false,
      decisionSource: "unreadable_local_review",
      awardedScore: 1
    });
    expect(result.status).toBe("completed");
  });

  it("locally rechecks a clear decision that also carries a contradictory review flag", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(directVisionResponse("satisfied", true))
      .mockResolvedValueOnce({
        data: {
          reviews: [{ subquestionId: "Q1", pointId: "P2", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "x=2", reason: "局部放大后下标清晰，结果正确", confidence: 0.98, requiresReview: false }],
          finalAnswers: []
        },
        durationMs: 9,
        outputMode: "json_schema"
      });

    const { result } = await gradeStudentAnswer({
      ...config,
      gradingMode: "vision_direct",
      reviewModel: "fast-review",
      reviewApiKey: "review-secret"
    }, {
      id: "direct-conflicting-review", studentId: "S6-conflict", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: await createTestAnswerImage(), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callStructured).mock.calls[1][1].schemaName).toBe("unreadable_local_review");
    expect(vi.mocked(callStructured).mock.calls[1][1].prompt).toContain("明确状态 satisfied 和人工复核标记");
    expect(result.subquestions[0].decisions[1]).toMatchObject({
      status: "satisfied",
      requiresReview: false,
      decisionSource: "unreadable_local_review",
      awardedScore: 1
    });
    expect(result.status).toBe("completed");
  });

  it("keeps the result in mandatory review when the second call is still unreadable", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(directVisionResponse("unreadable"))
      .mockResolvedValueOnce({
        data: {
          reviews: [{ subquestionId: "Q1", pointId: "P2", status: "unreadable", evidenceLineIds: ["L1"], evidenceQuote: "x=?", reason: "放大后关键数字仍被涂改覆盖", confidence: 0.7, requiresReview: true }],
          finalAnswers: []
        },
        durationMs: 9,
        outputMode: "json_schema"
      });

    const { result } = await gradeStudentAnswer({
      ...config,
      gradingMode: "vision_direct",
      reviewModel: "fast-review",
      reviewApiKey: "review-secret",
      unreadableReviewThreshold: 1
    }, {
      id: "direct-still-unreadable", studentId: "S7", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: await createTestAnswerImage(), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(2);
    expect(result.subquestions[0].decisions[1]).toMatchObject({
      status: "unreadable",
      requiresReview: true,
      decisionSource: "unreadable_local_review",
      awardedScore: 0
    });
    expect(result.status).toBe("needs_review");
  });

  it("does not reuse the teacher model when an unreadable target has no independent reviewer", async () => {
    vi.mocked(callStructured).mockResolvedValueOnce(directVisionResponse("unreadable"));

    const { result } = await gradeStudentAnswer({ ...config, gradingMode: "vision_direct", unreadableReviewThreshold: 1 }, {
      id: "direct-no-reviewer", studentId: "S7-no-reviewer", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: await createTestAnswerImage(), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(result.subquestions[0].decisions[1]).toMatchObject({
      status: "unreadable",
      awardedScore: 0
    });
    expect(result.status).toBe("needs_review");
  });
});

describe("vision-direct local numeric answer review", () => {
  beforeEach(() => vi.mocked(callStructured).mockReset());

  it("keeps the teacher decision when the fast review model reads the same number", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(directNumericResponse("x=2"))
      .mockResolvedValueOnce({
        data: {
          reviews: [{
            subquestionId: "Q1",
            observedAnswer: "x=2",
            numericTokens: ["2"],
            status: "readable",
            confidence: 0.98,
            reason: "局部数字清晰"
          }]
        },
        durationMs: 7,
        outputMode: "json_schema"
      });

    const { result } = await gradeStudentAnswer({
      ...config,
      gradingMode: "vision_direct",
      reviewModel: "fast-review",
      reviewBaseUrl: "https://review.example/v1",
      reviewApiKey: "review-secret",
      reviewReasoningEffort: "low"
    }, {
      id: "numeric-confirmed", studentId: "S8", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: await createTestAnswerImage(), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callStructured).mock.calls[1][1]).toMatchObject({
      schemaName: "local_numeric_answer_review",
      model: "fast-review",
      reasoningEffort: "low"
    });
    expect(vi.mocked(callStructured).mock.calls[1][0]).toMatchObject({
      baseUrl: "https://review.example/v1",
      apiKey: "review-secret"
    });
    expect(vi.mocked(callStructured).mock.calls[1][0].apiKey).not.toBe(config.apiKey);
    expect(result.subquestions[0]).toMatchObject({
      finalAnswerStatus: "correct",
      finalAnswerDecisionSource: "teacher_model",
      score: 2
    });
    expect(result.status).toBe("completed");
  });

  it("blocks automatic release when the review model reads a conflicting number", async () => {
    vi.mocked(callStructured)
      .mockResolvedValueOnce(directNumericResponse("x=2"))
      .mockResolvedValueOnce({
        data: {
          reviews: [{
            subquestionId: "Q1",
            observedAnswer: "x=3",
            numericTokens: ["3"],
            status: "readable",
            confidence: 0.97,
            reason: "局部数字清晰"
          }]
        },
        durationMs: 6,
        outputMode: "json_schema"
      });

    const { result } = await gradeStudentAnswer({
      ...config,
      gradingMode: "vision_direct",
      reviewModel: "fast-review",
      reviewBaseUrl: "https://review.example/v1",
      reviewApiKey: "review-secret",
      reviewReasoningEffort: "low"
    }, {
      id: "numeric-conflict", studentId: "S9", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: await createTestAnswerImage(), rubric
    });

    expect(result.subquestions[0]).toMatchObject({
      finalAnswerStatus: "uncertain",
      finalAnswerDecisionSource: "local_numeric_review"
    });
    expect(result.subquestions[0].finalAnswerReason).toContain("教师模型与局部审验模型读取冲突");
    expect(result.reviewReasons.join("\n")).toContain("局部审验结果冲突或无法确认");
    expect(result.status).toBe("needs_review");
  });

  it("never falls back to the teacher API key when review credentials are missing", async () => {
    vi.mocked(callStructured).mockResolvedValueOnce(directNumericResponse("x=2"));

    const { result } = await gradeStudentAnswer({
      ...config,
      gradingMode: "vision_direct",
      reviewModel: "fast-review",
      reviewApiKey: ""
    }, {
      id: "numeric-missing-key", studentId: "S10", fileName: "answer.png", mimeType: "image/png",
      imageBuffer: await createTestAnswerImage(), rubric
    });

    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(result.subquestions[0]).toMatchObject({
      finalAnswerStatus: "uncertain",
      finalAnswerDecisionSource: "local_numeric_review"
    });
    expect(result.subquestions[0].finalAnswerReason).toContain("不会使用教师模型密钥代替");
    expect(result.status).toBe("needs_review");
  });
});
