import type { PipelineEvent } from "./electron.js";

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
  "page_failed",
  "plugin_preflight_failed",
  "browser_load_failed"
]);

const warningEvents = new Set([
  "page_skipped",
  "pipeline_paused",
  "pipeline_paused_stale_answer",
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
    case "plugin_preflight_completed": return "站点控件检查通过";
    case "plugin_preflight_failed": return "站点控件检查失败";
    case "image_extracted": return `已提取答卷 ${event.sourcePageKey || event.pageKey || "当前页"}`;
    case "page_completed": return `已提交 ${event.score ?? "--"} / ${event.maxScore ?? "--"} 分`;
    case "pipeline_start_rejected": return `启动失败：${reason || "尚未选择批改任务"}`;
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
