import type { AnswerEvidence, FinalAnswerJudgement, Rubric, RubricDecision } from "../shared/types.js";
import { calculateGrade, createFallbackTeacherCommentary } from "./gradingEngine.js";

export const demoQuestion = "如图，质量为m的滑块从圆弧槽顶端由静止滑下，圆弧半径为R。不计摩擦，求滑块到达最低点C时对圆弧槽的压力。";

export const demoReference = `本题满分8分。机械能守恒：mgR=1/2 mv_C^2，得3分。最低点径向牛顿第二定律：N-mg=mv_C^2/R，得3分。计算得N=3mg，得2分。最终答案正确允许省略部分过程。`;

export const demoRubric: Rubric = {
  title: "圆周运动与机械能",
  recognizedQuestionText: "如图，质量为 $m$ 的滑块从圆弧槽顶端由静止滑下，圆弧半径为 $R$。不计摩擦，求滑块到达最低点 $C$ 时对圆弧槽的压力。",
  version: 2,
  status: "locked",
  totalScore: 8,
  warnings: [],
  subquestions: [{
    id: "Q1-1",
    title: "求滑块C点对圆弧槽的压力",
    maxScore: 8,
    finalAnswerPolicy: "full_credit",
    finalAnswers: [{ expression: "N=3*m*g", tolerance: 0, label: "压力大小" }],
    scorePoints: [
      { id: "P1", title: "机械能守恒", description: "正确列出机械能守恒关系", score: 3, type: "formula", expected: "m*g*R=1/2*m*v^2", equivalents: ["v^2=2*g*R"] },
      { id: "P2", title: "径向牛顿第二定律", description: "最低点正确列出径向动力学方程", score: 3, type: "formula", expected: "N-m*g=m*v^2/R", equivalents: [] },
      { id: "P3", title: "最终结果", description: "计算得到压力大小", score: 2, type: "result", expected: "N=3*m*g", equivalents: [] }
    ],
    deductions: []
  }]
};

function evidence(lines: AnswerEvidence["lines"], expression?: string, confidence = 0.96): AnswerEvidence {
  return {
    lines,
    finalAnswers: expression ? [{ subquestionId: "Q1-1", lineId: lines.at(-1)?.id ?? "", expression, confidence }] : [],
    ambiguities: confidence < 0.75 ? [{ lineId: lines.at(-1)?.id, reason: "最终答案中的系数书写模糊", scoreImpact: "certain" }] : []
  };
}

function decision(pointId: string, status: RubricDecision["status"], lineId: string, quote: string, requiresReview = false): RubricDecision {
  return { subquestionId: "Q1-1", pointId, status, evidenceLineIds: lineId ? [lineId] : [], evidenceQuote: quote, reason: status === "satisfied" ? "与评分点要求一致" : "未满足评分点要求", confidence: requiresReview ? 0.66 : 0.95, requiresReview, reviewReason: requiresReview ? "关键字符存在视觉歧义" : undefined };
}

function finalJudgement(status: FinalAnswerJudgement["status"], studentAnswer: string, confidence = 0.97): FinalAnswerJudgement {
  return {
    subquestionId: "Q1-1",
    status,
    evidenceLineIds: ["L3"],
    studentAnswer,
    referenceAnswer: "N=3mg",
    reason: status === "correct" ? "学生压力结果与参考答案一致。" : status === "incorrect" ? "学生压力结果与参考答案不一致。" : "最终结果字迹无法可靠确认。",
    confidence
  };
}

export function createDemoResults() {
  const results = [
    calculateGrade({ id: "demo-1", studentId: "学生 01", fileName: "student-01.jpg", rubric: demoRubric, modelName: "demo-vision", durationMs: 1840,
      evidence: evidence([
        { id: "L1", text: "mgR=1/2 mv²", latex: "mgR=\\frac12mv^2", status: "active", confidence: 0.98 },
        { id: "L2", text: "N-mg=mv²/R", latex: "N-mg=\\frac{mv^2}{R}", status: "active", confidence: 0.97 },
        { id: "L3", text: "N=3mg", latex: "N=3mg", status: "active", confidence: 0.98 }
      ], "N=3*m*g"),
      finalAnswerJudgements: [finalJudgement("correct", "N=3mg")],
      decisions: [decision("P1", "satisfied", "L1", "mgR=1/2 mv²"), decision("P2", "satisfied", "L2", "N-mg=mv²/R"), decision("P3", "satisfied", "L3", "N=3mg")]
    }),
    calculateGrade({ id: "demo-2", studentId: "学生 02", fileName: "student-02.jpg", rubric: demoRubric, modelName: "demo-vision", durationMs: 2075,
      evidence: evidence([
        { id: "L1", text: "mgR=1/2 mv²", status: "active", confidence: 0.96 },
        { id: "L2", text: "N-mg=mv²/R", status: "active", confidence: 0.94 },
        { id: "L3", text: "N=2mg", status: "active", confidence: 0.97 }
      ], "N=2*m*g"),
      finalAnswerJudgements: [finalJudgement("incorrect", "N=2mg")],
      decisions: [decision("P1", "satisfied", "L1", "mgR=1/2 mv²"), decision("P2", "satisfied", "L2", "N-mg=mv²/R"), decision("P3", "not_satisfied", "L3", "N=2mg")]
    }),
    calculateGrade({ id: "demo-3", studentId: "学生 03", fileName: "student-03.jpg", rubric: demoRubric, modelName: "demo-vision", durationMs: 2310,
      evidence: evidence([
        { id: "L1", text: "mgR=1/2 mv²", status: "active", confidence: 0.92 },
        { id: "L2", text: "N-mg=mv²/R", status: "active", confidence: 0.88 },
        { id: "L3", text: "N=?mg", status: "uncertain", confidence: 0.62, alternatives: ["N=3mg", "N=5mg"] }
      ], "N=?*m*g", 0.62),
      finalAnswerJudgements: [finalJudgement("uncertain", "N=?mg", 0.62)],
      decisions: [decision("P1", "satisfied", "L1", "mgR=1/2 mv²"), decision("P2", "satisfied", "L2", "N-mg=mv²/R"), decision("P3", "insufficient_evidence", "L3", "N=?mg", true)]
    })
  ];
  return results.map((result) => ({ ...result, teacherCommentary: createFallbackTeacherCommentary(result) }));
}
