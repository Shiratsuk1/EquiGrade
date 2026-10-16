import type { Rubric } from "./types.js";
import type {
  PipelineQuestionAlignment,
  PipelineScoreAlignment,
  PipelineScoreAlignmentRow,
  PipelineScoreAlignmentSource,
  TargetScoreField
} from "./electron.js";

type AlignmentCandidate = {
  id: string;
  label: string;
  maxScore: number;
};

const EPSILON = 1e-6;

function closeEnough(left: number | undefined, right: number | undefined) {
  return left !== undefined && right !== undefined && Math.abs(left - right) <= EPSILON;
}

function candidateRows(fields: TargetScoreField[], candidates: AlignmentCandidate[]) {
  return fields.map<PipelineScoreAlignmentRow>((field, index) => {
    const candidate = candidates[index];
    return {
      targetId: field.id,
      targetLabel: field.label,
      targetMaxScore: field.maxScore,
      sourceId: candidate?.id,
      sourceLabel: candidate?.label,
      sourceMaxScore: candidate?.maxScore,
      matched: Boolean(candidate && closeEnough(field.maxScore, candidate.maxScore))
    };
  });
}

function tryCandidate(
  fields: TargetScoreField[],
  candidates: AlignmentCandidate[],
  source: PipelineScoreAlignmentSource
) {
  if (fields.length !== candidates.length) return undefined;
  const rows = candidateRows(fields, candidates);
  if (!rows.every((row) => row.matched)) return undefined;
  return { source, rows };
}

export function buildPipelineScoreAlignment(rubric: Rubric, fields: TargetScoreField[]): PipelineScoreAlignment {
  if (!fields.length) return { ok: false, rows: [], issues: ["阅卷页面没有可识别的评分栏"] };
  const unknownMaximums = fields.filter((field) => field.maxScore === undefined);
  if (unknownMaximums.length) {
    return {
      ok: false,
      rows: fields.map((field) => ({
        targetId: field.id,
        targetLabel: field.label,
        targetMaxScore: field.maxScore,
        matched: false
      })),
      issues: [`${unknownMaximums.length} 个网页评分栏缺少明确满分，无法安全匹配`]
    };
  }

  if (fields.length === 1) {
    const matched = closeEnough(fields[0].maxScore, rubric.totalScore);
    return {
      ok: matched,
      source: "total",
      issues: matched
        ? []
        : [`网页满分 ${fields[0].maxScore} 与评分标准总分 ${rubric.totalScore} 不一致`],
      rows: [{
        targetId: fields[0].id,
        targetLabel: fields[0].label,
        targetMaxScore: fields[0].maxScore,
        sourceId: rubric.title,
        sourceLabel: "模板总分",
        sourceMaxScore: rubric.totalScore,
        matched
      }]
    };
  }

  const subquestions = rubric.subquestions.map((item) => ({
    id: item.id,
    label: item.title,
    maxScore: item.maxScore
  }));
  const subquestionMatch = tryCandidate(fields, subquestions, "subquestions");
  if (subquestionMatch) return { ok: true, issues: [], ...subquestionMatch };

  const points = rubric.subquestions.flatMap((subquestion) => subquestion.scorePoints.map((point) => ({
    id: `${subquestion.id}:${point.id}`,
    label: point.title,
    maxScore: point.score
  })));
  const pointMatch = tryCandidate(fields, points, "points");
  if (pointMatch) return { ok: true, issues: [], ...pointMatch };

  const candidates = fields.length === subquestions.length ? subquestions : points;
  return {
    ok: false,
    rows: candidateRows(fields, candidates),
    issues: [
      `网页有 ${fields.length} 个评分栏；模板有 ${subquestions.length} 个小问、${points.length} 个评分点，数量、顺序或满分不一致`
    ]
  };
}

const CHINESE_DIGITS: Record<string, number> = {
  "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9
};

