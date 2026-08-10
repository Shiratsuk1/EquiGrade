import { describe, expect, it } from "vitest";
import {
  SAFE_LATEX_BACKSLASH_TOKEN,
  decodeSafeLatexTokens,
  findDamagedLatexControlPath,
  hasUnsafeLatexJsonEscape,
  splitFormulaTextBlocks
} from "./formulaProtocol.js";

describe("safe formula protocol", () => {
  it("decodes safe backslash tokens recursively after JSON parsing", () => {
    const decoded = decodeSafeLatexTokens({
      text: `$${SAFE_LATEX_BACKSLASH_TOKEN}frac{1}{2}mv^2$`,
      nested: [{ latex: `${SAFE_LATEX_BACKSLASH_TOKEN}sqrt{gR}` }]
    });
    expect(decoded).toEqual({
      text: String.raw`$\frac{1}{2}mv^2$`,
      nested: [{ latex: String.raw`\sqrt{gR}` }]
    });
  });

  it("detects single JSON escapes that would corrupt LaTeX commands", () => {
    expect(hasUnsafeLatexJsonEscape(String.raw`{"latex":"\right)"}`)).toBe(true);
    expect(hasUnsafeLatexJsonEscape(String.raw`{"latex":"\\right)"}`)).toBe(false);
    expect(hasUnsafeLatexJsonEscape(`{"latex":"${SAFE_LATEX_BACKSLASH_TOKEN}right)"}`)).toBe(false);
  });

  it("detects control-character damage after parsing", () => {
    expect(findDamagedLatexControlPath({ latex: "x=" + "\f" + "rac{1}{2}" })).toBe("$model.latex");
    expect(findDamagedLatexControlPath({ text: "第一行\n第二行" })).toBeNull();
  });

  it("keeps complete inline and display formulas as indivisible blocks", () => {
    const blocks = splitFormulaTextBlocks(String.raw`由能量守恒 $E_k=\frac{1}{2}mv^2$，得到：$$v=\sqrt{2gh}$$`);
    expect(blocks).toEqual([
      { type: "text", value: "由能量守恒 " },
      { type: "math", value: String.raw`E_k=\frac{1}{2}mv^2`, display: false },
      { type: "text", value: "，得到：" },
      { type: "math", value: String.raw`v=\sqrt{2gh}`, display: true }
    ]);
  });

  it("does not partially consume an unmatched formula", () => {
    const source = String.raw`公式 $\frac{1}{2}mv^2 未闭合，后面保持原样`;
    expect(splitFormulaTextBlocks(source)).toEqual([{ type: "text", value: source }]);
  });
});
