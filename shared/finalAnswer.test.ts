import { describe, expect, it } from "vitest";
import { combineFinalAnswerExpression, combineFinalAnswerTexts } from "./finalAnswer.js";

describe("final answer display text", () => {
  it("does not duplicate a unit already contained in the expression", () => {
    expect(combineFinalAnswerExpression(String.raw`a_1=6\mathrm{m/s^{2}}`, "m/s^2")).toBe(String.raw`a_1=6\mathrm{m/s^{2}}`);
    expect(combineFinalAnswerExpression("L=9m", "m")).toBe("L=9m");
    expect(combineFinalAnswerTexts([{ expression: "v=2", unit: "m/s" }])).toEqual(["v=2 m/s"]);
  });
});
