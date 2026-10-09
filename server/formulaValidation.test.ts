import { describe, expect, it } from "vitest";
import { findInvalidFormulaPath } from "./formulaValidation.js";

describe("deterministic formula validation", () => {
  it("accepts complete inline and display formula blocks", () => {
    expect(findInvalidFormulaPath({
      text: String.raw`根据能量守恒 $E=\frac{1}{2}mv^2$，所以：$$v=\sqrt{2gh}$$`
    })).toBeNull();
  });

  it("does not reinterpret plain prose as a formula", () => {
    expect(findInvalidFormulaPath({ text: "价格为 $5，之后继续说明" })).toBeNull();
  });

  it("accepts escaped left and right braces", () => {
    expect(findInvalidFormulaPath({
      evidenceQuote: String.raw`$\Delta x=\left\{x_1-x_2\right\}$`
    })).toBeNull();
  });

  it("rejects unescaped braces paired with left and right delimiters", () => {
    const issue = findInvalidFormulaPath({
      evidenceQuote: String.raw`$\Delta x=\left{x_1-x_2\right}$`
    });
    expect(issue?.path).toBe("$model.evidenceQuote");
    expect(issue?.reason).toContain("Expected '}'");
  });

});
