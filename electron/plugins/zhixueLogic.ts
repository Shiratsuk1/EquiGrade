import type { ScoreWritePayload } from "./types.js";

export type ZhixueScoreField = {
  id: string;
  maxScore?: number;
};

export type ZhixueScorePlan = {
  source: "total";
  values: number[];
};

const EPSILON = 1e-6;

function closeEnough(left: number, right: number) {
  return Math.abs(left - right) <= EPSILON;
}

function validScore(score: number, maxScore: number) {
  return Number.isFinite(score) && Number.isFinite(maxScore) && score >= 0 && score <= maxScore + EPSILON;
}

export function matchesZhixueUrl(url: URL) {
  const hostname = url.hostname.toLowerCase();
  const isZhixue = hostname === "zhixue.com" || hostname.endsWith(".zhixue.com");
  if (url.protocol !== "https:" || !isZhixue) return false;
  return url.pathname.startsWith("/htm-container-web/") || url.pathname.startsWith("/webmarking/");
}

export function buildZhixueScorePlan(payload: ScoreWritePayload, fields: ZhixueScoreField[]): ZhixueScorePlan {
  if (!validScore(payload.score, payload.maxScore)) throw new Error("教师模型返回的总分超出有效范围");
  if (fields.length !== 1) throw new Error(`智学网总分模式要求且只允许一个分数框，当前识别到 ${fields.length} 个`);
  const fieldMax = fields[0].maxScore;
  if (fieldMax !== undefined && !closeEnough(fieldMax, payload.maxScore)) {
    throw new Error(`智学网总分框满分 ${fieldMax} 与评分模板满分 ${payload.maxScore} 不一致`);
  }
  return { source: "total", values: [payload.score] };
}
