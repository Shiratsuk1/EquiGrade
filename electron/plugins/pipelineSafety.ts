import type { ExtractedAnswer } from "./types.js";

export class StaleAnswerError extends Error {
  readonly code = "STALE_ANSWER" as const;

  constructor(message: string) {
    super(message);
    this.name = "StaleAnswerError";
  }
}

export function isStaleAnswerError(error: unknown): error is StaleAnswerError {
  return error instanceof StaleAnswerError;
}

export type PipelineCommitStage = "untouched" | "write_started" | "score_written" | "submit_started" | "verified";

export function assertSameAnswer(expected: ExtractedAnswer, current: ExtractedAnswer) {
  if (expected.imageHash !== current.imageHash) {
    throw new StaleAnswerError("模型批改期间答卷图像已经变化，已拒绝写入旧答卷分数");
  }
  if (expected.sourcePageKey && expected.sourcePageKey !== current.sourcePageKey) {
    throw new StaleAnswerError("模型批改期间阅卷页面已经切换，已拒绝写入旧答卷分数");
  }
  if (expected.pageToken && expected.pageToken !== current.pageToken) {
    throw new StaleAnswerError("模型批改期间当前答卷实例已经变化，已拒绝写入旧答卷分数");
  }
}

export function failureRequiresPause(stage: PipelineCommitStage) {
  return stage !== "untouched";
}

export function commitFailureMessage(stage: PipelineCommitStage, reason: string) {
  if (stage === "verified") return `分数已确认提交，但自动翻页失败：${reason}`;
  if (stage === "submit_started") return `已点击提交但保存状态无法确认，必须人工核对当前答卷：${reason}`;
  return `分数写入过程未完整结束，已停留在当前答卷等待人工核对：${reason}`;
}
