import { describe, expect, it } from "vitest";
import type { AnswerEvidence, FinalAnswerJudgement, Rubric, RubricDecision } from "../shared/types.js";
import { demoRubric } from "./demoData.js";
import { answerCollectionsEquivalent, calculateGrade, expressionsEquivalent, splitAnswerExpressions } from "./gradingEngine.js";

const baseEvidence: AnswerEvidence = {
  lines: [
    { id: "L1", text: "mgR=1/2mv²", status: "active", confidence: 0.98 },
    { id: "L2", text: "N-mg=mv²/R", status: "active", confidence: 0.98 },
    { id: "L3", text: "N=2mg", status: "active", confidence: 0.98 }
  ],
  finalAnswers: [{ subquestionId: "Q1-1", lineId: "L3", expression: "N=2*m*g", unit: "N", confidence: 0.98 }],
  ambiguities: []
};

function finalJudgement(status: FinalAnswerJudgement["status"], studentAnswer = "N=2mg", confidence = 0.98): FinalAnswerJudgement {
  return {
    subquestionId: "Q1-1",
    status,
    evidenceLineIds: studentAnswer ? ["L3"] : [],
    studentAnswer,
    referenceAnswer: "N=3mg",
    reason: status === "correct" ? "教师确认答案正确" : status === "uncertain" ? "字迹无法确认" : "教师确认答案不正确",
    confidence
  };
}

function decisions(): RubricDecision[] {
  return [
    { subquestionId: "Q1-1", pointId: "P1", status: "satisfied", evidenceLineIds: ["L1"], evidenceQuote: "mgR=1/2mv²", reason: "公式正确", confidence: 0.98, requiresReview: false },
    { subquestionId: "Q1-1", pointId: "P2", status: "satisfied", evidenceLineIds: ["L2"], evidenceQuote: "N-mg=mv²/R", reason: "公式正确", confidence: 0.98, requiresReview: false },
    { subquestionId: "Q1-1", pointId: "P3", status: "not_satisfied", evidenceLineIds: ["L3"], evidenceQuote: "N=2mg", reason: "结果错误", confidence: 0.98, requiresReview: false }
  ];
}

describe("expressionsEquivalent", () => {
  it("accepts algebraically equivalent expressions", () => {
    expect(expressionsEquivalent("sqrt(2)/2", "1/sqrt(2)")).toBe(true);
    expect(expressionsEquivalent("N=3*m*g", "N=m*g+2*m*g")).toBe(true);
    expect(expressionsEquivalent("N=3mg", "3*m*g")).toBe(true);
    expect(expressionsEquivalent(String.raw`v=\sqrt{\frac{gR}{3}}`, "v=sqrt(gR/3)")).toBe(true);
  });

  it("uses only the configured numeric tolerance", () => {
    expect(expressionsEquivalent("9.81", "9.8", 0)).toBe(false);
    expect(expressionsEquivalent("9.81", "9.8", 0.02)).toBe(true);
  });

  it("splits and compares multiple final results independently", () => {
    const expected = String.raw`$v_A=\sqrt{\frac{gR}{3}}$, $v_C=2\sqrt{\frac{gR}{3}}$`;
    const actual = "v_C=2sqrt(gR/3); v_A=sqrt(gR/3)";
    expect(splitAnswerExpressions(expected)).toHaveLength(2);
    expect(answerCollectionsEquivalent(actual, expected).equivalent).toBe(true);
  });
});

