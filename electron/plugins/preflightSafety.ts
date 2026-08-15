import type { PluginCapabilities } from "../../shared/electron.js";
import type { PreflightResult } from "./types.js";

export type PreflightTarget = {
  generation: number;
  url: string;
};

export function emptyPluginCapabilities(): PluginCapabilities {
  return {
    answerImage: false,
    scoreInput: false,
    submit: false,
    next: false,
    skip: false
  };
}

export function hasRequiredPluginCapabilities(capabilities: PluginCapabilities) {
  return capabilities.answerImage
    && capabilities.scoreInput
    && capabilities.submit
    && capabilities.next;
}

export function sanitizePreflightResult(result: PreflightResult, batchComplete: boolean): PreflightResult {
  const hasStablePageKey = typeof result.pageKey === "string" && result.pageKey.trim().length > 0;
  const usable = result.ok && (batchComplete || (hasRequiredPluginCapabilities(result.capabilities) && hasStablePageKey));
  if (usable) return result;

  const issues = [...result.issues];
  if (result.ok && !batchComplete && !hasRequiredPluginCapabilities(result.capabilities)) {
    issues.push("未同时识别学生答卷区域、分数输入框、提交按钮和下一份按钮");
  }
  if (result.ok && !batchComplete && !hasStablePageKey) {
    issues.push("无法生成当前答卷的稳定页面标识");
  }
  return {
    ...result,
    ok: false,
    issues: [...new Set(issues)],
    capabilities: emptyPluginCapabilities(),
    pageKey: undefined
  };
}

export function samePreflightTarget(expected: PreflightTarget, current: PreflightTarget) {
  return expected.generation === current.generation && expected.url === current.url;
}
