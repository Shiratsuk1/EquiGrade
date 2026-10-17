import type { PipelineEvent } from "./electron.js";
import type { SystemLogEntry } from "./types.js";

/**
 * 流水线事件的共享文案与风险色调映射。
 * 事件类型由 electron/plugins/runtime.ts 产生，桌面端在此统一消费；
 * 新增事件类型时只需在此表补充，避免产生端/文案端多处散落。
 */

export type PipelineEventTone = "error" | "warning" | "success" | "active";

/** 清理 IPC 错误前缀（"Error invoking remote method ..." / "Error: "），得到可读原因。 */
export function cleanPipelineError(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

const errorEvents = new Set([
  "pipeline_start_rejected",
  "pipeline_question_mismatch_rejected",
  "page_failed",
  "plugin_preflight_failed",
  "browser_load_failed"
]);

const warningEvents = new Set([
  "page_skipped",
  "page_retry",
  "page_review_flagged",
  "page_marked_excellent",
  "pipeline_paused",
  "pipeline_paused_stale_answer",
  "pipeline_question_mismatch_stopped",
  "pipeline_force_stopped",
  "pipeline_skip_rejected"
]);

const successEvents = new Set([
  "page_completed",
  "pipeline_completed",
  "pipeline_completed_after_skip"
]);

/** 流水线事件的风险色调：错误 / 警告 / 成功 / 进行中。 */
export function pipelineEventTone(event: PipelineEvent): PipelineEventTone {
  const type = event.type ?? "";
  if (errorEvents.has(type)) return "error";
  if (warningEvents.has(type)) return "warning";
  if (successEvents.has(type)) return "success";
  return "active";
}

/** 事件的中文展示文案；未收录的事件显示 message 或原始类型。 */
export function pipelineEventLabel(event: PipelineEvent): string {
  const reason = cleanPipelineError(event.reason);
  switch (event.type) {
    case "pipeline_started": return "流水线已启动";
    case "pipeline_template_bound": return "评分标准已绑定到当前任务";
    case "pipeline_template_restored": return "已恢复当前评分标准绑定";
    case "plugin_preflight_completed": return "站点控件检查通过";
    case "plugin_preflight_failed": return "站点控件检查失败";
    case "image_extracted": return `已提取答卷 ${event.sourcePageKey || event.pageKey || "当前页"}`;
    case "page_review_flagged": return `已标记复核，继续写分 ${event.score ?? "--"} / ${event.maxScore ?? "--"} 分（${event.reviewCount ?? "?"} 项）`;
    case "page_marked_excellent": return "已在卷面勾选“优”控件作为存疑标记，方便人工回评";
    case "page_completed": return `已提交 ${event.score ?? "--"} / ${event.maxScore ?? "--"} 分${event.requiresReview ? "（已标记复核）" : ""}`;
    case "grading_completed": return event.summary ? `智能批改完成：${event.summary}` : `智能批改完成，初判得分 ${event.score ?? "--"} / ${event.maxScore ?? "--"} 分`;
    case "score_writing": return `本地计分确认 ${event.score ?? "--"} / ${event.maxScore ?? "--"} 分，写入网页评分框`;
    case "pipeline_start_rejected": return `启动失败：${reason || "尚未选择批改任务"}`;
    case "pipeline_question_mismatch_rejected": return `启动被阻断：${reason || "网页题目与评分标准不一致"}`;
    case "pipeline_question_mismatch_stopped": return `已安全暂停：${reason || "检测到网页题目切换，与当前评分标准不一致"}`;
    case "page_failed": return `处理失败：${reason || "未知异常"}`;
    case "page_retry": return `自动重试 ${event.attempt ?? "?"}/${event.maxAttempts ?? "?"}：${reason || "正在重试当前答卷"}`;
    case "page_skipped": return `已跳过：${reason || "当前答卷"}`;
    case "pipeline_paused": return `已暂停：${reason || "等待人工处理"}`;
    case "pipeline_paused_stale_answer": return "已暂停：检测到答卷在模型批改期间发生切换";
    case "pipeline_force_stopped": return "流水线已被用户强制停止";
    case "pipeline_completed": return "当前批次已完成";
    case "pipeline_completed_after_skip": return "跳过异常答卷后批次完成";
    case "browser_load_failed": return `网页加载失败：${reason || "未知异常"}`;
    case "pipeline_skip_rejected": return `跳过被拒绝：${reason || "当前页面不支持跳过"}`;
    default: return String(event.message || event.type || "流水线事件");
  }
}

/**
 * 简洁版运行日志过滤器：
 * 正常情况下一份小题（或大题）的全生命周期严格控制在 4 条关键消息以内：
 * 1. image_extracted (提取答卷)
 * 2. grading_completed (作答识别与判定结论)
 * 3. score_writing (本地计分确认与写入)
 * 4. page_completed (提交成功与翻页)
 * 
 * 异常、报错与存疑事件（无条件透出展示）：
 * - 错误级别：plugin_preflight_failed, page_failed, pipeline_question_mismatch_rejected, browser_load_failed 等
 * - 警告/存疑级别：page_review_flagged, page_marked_excellent, pipeline_paused*, page_skipped 等
 * - 批次生命周期：pipeline_started, pipeline_completed
 * 
 * 过滤掉琐碎的高频微观阶段转换（pipeline_phase）与成功的周期性预检心跳（plugin_preflight_completed）。
 */
export function isConcisePipelineEvent(event: PipelineEvent): boolean {
  const type = event.type ?? "";
  if (errorEvents.has(type) || warningEvents.has(type)) return true;
  if (type === "image_extracted" || type === "grading_completed" || type === "score_writing" || type === "page_completed") return true;
  if (type === "pipeline_started" || type === "pipeline_completed" || type === "pipeline_completed_after_skip") return true;
  return false;
}

/**
 * 简洁版系统日志过滤器（用于运行日志全量流筛选）：
 * 1. 任何级别为 error / warning，或 status 为 failed 的日志无条件保留展示
 * 2. 流水线步骤（step 前缀为 pipeline:）：使用 isConcisePipelineEvent 严格把控，单题正常周期 4 条
 * 3. 评分标准保存等关键管理操作（scope: storage 且 step 为 template_saved / template_updated）保留
 * 4. 隐藏内部常规模型调用明细、逐点打分演算与高频探针
 */
export function isConciseLogEntry(entry: SystemLogEntry): boolean {
  if (entry.level === "error" || entry.level === "warning" || entry.status === "failed") {
    return true;
  }
  if (entry.step.startsWith("pipeline:")) {
    const event = (entry.details || {}) as PipelineEvent;
    return isConcisePipelineEvent(event);
  }
  if (entry.scope === "storage" && (entry.step === "template_saved" || entry.step === "template_updated")) {
    return true;
  }
  return false;
}