export function parseChineseNumber(raw: string): number | undefined {
  if (!raw) return undefined;
  if (raw === "十") return 10;
  if (raw.length === 1 && CHINESE_DIGITS[raw] !== undefined) return CHINESE_DIGITS[raw];
  if (raw.startsWith("十") && raw.length === 2 && CHINESE_DIGITS[raw[1]] !== undefined) {
    return 10 + CHINESE_DIGITS[raw[1]];
  }
  const parts = raw.split("十");
  if (parts.length === 2) {
    const tens = parts[0] ? CHINESE_DIGITS[parts[0]] : 1;
    const ones = parts[1] ? CHINESE_DIGITS[parts[1]] : 0;
    if (tens !== undefined && ones !== undefined) {
      return tens * 10 + ones;
    }
  }
  return undefined;
}

export function parseQuestionNumber(text: string | undefined): number | undefined {
  if (!text || typeof text !== "string") return undefined;
  const cleaned = text.trim();
  if (!cleaned) return undefined;

  // 1. "第\s*(\d+)\s*题" (例如 "第12题", "共3题 第12题", "第 12 题", "第12题 实验题")
  const arabicMatch = cleaned.match(/第\s*(\d+)\s*题/);
  if (arabicMatch) return parseInt(arabicMatch[1], 10);

  // 2. 中文数字: "第\s*([一二两三四五六七八九十]+)\s*题" (例如 "第十二题")
  const chineseMatch = cleaned.match(/第\s*([一二两三四五六七八九十]+)\s*题/);
  if (chineseMatch) {
    const parsed = parseChineseNumber(chineseMatch[1]);
    if (parsed !== undefined) return parsed;
  }

  // 3. "题号[：:\s]*(\d+)"
  const qNumMatch = cleaned.match(/题号\s*[：:\s]\s*(\d+)\b/);
  if (qNumMatch) return parseInt(qNumMatch[1], 10);

  // 4. "T(\d+)" or "Q(\d+)" or "No\.?\s*(\d+)"
  const tqMatch = cleaned.match(/\b(?:T|Q|No\.?)\s*(\d+)\b/i);
  if (tqMatch) return parseInt(tqMatch[1], 10);

  // 5. 行首/句首题号: "^(\d+)[\.\s、]" (例如 "12. 实验题")
  const leadingMatch = cleaned.match(/^(\d+)[\.\s、]/);
  if (leadingMatch) return parseInt(leadingMatch[1], 10);

  return undefined;
}

export function verifyQuestionAlignment(options: {
  pageQuestionLabel?: string;
  rubricTitle?: string;
  pageTitle?: string;
}): PipelineQuestionAlignment {
  const { pageQuestionLabel, rubricTitle = "", pageTitle } = options;
  const candidatePageText = pageQuestionLabel?.trim() || pageTitle?.trim() || "";
  const pageNumber = parseQuestionNumber(candidatePageText);
  const rubricNumber = parseQuestionNumber(rubricTitle);

  if (pageNumber !== undefined && rubricNumber !== undefined && pageNumber !== rubricNumber) {
    const labelDesc = pageQuestionLabel?.trim() ? `【${pageQuestionLabel.trim()}】` : "";
    return {
      ok: false,
      pageQuestion: candidatePageText,
      rubricTitle,
      extractedPageNumber: pageNumber,
      extractedRubricNumber: rubricNumber,
      issues: [
        `阅卷页面题目为${labelDesc}（第 ${pageNumber} 题），而当前绑定的评分标准为【${rubricTitle}】（第 ${rubricNumber} 题），题号不一致！为杜绝串题误判，已阻止批改。请先在工作台切换为对应的评分标准。`
      ]
    };
  }

  return {
    ok: true,
    pageQuestion: candidatePageText || undefined,
    rubricTitle,
    extractedPageNumber: pageNumber,
    extractedRubricNumber: rubricNumber,
    issues: []
  };
}
