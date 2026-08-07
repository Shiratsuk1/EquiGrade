import { describe, expect, it } from "vitest";
import { formulaWithUnit, isLikelyFormula, normalizeLatex, renderFormulaHtml } from "./math";

describe("formula rendering", () => {
  it("renders common physics LaTeX with accessible MathML", () => {
    const html = renderFormulaHtml(String.raw`\frac{1}{2}mv^2=mgh`);
    expect(html).toContain("katex");
    expect(html).toContain("<math");
  });

  it("normalizes copied delimiters and unicode operators", () => {
    expect(normalizeLatex(String.raw`$F＝m×a$`)).toBe(String.raw`F=m\times a`);
  });

  it("converts slash fractions to stacked LaTeX fractions", () => {
    expect(normalizeLatex(String.raw`1/2mV_1^2=U/I+\sqrt{gR}/3`)).toBe(String.raw`\frac{1}{2}mV_1^2=\frac{U}{I}+\frac{\sqrt{gR}}{3}`);
  });

  it("normalizes OCR sqrt notation and unicode powers before fractions", () => {
    expect(normalizeLatex(String.raw`V_A=sqrt(3gR)/3；V_C=2sqrt(3gR)/3`)).toBe(String.raw`V_A=\frac{\sqrt{3gR}}{3}；V_C=2\frac{\sqrt{3gR}}{3}`);
    expect(normalizeLatex(String.raw`N-mg=mv²/R`)).toBe(String.raw`N-mg=m\frac{v^{2}}{R}`);
  });

  it("keeps unit slashes while rendering Chinese text labels in formulas", () => {
    expect(normalizeLatex(String.raw`v=2\;\mathrm{m/s}`)).toBe(String.raw`v=2\;\mathrm{m/s}`);
    expect(renderFormulaHtml(String.raw`V_{\text{相}}=V_C';a_{\text{相对}}=4\mu g`)).toContain("katex");
  });

  it("repairs double-escaped commands and OCR square placeholders", () => {
    expect(normalizeLatex(String.raw`\\text{碰撞前速度大小}=\\frac{\\sqrt{8gR}}{3}+□`)).toBe(String.raw`\text{碰撞前速度大小}=\frac{\sqrt{8gR}}{3}+\square`);
  });

  it("restores a right command when JSON decoding turns its slash into CR", () => {
    const value = String.raw`\left(x+\frac{R}{\Box` + "\r" + String.raw`ight)`;
    expect(normalizeLatex(value)).toBe(String.raw`\left(x+\frac{R}{\Box}\right)`);
    expect(renderFormulaHtml(value)).toContain("katex");
  });

  it("restores common JSON control-character damage without losing the command letter", () => {
    expect(normalizeLatex("x=" + "\f" + "rac{1}{2}")).toBe(String.raw`x=\frac{1}{2}`);
    expect(normalizeLatex("x=" + "\t" + "ext{速度}")).toBe(String.raw`x=\text{速度}`);
    expect(normalizeLatex("x+" + "\b" + "egin{aligned}")).toBe(String.raw`x+\begin{aligned}`);
    expect(normalizeLatex("x+" + "\n" + "eq")).toBe(String.raw`x+\neq`);
  });

  it("preserves aligned-math line breaks while repairing double-escaped commands", () => {
    const value = String.raw`\\begin{aligned}a&=b\\ c&=d\\end{aligned}`;
    expect(normalizeLatex(value)).toBe(String.raw`\begin{aligned}a&=b\\ c&=d\end{aligned}`);
  });

  it("distinguishes prose from formula candidates", () => {
    expect(isLikelyFormula("根据牛顿第二定律列式")).toBe(false);
    expect(isLikelyFormula(String.raw`N-mg=\frac{mv^2}{R}`)).toBe(true);
  });

  it("formats units without treating them as variables", () => {
    expect(formulaWithUnit("v=2", "m/s")).toBe(String.raw`v=2\;\mathrm{m/s}`);
  });

  it("does not strip delimiters around multiple inline formulas as one formula", () => {
    const value = String.raw`$v_A=\sqrt{gR/3}$, $v_C=2\sqrt{gR/3}$`;
    expect(normalizeLatex(value)).toContain("$, $");
  });
});