describe("calculateGrade teacher-model authority", () => {
  it("awards full credit whenever the teacher model marks the final answer correct", () => {
    const rubric = structuredClone(demoRubric);
    rubric.subquestions[0].finalAnswerPolicy = "process_required";
    const evidence: AnswerEvidence = {
      ...baseEvidence,
      finalAnswers: [{ subquestionId: "Q1-1", lineId: "L3", expression: "N=3mg", unit: "N", confidence: 0.99 }]
    };
    const result = calculateGrade({
      id: "teacher-correct", studentId: "S1", fileName: "1.jpg", rubric, evidence,
      finalAnswerJudgements: [finalJudgement("correct", "N=3mg")],
      decisions: decisions(), modelName: "test", durationMs: 10
    });
    expect(result.score).toBe(8);
    expect(result.status).toBe("completed");
    expect(result.subquestions[0].decisions[2].status).toBe("not_satisfied");
    expect(result.subquestions[0].decisions.every((item) => item.scoringDisposition === "not_deducted_by_final_answer")).toBe(true);
    expect(result.subquestions[0].decisions.every((item) => item.awardedScore === item.maxScore)).toBe(true);
    expect(result.subquestions[0].finalAnswerDecisionSource).toBe("teacher_model");
  });

  it("ignores process failures, deductions, and a conflicting local audit after a correct teacher decision", () => {
    const rubric = structuredClone(demoRubric);
    rubric.subquestions[0].finalAnswers = [{ expression: "10", unit: "N", tolerance: 0 }];
    const evidence: AnswerEvidence = {
      ...baseEvidence,
      finalAnswers: [{ subquestionId: "Q1-1", lineId: "L3", expression: "10", confidence: 0.99 }]
    };
    const result = calculateGrade({
      id: "audit-conflict", studentId: "S", fileName: "s.jpg", rubric, evidence,
      finalAnswerJudgements: [finalJudgement("correct", "10")],
      decisions: decisions().map((item) => ({ ...item, status: "not_satisfied" as const })),
      appliedDeductions: [{ subquestionId: "Q1-1", ruleId: "D1", evidenceLineIds: ["L3"], reason: "单位缺失", confidence: 1 }],
      modelName: "test", durationMs: 10
    });
    expect(result.score).toBe(8);
    expect(result.subquestions[0].finalAnswerStatus).toBe("correct");
    expect(result.subquestions[0].localFinalAnswerAudit).toMatchObject({ status: "not_equivalent", conflict: true });
    expect(result.subquestions[0].deductions).toHaveLength(0);
    expect(result.subquestions[0].auditDeductions).toHaveLength(1);
    expect(result.subquestions[0].auditDeductions?.[0].deductedScore).toBe(0);
  });

  it("does not deduct an uncertain process point and marks it for review", () => {
    const result = calculateGrade({
      id: "uncertain-process", studentId: "S", fileName: "s.jpg", rubric: demoRubric,
      evidence: baseEvidence, finalAnswerJudgements: [finalJudgement("incorrect")],
      decisions: decisions().map((item, index) => index === 2 ? { ...item, status: "insufficient_evidence" as const, requiresReview: true, reviewReason: "涂改无法确认" } : item),
      modelName: "test", durationMs: 10
    });
    expect(result.score).toBe(8);
    expect(result.subquestions[0].decisions[2].scoringDisposition).toBe("uncertain_no_deduction");
    expect(result.subquestions[0].decisions[2].awardedScore).toBe(2);
    expect(result.status).toBe("needs_review");
  });

  it("uses process points when the teacher model marks the final answer incorrect", () => {
    const result = calculateGrade({
      id: "teacher-incorrect", studentId: "S2", fileName: "2.jpg", rubric: demoRubric,
      evidence: baseEvidence, finalAnswerJudgements: [finalJudgement("incorrect")],
      decisions: decisions(), modelName: "test", durationMs: 10
    });
    expect(result.score).toBe(6);
  });

  it("does not apply two deductions from the same exclusive group", () => {
    const rubric = structuredClone(demoRubric);
    rubric.subquestions[0].deductions.push({ id: "D2", reason: "符号格式错误", deduct: 2, exclusiveGroup: "result_format" });
    const result = calculateGrade({
      id: "deductions", studentId: "S3", fileName: "3.jpg", rubric, evidence: baseEvidence,
      finalAnswerJudgements: [finalJudgement("incorrect")], decisions: decisions(), modelName: "test", durationMs: 10,
      appliedDeductions: [
        { subquestionId: "Q1-1", ruleId: "D1", evidenceLineIds: ["L3"], reason: "单位错误", confidence: 1 },
        { subquestionId: "Q1-1", ruleId: "D2", evidenceLineIds: ["L3"], reason: "符号错误", confidence: 1 }
      ]
    });
    expect(result.score).toBe(5);
    expect(result.subquestions[0].deductions).toHaveLength(1);
  });

  it("marks a missing teacher judgement uncertain instead of falling back to local matching", () => {
    const result = calculateGrade({
      id: "missing-judgement", studentId: "S4", fileName: "4.jpg", rubric: demoRubric,
      evidence: baseEvidence, finalAnswerJudgements: [], decisions: decisions(), modelName: "test", durationMs: 10
    });
    expect(result.subquestions[0].finalAnswerStatus).toBe("uncertain");
    expect(result.subquestions[0].finalAnswerDecisionSource).toBe("missing_teacher_judgement");
    expect(result.status).toBe("needs_review");
  });
});

