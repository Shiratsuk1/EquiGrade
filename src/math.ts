import katex from "katex";

export function isLikelyFormula(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  return /\\[a-zA-Z]+|[=^_]|[+*/<>]|√|\d\s*[a-zA-Z]|[a-zA-Z]\s*\d/.test(text);
}

function readBalancedGroup(value: string, start: number, open: string, close: string): { content: string; end: number } | null {
  if (value[start] !== open) return null;
  let depth = 0;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return { content: value.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function normalizeRootNotation(value: string): string {
  let output = "";
  let index = 0;

  while (index < value.length) {
    const isLatexRoot = value.startsWith("\\sqrt", index);
    const isAsciiRoot = value.startsWith("sqrt", index)
      && (index === 0 || !/[A-Za-z]/.test(value[index - 1] ?? ""));
    const isUnicodeRoot = value[index] === "√";
    if (!isLatexRoot && !isAsciiRoot && !isUnicodeRoot) {
      output += value[index];
      index += 1;
      continue;
    }

    const commandLength = isUnicodeRoot ? 1 : isLatexRoot ? 5 : 4;
    let cursor = index + commandLength;
    while (/\s/.test(value[cursor] ?? "")) cursor += 1;

    let optionalIndex = "";
    if (isLatexRoot && value[cursor] === "[") {
      const group = readBalancedGroup(value, cursor, "[", "]");
      if (group) {
        optionalIndex = `[${group.content}]`;
        cursor = group.end;
        while (/\s/.test(value[cursor] ?? "")) cursor += 1;
      }
    }

    const group = value[cursor] === "(" || value[cursor] === "{"
      ? readBalancedGroup(value, cursor, value[cursor], value[cursor] === "(" ? ")" : "}")
      : null;
    if (group) {
      output += `\\sqrt${optionalIndex}{${group.content}}`;
      index = group.end;
      continue;
    }

    // Support a bare single-token radicand (`sqrt x`, `√x`) without
    // consuming the following equation operator or punctuation.
    const atom = value[cursor]?.match(/[A-Za-z0-9](?:[_^][A-Za-z0-9]+)?/);
    if (atom && atom.index === 0) {
      output += `\\sqrt${optionalIndex}{${atom[0]}}`;
      index = cursor + atom[0].length;
      continue;
    }

    output += value.slice(index, index + commandLength);
    index += commandLength;
  }

  return output;
}

function restoreDamagedLatexCommands(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r(?=\s*(?:ight|angle|ho|vert|Vert|mathrm|m)\b)/g, "\\r")
    .replace(/\f(?=\s*rac\b)/g, "\\f")
    .replace(/\t(?=\s*(?:ext|imes|heta|au|an|riangle)\b)/g, "\\t")
    .replace(/\u0008(?=\s*(?:egin|ig|eta|ar|inom|oldsymbol|mod|ullet)\b)/g, "\\b")
    .replace(/\n(?=\s*(?:eq|abla|ot|u)\b)/g, "\\n")
    // A model that double-serializes JSON often emits `\\frac`. Collapse
    // only the command prefix; preserve `\\` line-breaks in aligned math.
    .replace(/(^|[^\\])\\{2}(?=[A-Za-z])/g, (_, prefix: string) => `${prefix}\\`);
}

export function normalizeLatex(value: string): string {
  let formula = value.trim()
    .replace(/^```(?:latex|tex)?\s*/i, "")
    .replace(/\s*```$/, "");

  // Vision models can JSON-decode LaTeX control sequences into control
  // characters (for example `\\right` becoming CR + `ight`). Restore the
  // known command prefixes before rendering.
  formula = restoreDamagedLatexCommands(formula)
    .replace(/\n\s*(?=ight\b)/g, "\\r");

  const delimiterPairs: Array<[string, string]> = [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]];
  for (const [start, end] of delimiterPairs) {
    const inner = formula.slice(start.length, -end.length);
    const hasNestedDelimiter = start.includes("$") && inner.includes("$");
    if (formula.startsWith(start) && formula.endsWith(end) && formula.length > start.length + end.length && !hasNestedDelimiter) {
      formula = formula.slice(start.length, -end.length).trim();
      break;
    }
  }

  // A truncated OCR fraction can lose the closing brace immediately before
  // a `\\right` delimiter. Close only the unmatched braces in that prefix.
  const rightIndex = formula.indexOf("\\right");
  if (rightIndex >= 0) {
    const prefix = formula.slice(0, rightIndex);
    const openBraces = (prefix.match(/{/g) ?? []).length;
    const closeBraces = (prefix.match(/}/g) ?? []).length;
    if (openBraces > closeBraces) {
      formula = `${prefix}${"}".repeat(openBraces - closeBraces)}${formula.slice(rightIndex)}`;
    }
  }

  // Normalize powers before slash fractions so `v²/R` becomes a real
  // fraction instead of leaving `/R` as literal text.
  formula = formula
    .replace(/²/g, "^{2}")
    .replace(/³/g, "^{3}")
    .replace(/₀/g, "_{0}")
    .replace(/₁/g, "_{1}")
    .replace(/₂/g, "_{2}")
    .replace(/₃/g, "_{3}")
    .replace(/₄/g, "_{4}")
    .replace(/₅/g, "_{5}")
    .replace(/₆/g, "_{6}")
    .replace(/₇/g, "_{7}")
    .replace(/₈/g, "_{8}")
    .replace(/₉/g, "_{9}");

  // OCR frequently drops the backslash from `sqrt(...)`, or emits a
  // parenthesized radicand after `\\sqrt`. Convert both forms first so a
  // following `/n` can be normalized into a stacked fraction.
  formula = normalizeRootNotation(formula);

  // Protect textual/unit groups. A slash in `\mathrm{m/s}` is a unit
  // separator, not a mathematical fraction.
  const protectedGroups: string[] = [];
  formula = formula.replace(/\\(?:mathrm|text|textbf|textrm|textit|textsf|texttt)\{(?:[^{}]|\{[^{}]*\})*\}/g, (match) => {
    const index = protectedGroups.push(match) - 1;
    return `__FORMULA_PROTECTED_${index}__`;
  });

  // Convert parenthesized and simple atom fractions to real LaTeX fractions.
  formula = formula.replace(/\(([^()\n]+)\)\s*\/\s*\(([^()\n]+)\)/g, "\\frac{$1}{$2}");
  formula = formula.replace(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g, "\\frac{$1}{$2}");
  // Keep the match inside the current mathematical atom. The previous broad
  // pattern could start at the `s` in `\\sqrt{gR/3}` and turn the command
  // itself into a fraction. A plain identifier is sufficient here; indexed
  // and powered atoms are handled by the more specific pattern below.
  const compoundIdentifier = String.raw`[A-Za-z][A-Za-z0-9]*`;
  const compoundPattern = new RegExp(`(?<![A-Za-z\\\\])(${compoundIdentifier})\\s*/\\s*(${compoundIdentifier}|\\d+(?:\\.\\d+)?)`, "g");
  formula = formula.replace(compoundPattern, "\\frac{$1}{$2}");
  const fractionSymbol = String.raw`(?:[A-Za-z](?:_\{[^{}]+\}|_[A-Za-z0-9]+|\^\{[^{}]+\}|\^[A-Za-z0-9]+)?|[A-Za-z0-9]+|\d+(?:\.\d+)?)`;
  const fractionAtom = String.raw`(?:\\sqrt\{[^{}]+\}|${fractionSymbol})`;
  const fractionPattern = new RegExp(`(${fractionAtom})\\s*/\\s*(${fractionAtom})`, "g");
  formula = formula.replace(fractionPattern, "\\frac{$1}{$2}");

  formula = formula.replace(/__FORMULA_PROTECTED_(\d+)__/g, (_, index: string) => protectedGroups[Number(index)] ?? "");

  return formula
    .replace(/＝/g, "=")
    .replace(/×/g, "\\times ")
    .replace(/·/g, "\\cdot ")
    .replace(/\*/g, "\\cdot ")
    .replace(/□/g, "\\square")
    .replace(/◻/g, "\\square");
}

export function renderFormulaHtml(value: string, displayMode = false): string | null {
  try {
    return katex.renderToString(normalizeLatex(value), {
      displayMode,
      throwOnError: true,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml"
    });
  } catch {
    return null;
  }
}

export function formulaWithUnit(expression: string, unit?: string): string {
  if (!unit) return expression;
  const safeUnit = unit.replace(/([{}\\])/g, "\\$1");
  return `${expression}\\;\\mathrm{${safeUnit}}`;
}
