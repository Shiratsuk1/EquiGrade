import { describe, expect, it } from "vitest";
import type { FinalAnswerRule } from "../shared/types.js";
import { rubricSchema } from "./schemas.js";
import {
  comparePhysicsAnswer,
  compareStudentAnswerToFinalAnswer,
  compareStudentAnswerToFinalAnswers
} from "./physicsAnswerEquivalence.js";

describe("physics answer sign semantics", () => {
  it("keeps fixed-convention signs significant", () => {
    const result = compareStudentAnswerToFinalAnswer("v=3m/s", {
      expression: "v=-3",
      unit: "m/s",
      signPolicy: "fixed_convention",
      positiveDirection: "向右为正"
    });

    expect(result.status).toBe("contradictory");
    expect(result.candidateAudits[0]?.basis).toContain("比较带符号数值");
  });

  it("recognises a direction expressed in words as equivalent to a signed value", () => {
    const result = comparePhysicsAnswer("v=3m/s，方向向左", [{
      expression: "v=-3",
      unit: "m/s",
      signPolicy: "direction_dependent",
      positiveDirection: "向右为正"
    }]);

    expect(result.status).toBe("equivalent");
    expect(result.candidateAudits[0]).toMatchObject({
      studentDirection: "left",
      referenceDirection: "left"
    });
  });

  it("does not call opposite signs wrong when the positive direction is not declared", () => {
    const result = comparePhysicsAnswer("v=3m/s", [{
      expression: "v=-3",
      unit: "m/s",
      signPolicy: "direction_dependent"
    }]);

    expect(result.status).toBe("convention_unclear");
    expect(result.reason).toContain("人工确认");
  });

  it("compares magnitudes only when the rubric explicitly says so", () => {
    const result = comparePhysicsAnswer("W=-10J", [{
      expression: "W=10",
      unit: "J",
      signPolicy: "magnitude_only"
    }]);

    expect(result.status).toBe("equivalent");
    expect(result.candidateAudits[0]?.reason).toContain("只要求大小");
  });

  it("maps work sign changes caused by reversing the acting role", () => {
    const result = comparePhysicsAnswer("系统对外做功10J", [{
      expression: "W=-10",
      unit: "J",
      signPolicy: "role_reversal",
      subject: "外力对系统做功"
    }]);

    expect(result.status).toBe("equivalent");
    expect(result.candidateAudits[0]).toMatchObject({
      studentRole: "system_on_external",
      referenceRole: "external_on_system"
    });
  });

  it("requires role evidence before accepting an opposite work sign", () => {
    const result = comparePhysicsAnswer("W=10J", [{
      expression: "W=-10",
      unit: "J",
      signPolicy: "role_reversal",
      subject: "外力对系统做功"
    }]);

    expect(result.status).toBe("convention_unclear");
  });

  it("treats physically signed opposite values as contradictory", () => {
    const result = comparePhysicsAnswer("p=+5Pa", [{
      expression: "p=-5",
      unit: "Pa",
      signPolicy: "physically_signed"
    }]);

    expect(result.status).toBe("contradictory");
  });

  it("checks every finalAnswers candidate and accepts any equivalent one", () => {
    const finalAnswers: FinalAnswerRule[] = [
      { expression: "v=-3", unit: "m/s", signPolicy: "fixed_convention" },
      { expression: "v=3", unit: "m/s", signPolicy: "fixed_convention" },
      { expression: "v=4", unit: "m/s", signPolicy: "fixed_convention" }
    ];
    const result = compareStudentAnswerToFinalAnswers("v=3m/s", finalAnswers);

    expect(result.status).toBe("equivalent");
    expect(result.checkedFinalAnswerCount).toBe(3);
    expect(result.candidateAudits).toHaveLength(3);
    expect(result.matchedAnswerIndices).toEqual([1]);
    expect(result.candidateAudits.map((audit) => audit.status)).toEqual([
      "contradictory",
      "equivalent",
      "no_match"
    ]);
  });

  it("keeps legacy rules parseable and sends unexplained sign changes to review", () => {
    const legacyRubric = rubricSchema.parse({
      title: "旧模板",
      recognizedQuestionText: "求速度",
      version: 1,
      status: "locked",
      questionType: "large",
      totalScore: 1,
      subquestions: [{
        id: "Q1",
        title: "速度",
        maxScore: 1,
        finalAnswerPolicy: "full_credit",
        finalAnswers: [{ expression: "v=-3", unit: "m/s", label: "速度" }],
        scorePoints: [],
        deductions: []
      }],
      warnings: []
    });
    expect(legacyRubric.subquestions[0]?.finalAnswers[0]?.signPolicy).toBeUndefined();

    const result = comparePhysicsAnswer("v=3m/s", legacyRubric.subquestions[0]?.finalAnswers ?? []);
    expect(result.status).toBe("convention_unclear");
  });

  it("returns no_match for different magnitudes and records the reason", () => {
    const result = comparePhysicsAnswer({
      studentAnswer: "v=4m/s",
      finalAnswers: [{ expression: "v=3", unit: "m/s", signPolicy: "fixed_convention" }]
    });

    expect(result.status).toBe("no_match");
    expect(result.candidateAudits[0]?.reason).toContain("数值大小");
  });
});