describe("real grading regression 16", () => {
  const rubric: Rubric = {
    title: "圆弧槽、滑块运动与弹性碰撞",
    recognizedQuestionText: "16",
    version: 1,
    status: "locked",
    totalScore: 16,
    warnings: [],
    subquestions: [
      {
        id: "16(1)", title: "圆弧槽固定时的压力", maxScore: 4, finalAnswerPolicy: "process_required",
        finalAnswers: [{ expression: "$F=3mg$；方向竖直向下", tolerance: 0 }],
        scorePoints: [1, 2, 3, 4].map((index) => ({ id: `16(1)-${index}`, title: `P${index}`, description: "", score: 1, type: index === 4 ? "text" as const : "formula" as const, expected: "" })),
        deductions: []
      },
      {
        id: "16(2)", title: "圆弧槽不固定时A、C的速度", maxScore: 6, finalAnswerPolicy: "process_required",
        finalAnswers: [{ expression: String.raw`$v_{\text{A}}=\sqrt{\frac{gR}{3}}$；$v_{\text{C}}=2\sqrt{\frac{gR}{3}}$`, tolerance: 0 }],
        scorePoints: [1, 2, 3].map((index) => ({ id: `16(2)-${index}`, title: `P${index}`, description: "", score: 2, type: index === 3 ? "result" as const : "formula" as const, expected: "" })),
        deductions: []
      },
      {
        id: "16(3)", title: "粗糙水平面的动摩擦因数", maxScore: 6, finalAnswerPolicy: "process_required",
        finalAnswers: [{ expression: String.raw`\mu=\frac{4}{9}`, tolerance: 0 }],
        scorePoints: [1, 2, 3, 4, 5, 6].map((index) => ({ id: `16(3)-${index}`, title: `P${index}`, description: "", score: 1, type: index === 6 ? "result" as const : "formula" as const, expected: "" })),
        deductions: []
      }
    ]
  };

  const evidence: AnswerEvidence = {
    lines: [
      { id: "L07", text: "N'=N=3mg", status: "active", confidence: 0.97 },
      { id: "L08", text: "方向竖直向下", status: "active", confidence: 0.96 },
      { id: "L12", text: "mgR=1/2mV_C²+1/2·2mV_A²", status: "uncertain", confidence: 0.69 },
      { id: "L14", text: "V_A=sqrt(3gR)/3", status: "active", confidence: 0.9 },
      { id: "L15", text: "V_C=2sqrt(3gR)/3", status: "active", confidence: 0.94 },
      { id: "L16", text: "mV_C'=mV_C''+3mV_B", status: "active", confidence: 0.92 },
      { id: "L32", text: "mu=1/3", status: "active", confidence: 0.98 }
    ],
    finalAnswers: [
      { subquestionId: "16(1)", lineId: "L07", expression: "N'=N=3mg", confidence: 0.97 },
      { subquestionId: "16(1)", lineId: "L08", expression: "direction: vertically downward", confidence: 0.96 },
      { subquestionId: "16(2)", lineId: "L14", expression: "V_A=sqrt(3gR)/3", confidence: 0.9 },
      { subquestionId: "16(2)", lineId: "L15", expression: "V_C=2sqrt(3gR)/3", confidence: 0.94 },
      { subquestionId: "16(3)", lineId: "L32", expression: "mu=1/3", confidence: 0.98 }
    ],
    ambiguities: [{ lineId: "L12", reason: "机械能式第二项有涂改", scoreImpact: "possible" }]
  };

  const teacherJudgements: FinalAnswerJudgement[] = [
    { subquestionId: "16(1)", status: "correct", evidenceLineIds: ["L07", "L08"], studentAnswer: "N'=N=3mg；方向竖直向下", referenceAnswer: "F=3mg；方向竖直向下", reason: "压力大小和方向均与参考答案一致。", confidence: 0.99 },
    { subquestionId: "16(2)", status: "correct", evidenceLineIds: ["L14", "L15"], studentAnswer: "V_A=√(3gR)/3；V_C=2√(3gR)/3", referenceAnswer: "v_A=√(gR/3)；v_C=2√(gR/3)", reason: "两组速度分别与参考答案数学等价。", confidence: 0.98 },
    { subquestionId: "16(3)", status: "incorrect", evidenceLineIds: ["L32"], studentAnswer: "mu=1/3", referenceAnswer: "mu=4/9", reason: "最终数值与参考答案不同。", confidence: 0.99 }
  ];

  const processDecisions: RubricDecision[] = [
    ...[1, 2, 3, 4].map((index) => ({ subquestionId: "16(1)", pointId: `16(1)-${index}`, status: "satisfied" as const, evidenceLineIds: ["L07"], evidenceQuote: "N'=N=3mg", reason: "小问一过程审验通过", confidence: 0.98, requiresReview: false })),
    ...[1, 2, 3].map((index) => ({ subquestionId: "16(2)", pointId: `16(2)-${index}`, status: "satisfied" as const, evidenceLineIds: ["L14", "L15"], evidenceQuote: "V_A=sqrt(3gR)/3；V_C=2sqrt(3gR)/3", reason: "小问二过程审验通过", confidence: 0.98, requiresReview: false })),
    ...[1, 2, 3, 4, 5, 6].map((index) => ({
      subquestionId: "16(3)", pointId: `16(3)-${index}`,
      status: index === 1 ? "satisfied" as const : index === 2 ? "insufficient_evidence" as const : "not_satisfied" as const,
      evidenceLineIds: index === 1 ? ["L16"] : index === 6 ? ["L32"] : [],
      evidenceQuote: index === 1 ? "mV_C'=mV_C''+3mV_B" : index === 6 ? "mu=1/3" : "",
      reason: index === 1 ? "碰撞动量守恒公式正确" : "未满足该评分点",
      confidence: index === 2 ? 0.55 : 0.98,
      requiresReview: index === 2,
      reviewReason: index === 2 ? "碰撞能量关系需核对原卷" : undefined
    }))
  ];

  it("gives 12/16 and never lets process ambiguity reduce correct subquestions", () => {
    const result = calculateGrade({
      id: "real-16", studentId: "学生 01", fileName: "学生答案.png", rubric, evidence,
      finalAnswerJudgements: teacherJudgements, decisions: processDecisions, modelName: "teacher-model", durationMs: 10
    });
    expect(result.score).toBe(12);
    expect(result.subquestions.map((item) => item.score)).toEqual([4, 6, 2]);
    expect(result.subquestions[0].decisions.every((item) => item.scoringDisposition === "not_deducted_by_final_answer")).toBe(true);
    expect(result.subquestions[1].decisions.every((item) => item.scoringDisposition === "not_deducted_by_final_answer")).toBe(true);
    expect(result.subquestions[2].finalAnswerStatus).toBe("incorrect");
    expect(result.status).toBe("needs_review");
  });
});
