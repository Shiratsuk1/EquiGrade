import { decodeSafeLatexTokens } from "./formulaProtocol.js";

function canonicalUnit(value: string): string {
  return decodeSafeLatexTokens(value)
    .replaceAll("²", "^2")
    .replaceAll("³", "^3")
    .replaceAll("⁰", "^0")
    .replaceAll("¹", "^1")
    .replaceAll("⁴", "^4")
    .replaceAll("⁵", "^5")
    .replaceAll("⁶", "^6")
    .replaceAll("⁷", "^7")
    .replaceAll("⁸", "^8")
    .replaceAll("⁹", "^9")
    .replaceAll("\\mathrm", "")
    .replaceAll("\\text", "")
    .replaceAll("\\rm", "")
    .replaceAll("\\;", "")
    .replaceAll("\\,", "")
    .replaceAll(" ", "")
    .replaceAll("{", "")
    .replaceAll("}", "")
    .replaceAll("$", "")
    .replaceAll("^", "")
    .replaceAll("_", "")
    .replaceAll("\\", "")
    .toLowerCase();
}

/** Combines a rubric expression and optional unit without duplicating a unit already present. */
export function combineFinalAnswerExpression(expression: string, unit?: string): string {
  const cleanExpression = decodeSafeLatexTokens(expression).trim();
  const cleanUnit = decodeSafeLatexTokens(unit ?? "").trim();
  if (!cleanUnit) return cleanExpression;
  const expectedUnit = canonicalUnit(cleanUnit);
  if (expectedUnit && canonicalUnit(cleanExpression).endsWith(expectedUnit)) return cleanExpression;
  return `${cleanExpression} ${cleanUnit}`.trim();
}

export function combineFinalAnswerTexts(answers: Array<{ expression: string; unit?: string }>): string[] {
  return answers.map((answer) => combineFinalAnswerExpression(answer.expression, answer.unit)).filter(Boolean);
}
