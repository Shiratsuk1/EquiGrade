import type { ScoreWritePayload } from "./types.js";

export const RUIYA_HOSTNAME = "ruiya.onlyets.com";

export type RuiyaScoreField = {
  id: string;
  label?: string;
  maxScore?: number;
  /**
   * A stable site-provided identity, when the score input exposes one.
   * This is deliberately separate from `id`: DOM ids are often generated
   * from the current page and are not enough to align subquestions.
   */
  identity?: string;
};

export type RuiyaScoreAssignment = {
  fieldId: string;
  segmentId: string;
  segmentTitle: string;
  score: number;
  maxScore: number;
};

export type RuiyaScorePlan = {
  source: "total" | "subquestions";
  values: number[];
  assignments?: RuiyaScoreAssignment[];
};

const EPSILON = 1e-6;

function closeEnough(left: number, right: number) {
  return Math.abs(left - right) <= EPSILON;
}

function validScore(score: number, maxScore: number) {
  return Number.isFinite(score) && Number.isFinite(maxScore) && score >= 0 && score <= maxScore + EPSILON;
}

type SemanticIdentity = {
  canonical: Set<string>;
  raw: Set<string>;
};

function normalizedIdentity(value: string) {
  return value
    .replace(/[\uFF08\uFF09]/g, (character) => character === "（" ? "(" : ")")
    .replace(/[\uFF0D\uFF3F]/g, (character) => character === "－" ? "-" : "_")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function canonicalSubquestions(value: string) {
  const text = normalizedIdentity(value);
  if (!text) return new Set<string>();
  const result = new Set<string>();

  // The parent question and subquestion form is the most stable label used
  // by both Ruiya and the grading payload, e.g. `第 14 题（1）`/`14(1)`.
  for (const parentPart of text.matchAll(/(?:第\s*)?(\d+)\s*题?\s*\(\s*(\d+)\s*\)/g)) {
    result.add(`q${parentPart[1]}-p${parentPart[2]}`);
  }
  if (result.size > 0) {
    const parentQuestion = text.match(/(?:第\s*)?(\d+)\s*题?/);
    if (parentQuestion) {
      for (const part of text.matchAll(/\(\s*(\d+)\s*\)/g)) {
        result.add(`q${parentQuestion[1]}-p${part[1]}`);
      }
    }
  }

  // Payload ids and a few site builds use `14-1`, `14_1`, or `14.1`.
  for (const separated of text.matchAll(/(?:第\s*)?(\d+)\s*(?:[-_.:/]|小题\s*)(\d+)(?:\s*小题)?/g)) {
    result.add(`q${separated[1]}-p${separated[2]}`);
  }
  for (const encoded of text.matchAll(/(?:^|[^a-z])q(\d+)\s*[-_:/.]?\s*p(\d+)(?:$|[^a-z])/g)) {
    result.add(`q${encoded[1]}-p${encoded[2]}`);
  }

  // Some pages only show `（1）`; the enclosing question is already fixed by
  // the current Ruiya page, so the subquestion number remains useful and
  // must still be unique within the page.
  if (result.size === 0) {
    for (const partOnly of text.matchAll(/\(\s*(\d+)\s*\)/g)) {
      result.add(`p${partOnly[1]}`);
    }
  }

  // Accept explicit labels such as `第1小题` when no parent number is shown.
  if (result.size === 0) {
    for (const namedPart of text.matchAll(/(?:第\s*)?(\d+)\s*小题|小题\s*(\d+)/g)) {
      result.add(`p${namedPart[1] ?? namedPart[2]}`);
    }
  }

  return result;
}

function semanticIdentity(value: string | undefined, allowRaw: boolean): SemanticIdentity {
  const result: SemanticIdentity = { canonical: new Set(), raw: new Set() };
  if (!value) return result;
  for (const candidate of value.split(/[|;]/)) {
    const text = normalizedIdentity(candidate);
    if (!text) continue;
    const canonical = canonicalSubquestions(text);
    if (canonical.size > 0) canonical.forEach((key) => result.canonical.add(key));
    else if (allowRaw) result.raw.add(text);
  }
  return result;
}

function mergeIdentity(target: SemanticIdentity, source: SemanticIdentity) {
  source.canonical.forEach((key) => target.canonical.add(key));
  source.raw.forEach((key) => target.raw.add(key));
}

function segmentIdentity(segment: ScoreWritePayload["segments"][number]) {
  const result: SemanticIdentity = { canonical: new Set(), raw: new Set() };
  // The id is a stable payload identity. Keep its raw form as an exact-match
  // fallback while also parsing common q/p encodings.
  mergeIdentity(result, semanticIdentity(segment.id, true));
  mergeIdentity(result, semanticIdentity(segment.title, true));
  return result;
}

function fieldIdentity(field: RuiyaScoreField) {
  const result: SemanticIdentity = { canonical: new Set(), raw: new Set() };
  mergeIdentity(result, semanticIdentity(field.identity, true));
  mergeIdentity(result, semanticIdentity(field.label, true));
  return result;
}

function identityKeys(identity: SemanticIdentity) {
  const keys = new Set<string>();
  identity.canonical.forEach((key) => {
    keys.add(`canonical:${key}`);
    const part = key.match(/^q\d+-p(\d+)$/);
    if (part) keys.add(`part:p${part[1]}`);
    const partOnly = key.match(/^p(\d+)$/);
    if (partOnly) keys.add(`part:p${partOnly[1]}`);
  });
  identity.raw.forEach((key) => keys.add(`raw:${key}`));
  return keys;
}

function identityDescription(field: RuiyaScoreField, index: number) {
  return field.label || field.identity || field.id || `第 ${index + 1} 个小题`;
}

function assertUnambiguousIdentity(identity: SemanticIdentity, description: string, kind: "评分框" | "模型小问") {
  if (identity.canonical.size > 1) {
    throw new Error(`睿芽云${kind}“${description}”包含多个不同的小问标识，已拒绝歧义映射`);
  }
  if (identity.canonical.size === 0 && identity.raw.size > 1) {
    throw new Error(`睿芽云${kind}“${description}”包含多个不同的身份标识，已拒绝歧义映射`);
  }
  if (identity.canonical.size === 0 && identity.raw.size === 0) {
    throw new Error(`睿芽云${kind}“${description}”缺少可稳定提取的小问标签，已拒绝写分`);
  }
}

function intersect(left: Set<string>, right: Set<string>) {
  return Array.from(left).filter((key) => right.has(key));
}

export function matchesRuiyaUrl(url: URL) {
  return url.protocol === "https:"
    && url.hostname.toLowerCase() === RUIYA_HOSTNAME
    && /^\/mark\/v\d+\/view\/[^/]+$/i.test(url.pathname);
}

export function buildRuiyaScorePlan(payload: ScoreWritePayload, fields: RuiyaScoreField[]): RuiyaScorePlan {
  if (!validScore(payload.score, payload.maxScore)) throw new Error("教师模型返回的总分超出有效范围");
  if (fields.length === 0) throw new Error("睿芽云当前页面没有可写分数框");

  if (fields.length === 1) {
    const fieldMax = fields[0].maxScore;
    if (fieldMax !== undefined && !closeEnough(fieldMax, payload.maxScore)) {
      throw new Error(`睿芽云总分框满分 ${fieldMax} 与评分模板满分 ${payload.maxScore} 不一致`);
    }
    return { source: "total", values: [payload.score] };
  }

  if (payload.segments.length !== fields.length) {
    throw new Error(`睿芽云识别到 ${fields.length} 个小题总分框，但模型返回 ${payload.segments.length} 个小问结果，已拒绝错位写分`);
  }
  const segmentIdentities = payload.segments.map((segment, index) => {
    const identity = segmentIdentity(segment);
    assertUnambiguousIdentity(identity, segment.title || segment.id, "模型小问");
    return identity;
  });
  const segmentKeys = segmentIdentities.map(identityKeys);
  const seenSegmentKeys = new Map<string, number>();
  segmentKeys.forEach((keys, index) => {
    keys.forEach((key) => {
      const previous = seenSegmentKeys.get(key);
      if (previous !== undefined) {
        throw new Error(`模型小问“${payload.segments[index].title || payload.segments[index].id}”与第 ${previous + 1} 个小问身份重复，已拒绝写分`);
      }
      seenSegmentKeys.set(key, index);
    });
  });

  const fieldIdentities = fields.map((field, index) => {
    const identity = fieldIdentity(field);
    assertUnambiguousIdentity(identity, identityDescription(field, index), "评分框");
    return identity;
  });
  const seenFieldKeys = new Map<string, number>();
  fieldIdentities.forEach((identity, index) => {
    identityKeys(identity).forEach((key) => {
      const previous = seenFieldKeys.get(key);
      if (previous !== undefined) {
        throw new Error(`睿芽云评分框“${identityDescription(fields[index], index)}”与第 ${previous + 1} 个评分框身份重复，已拒绝写分`);
      }
      seenFieldKeys.set(key, index);
    });
  });

  const assignments = fields.map((field, fieldIndex) => {
    const fieldKeys = identityKeys(fieldIdentities[fieldIndex]);
    const candidates = segmentKeys
      .map((keys, segmentIndex) => ({ segmentIndex, matches: intersect(fieldKeys, keys) }))
      .filter((candidate) => candidate.matches.length > 0);
    if (candidates.length === 0) {
      throw new Error(`睿芽云评分框“${identityDescription(field, fieldIndex)}”无法对应模型小问，已拒绝错位写分`);
    }
    if (candidates.length > 1) {
      throw new Error(`睿芽云评分框“${identityDescription(field, fieldIndex)}”可对应多个模型小问，已拒绝歧义映射`);
    }
    const segment = payload.segments[candidates[0].segmentIndex];
    if (!validScore(segment.score, segment.maxScore)) {
      throw new Error(`模型小问“${segment.title || segment.id}”分数超出有效范围`);
    }
    const fieldMax = field.maxScore;
    if (fieldMax !== undefined && !closeEnough(fieldMax, segment.maxScore)) {
      throw new Error(`睿芽云评分框“${identityDescription(field, fieldIndex)}”满分 ${fieldMax} 与模型小问“${segment.title || segment.id}”满分 ${segment.maxScore} 不一致`);
    }
    return {
      fieldId: field.id,
      segmentId: segment.id,
      segmentTitle: segment.title,
      score: segment.score,
      maxScore: segment.maxScore
    } satisfies RuiyaScoreAssignment;
  });

  const assignedSegmentIndexes = new Set(assignments.map((assignment) => payload.segments.findIndex((segment) => segment.id === assignment.segmentId)));
  if (assignedSegmentIndexes.size !== payload.segments.length) {
    throw new Error("睿芽云评分框与模型小问未形成一一对应关系，已拒绝错位写分");
  }
  const segmentScores = assignments.map((assignment) => assignment.score);
  const segmentMaximum = payload.segments.reduce((sum, segment) => sum + segment.maxScore, 0);
  if (!closeEnough(segmentMaximum, payload.maxScore)) {
    throw new Error(`模型各小问满分之和 ${segmentMaximum} 与评分模板总分 ${payload.maxScore} 不一致`);
  }
  const segmentTotal = segmentScores.reduce((sum, score) => sum + score, 0);
  if (!closeEnough(segmentTotal, payload.score)) {
    throw new Error(`模型各小问得分之和 ${segmentTotal} 与模型总分 ${payload.score} 不一致`);
  }
  return { source: "subquestions", values: segmentScores, assignments };
}

export function parseRuiyaProgress(text: string): { completed: number; total: number } | undefined {
  const totalMatch = text.match(/计划量\s*[:：]?\s*(\d+)/);
  const completedMatch = text.match(/已阅(?:量)?\s*[:：]?\s*(\d+)/);
  if (!totalMatch || !completedMatch) return undefined;
  return { completed: Number(completedMatch[1]), total: Number(totalMatch[1]) };
}

export function isRuiyaBatchCompletionText(text: string): boolean {
  return /已完成阅卷任务|任务量已全部完成/.test(text.replace(/\s+/g, " ").trim());
}
