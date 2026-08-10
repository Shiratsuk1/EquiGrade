import katex from "katex";
import { splitFormulaTextBlocks } from "../shared/formulaProtocol.js";

export interface FormulaValidationIssue {
  path: string;
  reason: string;
}

function validateString(value: string, path: string): FormulaValidationIssue | null {
  for (const block of splitFormulaTextBlocks(value)) {
    if (block.type !== "math") continue;
    try {
      katex.renderToString(block.value, {
        displayMode: block.display,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml"
      });
    } catch (error) {
      return {
        path,
        reason: error instanceof Error ? error.message : "公式未通过 KaTeX 语法校验"
      };
    }
  }
  return null;
}

export function findInvalidFormulaPath(value: unknown, path = "$model"): FormulaValidationIssue | null {
  if (typeof value === "string") return validateString(value, path);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = findInvalidFormulaPath(value[index], `${path}[${index}]`);
      if (issue) return issue;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const issue = findInvalidFormulaPath(item, `${path}.${key}`);
      if (issue) return issue;
    }
  }
  return null;
}
