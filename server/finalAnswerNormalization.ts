import type { AnswerPresence, FinalAnswerJudgement } from "../shared/types.js";

const ARTIFACT_PATTERN = /(扫描|阴影|纸张|背景|边缘|装订|灰度|噪声|压痕|擦除|残留|孤立|短线|拖影|纹理|scan|shadow|background|noise|crease|artifact)/i;
const VAGUE_UNREADABLE_PATTERN = /(线条不清晰|字迹.{0,8}模糊|内容.{0,8}模糊|无法可靠识别|看不清|不清晰|模糊)/i;

export interface FinalAnswerNormalizationResult {
  judgement: FinalAnswerJudgement;
  changed: boolean;
  reasons: string[];
}

function hasMeaningfulAnswer(judgement: Pick<FinalAnswerJudgement, "studentAnswer" | "evidenceLineIds">): boolean {
  return Boolean(judgement.studentAnswer.trim()) && judgement.evidenceLineIds.length > 0;
}

function inferPresence(judgement: Pick<FinalAnswerJudgement, "status" | "studentAnswer" | "evidenceLineIds" | "reason" | "answerPresence">): AnswerPresence {
  if (judgement.answerPresence) return judgement.answerPresence;
  if (judgement.status === "missing" && !judgement.studentAnswer.trim()) return "no_effective_answer";
  if (judgement.status === "uncertain" && (judgement.studentAnswer.trim() || judgement.evidenceLineIds.length)) return "unreadable_answer";
  if (hasMeaningfulAnswer(judgement)) return judgement.status === "correct" || judgement.status === "incorrect" ? "confirmed_answer" : "probable_answer";
  if (judgement.status === "uncertain") return ARTIFACT_PATTERN.test(judgement.reason) ? "no_effective_answer" : "unreadable_answer";
  return "image_unreliable";
}

/**
 * Enforces the evidence contract after model parsing. The raw model result is
 * kept by the caller; this function only returns the score-bearing projection.
 */
export function normalizeFinalAnswerJudgement(judgement: FinalAnswerJudgement): FinalAnswerNormalizationResult {
  const reasons: string[] = [];
  const presence = inferPresence(judgement);
  let status = judgement.status;
  let studentAnswer = judgement.studentAnswer.trim();
  let evidenceLineIds = [...new Set(judgement.evidenceLineIds)];

  if (presence === "no_effective_answer") {
    if (status !== "missing") reasons.push("no_effective_answer_forced_missing");
    if (studentAnswer || evidenceLineIds.length) reasons.push("cleared_non_answer_evidence");
    status = "missing";
    studentAnswer = "";
    evidenceLineIds = [];
  } else if (status === "incorrect" && !studentAnswer && !evidenceLineIds.length && presence !== "confirmed_answer") {
    status = presence === "unreadable_answer" ? "uncertain" : "missing";
    reasons.push("incorrect_without_answer_evidence");
    if (status === "missing") {
      studentAnswer = "";
      evidenceLineIds = [];
    }
  } else if (status === "uncertain" && !evidenceLineIds.length && !studentAnswer) {
    if (ARTIFACT_PATTERN.test(judgement.reason) || VAGUE_UNREADABLE_PATTERN.test(judgement.reason)) {
      status = "missing";
      reasons.push("vague_unreadable_without_candidate_evidence");
    } else {
      reasons.push("uncertain_without_candidate_evidence");
    }
  }

  const next: FinalAnswerJudgement = {
    ...judgement,
    status,
    answerPresence: judgement.answerPresence ?? (status === "missing" ? "no_effective_answer" : presence),
    studentAnswer,
    evidenceLineIds,
    reason: reasons.length ? `${judgement.reason.trim()}；后端归一化：${reasons.join("、")}` : judgement.reason
  };
  return {
    judgement: next,
    changed: status !== judgement.status
      || studentAnswer !== judgement.studentAnswer
      || evidenceLineIds.length !== judgement.evidenceLineIds.length,
    reasons
  };
}

export function normalizeFinalAnswerJudgements(judgements: FinalAnswerJudgement[]): {
  judgements: FinalAnswerJudgement[];
  reasons: string[];
} {
  const normalized = judgements.map((item) => normalizeFinalAnswerJudgement(item));
  return {
    judgements: normalized.map((item) => item.judgement),
    reasons: normalized.flatMap((item) => item.reasons.map((reason) => `${item.judgement.subquestionId}:${reason}`))
  };
}

export function isLockedMissingJudgement(judgement: Pick<FinalAnswerJudgement, "status" | "answerPresence">): boolean {
  return judgement.status === "missing" && judgement.answerPresence === "no_effective_answer";
}
