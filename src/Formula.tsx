import { useMemo } from "react";
import { splitFormulaTextBlocks, type FormulaTextBlock } from "../shared/formulaProtocol";
import { isLikelyFormula, renderFormulaHtml } from "./math";

type MathTextPart = FormulaTextBlock;

function containsCjk(value: string) {
  return /[\u3400-\u9fff\u3040-\u30ff]/.test(value);
}

function removeLatexTextBlocks(value: string) {
  return value.replace(/\\text(?:bf|rm|it|sf|tt|normal)?\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
}

function canRenderAsWholeFormula(value: string) {
  const text = value.trim();
  if (!text || text.length > 1600 || !isLikelyFormula(text)) return false;
  // Chinese labels inside \text{...} are valid LaTeX. Only reject prose
  // when Chinese remains outside a recognized LaTeX text block.
  return !containsCjk(removeLatexTextBlocks(text)) && Boolean(renderFormulaHtml(text));
}

function canRenderAsMixedFormula(value: string) {
  const text = value.trim();
  const hasStrongMathSignal = /\\[a-zA-Z]+|[=^_+*/<>]|√|\d\s*[a-z]/.test(text);
  return hasStrongMathSignal && canRenderAsWholeFormula(text);
}

function restoreProtectedText(value: string, protectedBlocks: string[]) {
  return value.replace(/\uE000(\d+)\uE001/g, (_, index: string) => protectedBlocks[Number(index)] ?? "");
}

function appendFormulaCandidate(parts: MathTextPart[], value: string, protectedBlocks: string[]) {
  if (!value) return;
  const restored = restoreProtectedText(value, protectedBlocks);
  const leading = restored.match(/^\s*/)?.[0] ?? "";
  const trailing = restored.match(/\s*$/)?.[0] ?? "";
  const core = restored.slice(leading.length, restored.length - trailing.length);

  if (leading) parts.push({ type: "text", value: leading });
  if (core) {
    parts.push(canRenderAsMixedFormula(core)
      ? { type: "math", value: core, display: false }
      : { type: "text", value: core });
  }
  if (trailing) parts.push({ type: "text", value: trailing });
}

function splitMixedFormulaText(value: string): MathTextPart[] {
  const protectedBlocks: string[] = [];
  const masked = value.replace(/\\text(?:bf|rm|it|sf|tt|normal)?\{(?:[^{}]|\{[^{}]*\})*\}/g, (match) => {
    const index = protectedBlocks.push(match) - 1;
    return `\uE000${index}\uE001`;
  });
  const parts: MathTextPart[] = [];
  const boundaryPattern = /([\u3400-\u9fff\u3040-\u30ff]+|[，。；：、！？]|[;:])/g;
  let cursor = 0;

  for (const match of masked.matchAll(boundaryPattern)) {
    const index = match.index ?? 0;
    appendFormulaCandidate(parts, masked.slice(cursor, index), protectedBlocks);
    parts.push({ type: "text", value: restoreProtectedText(match[0], protectedBlocks) });
    cursor = index + match[0].length;
  }
  appendFormulaCandidate(parts, masked.slice(cursor), protectedBlocks);

  return parts.length ? parts : [{ type: "text", value }];
}

export function Formula({ value, display = false, auto = false, className = "" }: {
  value: string;
  display?: boolean;
  auto?: boolean;
  className?: string;
}) {
  const shouldRender = !auto || isLikelyFormula(value);
  const html = useMemo(
    () => shouldRender ? renderFormulaHtml(value, display) : null,
    [display, shouldRender, value]
  );

  if (!shouldRender) return <span className={className}>{value}</span>;
  if (!html) return <code className={`formula-fallback ${className}`} title="公式解析失败，已显示原文"><span className="formula-fallback-label">原文</span><span>{value}</span></code>;

  return <span
    className={`formula-rendered${display ? " display" : ""}${className ? ` ${className}` : ""}`}
    aria-label={value}
    title={value}
    dangerouslySetInnerHTML={{ __html: html }}
  />;
}

export function MathText({ value, className = "", formulaByDefault = false }: { value: string; className?: string; formulaByDefault?: boolean }) {
  const explicitBlocks = splitFormulaTextBlocks(value);
  const hasExplicitFormula = explicitBlocks.some((block) => block.type === "math");
  if (formulaByDefault && !hasExplicitFormula && canRenderAsWholeFormula(value)) {
    return <span className={`math-text math-format-deterministic${className ? ` ${className}` : ""}`}><Formula value={value} display /></span>;
  }

  const parts = explicitBlocks.flatMap<MathTextPart>((block) => {
    if (block.type === "math" || !formulaByDefault) return [block];
    return splitMixedFormulaText(block.value);
  });

  return <span className={`math-text math-format-deterministic${className ? ` ${className}` : ""}`}>{parts.map((part, index) => {
    if (part.type === "math") return <Formula key={index} value={part.value} display={part.display} />;
    return <span className="math-text-copy" key={index}>{part.value}</span>;
  })}</span>;
}
