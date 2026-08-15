import { describe, expect, it } from "vitest";
import {
  beginOperation,
  completeOperation,
  forceStopOperation,
  getLogSnapshot,
  getOperationSignal,
  throwIfOperationCancelled
} from "./systemLog.js";

describe("operation force stop", () => {
  it("aborts cancellable operations and records one terminal event", () => {
    const operationId = beginOperation("grading", "开始批改测试答卷", "vision_direct_grade");
    const signal = getOperationSignal(operationId);

    expect(signal?.aborted).toBe(false);
    expect(forceStopOperation(operationId)).toMatchObject({ id: operationId, cancellable: true });
    expect(signal?.aborted).toBe(true);
    expect(() => throwIfOperationCancelled(operationId)).toThrow("强制停止");

    completeOperation(operationId, "grading", "grading_completed", "不应写入的完成事件");
    const snapshot = getLogSnapshot(20);
    expect(snapshot.activeOperations.some((operation) => operation.id === operationId)).toBe(false);
    expect(snapshot.entries.filter((entry) => entry.operationId === operationId && entry.step === "operation_force_stopped")).toHaveLength(1);
    expect(snapshot.entries.some((entry) => entry.operationId === operationId && entry.step === "grading_completed")).toBe(false);
  });

  it("does not expose force stop for short storage operations", () => {
    const operationId = beginOperation("storage", "保存模板", "save_template");
    expect(forceStopOperation(operationId)).toBeNull();
    completeOperation(operationId, "storage", "template_ready", "模板已保存");
  });
});
