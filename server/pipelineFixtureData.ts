import type { Rubric } from "../shared/types.js";

export const pipelineFixtureQuestion = `如图，质量 m=0.50 kg 的小滑块从光滑轨道上距最低点 B 高 h=3.20 m 的 A 点由静止释放，进入半径 R=0.80 m 的竖直圆形光滑轨道内侧。圆轨道最高点为 C。取 g=10 m/s^2，滑块可视为质点。

(1) 求滑块第一次到达最低点 B 时的速度，以及滑块对轨道的压力。
(2) 判断滑块能否通过最高点 C，并求其在 C 点时轨道对滑块的支持力。
(3) 保持其他条件不变，求滑块恰好能够通过最高点 C 时的释放高度 h_min。
(4) 若释放高度改为 h'=1.80 m，设滑块在圆轨道内从最低点起转过圆心角 theta 时与轨道脱离。求 cos(theta)、theta 及脱离瞬间速度。`;

export const pipelineFixtureReference = `满分18分。B点：mgh=1/2 mv_B^2，v_B=8.0 m/s；N_B-mg=mv_B^2/R，N_B=45 N，滑块对轨道压力大小45 N、竖直向下。C点：v_C^2=v_B^2-4gR=32 m^2/s^2；N_C+mg=mv_C^2/R，N_C=15 N>0，能通过C点，支持力向下。临界：N_C=0，v_C^2=gR，h_min=5R/2=2.00 m。h'=1.80m脱离：v^2=2g[h'-R(1-cos theta)]，N=0时v^2=-gR cos theta，cos theta=-5/6，theta=arccos(-5/6)=146.4度，v=sqrt(20/3)=2.58m/s。最终答案正确时允许省略过程；最终答案错误或缺失时按得分点给分。`;

export const pipelineFixtureRubric: Rubric = {
  title: "竖直圆轨道综合题",
  recognizedQuestionText: pipelineFixtureQuestion,
  version: 3,
  status: "locked",
  totalScore: 18,
  warnings: [],
  subquestions: [
    {
      id: "Q1", title: "B点速度与压力", maxScore: 5, finalAnswerPolicy: "full_credit",
      finalAnswers: [{ expression: "v_B=8;N_B=45", label: "v_B=8.0m/s，压力45N向下" }],
      scorePoints: [
        { id: "Q1-P1", title: "B点机械能关系", description: "列出 mgh=1/2 mv_B^2 或等价的重力做功-动能定理关系", score: 2, type: "formula", expected: "m*g*h=1/2*m*v_B^2" },
        { id: "Q1-P2", title: "B点速度", description: "计算 v_B=8.0 m/s", score: 1, type: "result", expected: "v_B=8" },
        { id: "Q1-P3", title: "B点向心力方程", description: "最低点列出 N_B-mg=mv_B^2/R", score: 1.5, type: "formula", expected: "N_B-m*g=m*v_B^2/R" },
        { id: "Q1-P4", title: "B点压力结论", description: "压力大小45 N，方向竖直向下", score: 0.5, type: "result", expected: "N_B=45N" }
      ], deductions: []
    },
    {
      id: "Q2", title: "C点通过条件与支持力", maxScore: 5, finalAnswerPolicy: "full_credit",
      finalAnswers: [{ expression: "N_C=15", label: "N_C=15N，能通过C点" }],
      scorePoints: [
        { id: "Q2-P1", title: "B到C能量关系", description: "列出 v_C^2=v_B^2-4gR 或等价关系", score: 1.5, type: "formula", expected: "v_C^2=v_B^2-4*g*R" },
        { id: "Q2-P2", title: "C点速度", description: "得 v_C^2=32 m^2/s^2 或 v_C=4sqrt(2) m/s", score: 1, type: "result", expected: "v_C^2=32" },
        { id: "Q2-P3", title: "C点向心力方程", description: "最高点列出 N_C+mg=mv_C^2/R，方向指向圆心", score: 1.5, type: "formula", expected: "N_C+m*g=m*v_C^2/R" },
        { id: "Q2-P4", title: "C点结论", description: "N_C=15 N>0，能通过C点，支持力向下", score: 1, type: "result", expected: "N_C=15" }
      ], deductions: []
    },
    {
      id: "Q3", title: "恰好通过C点的最小高度", maxScore: 3, finalAnswerPolicy: "full_credit",
      finalAnswers: [{ expression: "h_min=2", label: "h_min=2.00m=5R/2" }],
      scorePoints: [
        { id: "Q3-P1", title: "临界条件", description: "恰好通过最高点时 N_C=0，v_C^2=gR", score: 1, type: "formula", expected: "N_C=0;v_C^2=g*R" },
        { id: "Q3-P2", title: "临界能量关系", description: "列出 mgh_min=2mgR+1/2 mgR", score: 1.5, type: "formula", expected: "m*g*h_min=2*m*g*R+1/2*m*g*R" },
        { id: "Q3-P3", title: "最小高度", description: "得 h_min=5R/2=2.00m", score: 0.5, type: "result", expected: "h_min=5*R/2=2" }
      ], deductions: []
    },
    {
      id: "Q4", title: "1.80m释放时的脱离位置与速度", maxScore: 5, finalAnswerPolicy: "full_credit",
      finalAnswers: [{ expression: "cos(theta)=-5/6;theta=acos(-5/6);v=sqrt(20/3)", label: "cosθ=-5/6，θ=146.4°，v=2.58m/s" }],
      scorePoints: [
        { id: "Q4-P1", title: "任意位置能量关系", description: "列出 v^2=2g[h'-R(1-cos theta)]", score: 1.5, type: "formula", expected: "v^2=2*g*(h_prime-R*(1-cos(theta)))" },
        { id: "Q4-P2", title: "脱离条件", description: "列出 N=0，且 v^2=-gR cos theta", score: 1.5, type: "formula", expected: "N=0;v^2=-g*R*cos(theta)" },
        { id: "Q4-P3", title: "脱离角余弦", description: "得 cos theta=-5/6", score: 1, type: "result", expected: "cos(theta)=-5/6" },
        { id: "Q4-P4", title: "脱离角与速度", description: "得 theta=146.4度，v=sqrt(20/3)=2.58m/s", score: 1, type: "result", expected: "theta=acos(-5/6);v=sqrt(20/3)" }
      ], deductions: []
    }
  ]
};
