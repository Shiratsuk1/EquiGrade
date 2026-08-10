import { describe, expect, it } from "vitest";
import { findInvalidFormulaPath } from "./formulaValidation.js";

describe("deterministic formula validation", () => {
  it("accepts complete inline and display formula blocks", () => {
    expect(findInvalidFormulaPath({
      text: String.raw`根据能量守恒 $E=\frac{1}{2}mv^2$，所以：$$v=\sqrt{2gh}$$`
    })).toBeNull();
  });

  it("reports the exact field for an invalid explicit formula", () => {
    const issue = findInvalidFormulaPath({ answer: String.raw`$\frac{1}{2$` });
    expect(issue?.path).toBe("$model.answer");
  });

  it("does not reinterpret plain prose as a formula", () => {
    expect(findInvalidFormulaPath({ text: "价格为 $5，之后继续说明" })).toBeNull();
  });
});
