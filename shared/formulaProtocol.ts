export const SAFE_LATEX_BACKSLASH_TOKEN = "[[LATEX_BS]]";

export const SAFE_LATEX_PROTOCOL_INSTRUCTION = [
  "【公式 JSON 安全协议】",
  "公式字段请直接使用标准 LaTeX，例如 \\frac{1}{2}、\\sqrt{2gh}、\\mathrm{m/s}。不要自行改写反斜杠或添加传输占位符。",
  "JSON 的反斜杠转义由本地程序负责；只输出严格 JSON，不要输出 Markdown 代码围栏。",
  "正文与公式混合时，行内公式使用 $...$，独立公式使用 $$...$$；公式块内部不得因换行、逗号或中文标点拆分。",
  "expression、expected、latex 等本身就是纯公式的字段不需要额外添加 $ 定界符。",
  "本地程序只修复反斜杠的 JSON 传输写法，不得改变数字、变量、运算符、单位、中文内容或公式结构。"
].join("\n");

export type FormulaTextBlock =
  | { type: "text"; value: string }
  | { type: "math"; value: string; display: boolean };

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findClosingDelimiter(value: string, start: number, close: string, inline: boolean): number {
  for (let cursor = start; cursor < value.length; cursor += 1) {
    if (inline && value[cursor] === "\n") return -1;
    if (value.startsWith(close, cursor) && !isEscaped(value, cursor)) return cursor;
  }
  return -1;
}

export function splitFormulaTextBlocks(value: string): FormulaTextBlock[] {
  const blocks: FormulaTextBlock[] = [];
  const openers = [
    { open: "$$", close: "$$", display: true, inline: false },
    { open: "\\[", close: "\\]", display: true, inline: false },
    { open: "\\(", close: "\\)", display: false, inline: true },
    { open: "$", close: "$", display: false, inline: true }
  ] as const;
  let textStart = 0;
  let cursor = 0;

  while (cursor < value.length) {
    const opener = openers.find((candidate) =>
      value.startsWith(candidate.open, cursor)
      && !isEscaped(value, cursor)
      && !(candidate.open === "$" && value.startsWith("$$", cursor))
    );
    if (!opener) {
      cursor += 1;
      continue;
    }

    const contentStart = cursor + opener.open.length;
    const closeIndex = findClosingDelimiter(value, contentStart, opener.close, opener.inline);
    if (closeIndex < 0) {
      // An unmatched opener is retained verbatim. Continuing to scan could
      // pair a later delimiter with the wrong formula and hide corruption.
      break;
    }

    if (cursor > textStart) blocks.push({ type: "text", value: value.slice(textStart, cursor) });
    const formula = value.slice(contentStart, closeIndex);
    if (formula) {
      blocks.push({ type: "math", value: formula, display: opener.display });
    } else {
      blocks.push({ type: "text", value: value.slice(cursor, closeIndex + opener.close.length) });
    }
    cursor = closeIndex + opener.close.length;
    textStart = cursor;
  }

  if (textStart < value.length) blocks.push({ type: "text", value: value.slice(textStart) });
  return blocks.length ? blocks : [{ type: "text", value }];
}

export function decodeSafeLatexTokens<T>(value: T): T {
  if (typeof value === "string") {
    return value.replaceAll(SAFE_LATEX_BACKSLASH_TOKEN, "\\") as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => decodeSafeLatexTokens(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, decodeSafeLatexTokens(item)])
    ) as T;
  }
  return value;
}

const unsafeLatexJsonEscapePattern = /(^|[^\\])\\(?=(?:bar|beta|begin|big|boldsymbol|binom|bullet|boxed|bmod|frac|nabla|neq|not|nu|right|rho|rangle|rbrace|rceil|rfloor|mathrm|sqrt|text|times|theta|tau|tan|triangle))/;
const unsafeLatexJsonEscapeGlobalPattern = /(^|[^\\])\\(?=(?:bar|beta|begin|big|boldsymbol|binom|bullet|boxed|bmod|frac|nabla|neq|not|nu|right|rho|rangle|rbrace|rceil|rfloor|mathrm|sqrt|text|times|theta|tau|tan|triangle))/g;

export function hasUnsafeLatexJsonEscape(rawJson: string): boolean {
  return unsafeLatexJsonEscapePattern.test(rawJson);
}

/**
 * Repairs the common model mistake of placing a LaTeX command backslash in a
 * JSON string without JSON escaping it. Valid JSON escapes and already
 * escaped LaTeX (`\\\\frac`) are left unchanged. Historical safe tokens are
 * decoded after JSON.parse and are intentionally supported for old records.
 */
export function repairLatexJsonEscapes(rawJson: string): { json: string; repaired: boolean } {
  let repaired = false;
  const json = rawJson.replace(unsafeLatexJsonEscapeGlobalPattern, (_match, prefix: string) => {
    repaired = true;
    return `${prefix}\\\\`;
  });
  return { json, repaired };
}

const damagedLatexControlPattern = /(?:\u0008(?=ar|eta|egin|ig|oldsymbol|inom|ullet|oxed|mod)|\f(?=rac)|\n(?=abla|eq|ot|u)|\r(?=ight|ho|angle|brace|ceil|floor|m)|\t(?=ext|imes|heta|au|an|riangle))/;

export function findDamagedLatexControlPath(value: unknown, path = "$model"): string | null {
  if (typeof value === "string") return damagedLatexControlPattern.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findDamagedLatexControlPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const found = findDamagedLatexControlPath(item, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}
