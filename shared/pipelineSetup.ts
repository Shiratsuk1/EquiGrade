import type { Rubric } from "./types.js";
import type {
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
