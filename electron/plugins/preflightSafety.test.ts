import { describe, expect, it } from "vitest";
import {
  emptyPluginCapabilities,
  hasRequiredPluginCapabilities,
  samePreflightTarget,
  sanitizePreflightResult
} from "./preflightSafety.js";

const completeCapabilities = {
  answerImage: true,
  scoreInput: true,
  submit: true,
  next: true,
  skip: true
};

describe("preflight safety gate", () => {
  it("requires all four grading capabilities", () => {
    expect(hasRequiredPluginCapabilities(completeCapabilities)).toBe(true);
    expect(hasRequiredPluginCapabilities({ ...completeCapabilities, next: false })).toBe(false);
    expect(emptyPluginCapabilities()).toEqual({ answerImage: false, scoreInput: false, submit: false, next: false, skip: false });
  });

  it("clears partial capabilities when a preflight fails", () => {
    const result = sanitizePreflightResult({
      ok: false,
      issues: ["未找到提交按钮"],
      capabilities: { ...completeCapabilities, submit: false },
      pageKey: "old-page"
    }, false);

    expect(result.ok).toBe(false);
    expect(result.capabilities).toEqual(emptyPluginCapabilities());
    expect(result.pageKey).toBeUndefined();
    expect(result.issues).toContain("未找到提交按钮");
  });

  it("rejects an adapter that reports success without all required controls", () => {
    const result = sanitizePreflightResult({
      ok: true,
      issues: [],
      capabilities: { ...completeCapabilities, next: false },
      pageKey: "page-without-next"
    }, false);

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("未同时识别学生答卷区域、分数输入框、提交按钮和下一份按钮");
    expect(result.capabilities).toEqual(emptyPluginCapabilities());
  });

  it("rejects a page that has controls but no stable page key", () => {
    const result = sanitizePreflightResult({
      ok: true,
      issues: [],
      capabilities: completeCapabilities,
      pageKey: undefined
    }, false);

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("无法生成当前答卷的稳定页面标识");
    expect(result.capabilities).toEqual(emptyPluginCapabilities());
  });

  it("allows a completed batch to remain a terminal state without exposing it as a grading page", () => {
    const result = sanitizePreflightResult({
      ok: true,
      issues: [],
      capabilities: { ...completeCapabilities, submit: false, next: false },
      pageKey: "completed-batch"
    }, true);

    expect(result.ok).toBe(true);
    expect(result.capabilities.submit).toBe(false);
    expect(result.capabilities.next).toBe(false);
  });

  it("does not treat an old preflight result as belonging to a new page", () => {
    expect(samePreflightTarget(
      { generation: 3, url: "https://www.zhixue.com/login.html" },
      { generation: 4, url: "https://www.zhixue.com/htm-container-web/index.html" }
    )).toBe(false);
    expect(samePreflightTarget(
      { generation: 4, url: "https://www.zhixue.com/htm-container-web/index.html" },
      { generation: 4, url: "https://www.zhixue.com/htm-container-web/index.html" }
    )).toBe(true);
  });
});
