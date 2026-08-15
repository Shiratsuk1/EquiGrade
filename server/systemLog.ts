import type {
  ActiveOperation,
  ModelCallHistoryEntry,
  SystemLogEntry,
  SystemLogLevel,
  SystemLogSnapshot,
  SystemLogStatus
} from "../shared/types.js";

const maxEntries = 1000;
const maxCapturedOperations = 100;
const entries: SystemLogEntry[] = [];
const activeOperations = new Map<string, ActiveOperation>();
const operationControllers = new Map<string, AbortController>();
const cancelledOperationIds = new Set<string>();
const modelCallsByOperation = new Map<string, ModelCallHistoryEntry[]>();

export class OperationCancelledError extends Error {
  constructor(message = "任务已被用户强制停止") {
    super(message);
    this.name = "OperationCancelledError";
  }
}

export function isOperationCancelled(error: unknown): boolean {
  return error instanceof OperationCancelledError
    || (error instanceof Error && error.name === "OperationCancelledError");
}

function isModelCallEntry(entry: SystemLogEntry): entry is ModelCallHistoryEntry {
  return entry.scope === "model" && entry.step === "model_call" && entry.details?.kind === "model_call";
}

function captureModelCall(entry: ModelCallHistoryEntry) {
  if (!modelCallsByOperation.has(entry.operationId) && modelCallsByOperation.size >= maxCapturedOperations) {
    const oldestOperationId = modelCallsByOperation.keys().next().value;
    if (oldestOperationId) modelCallsByOperation.delete(oldestOperationId);
  }
  const calls = modelCallsByOperation.get(entry.operationId) ?? [];
  calls.push(structuredClone(entry));
  modelCallsByOperation.set(entry.operationId, calls);
}

function append(entry: SystemLogEntry) {
  entries.push(entry);
  if (isModelCallEntry(entry)) captureModelCall(entry);
  if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
}

export function beginOperation(
  scope: SystemLogEntry["scope"],
  label: string,
  step: string,
  details?: Record<string, unknown>
): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const cancellable = scope === "model" || scope === "rubric" || scope === "grading";
  if (cancellable) operationControllers.set(id, new AbortController());
  cancelledOperationIds.delete(id);
  activeOperations.set(id, { id, scope, cancellable, label, step, startedAt: now, updatedAt: now, details });
  append({ id: crypto.randomUUID(), operationId: id, timestamp: now, level: "info", status: "started", scope, step, message: label, details });
  return id;
}

export function logProgress(
  operationId: string,
  scope: SystemLogEntry["scope"],
  step: string,
  message: string,
  details?: Record<string, unknown>,
  level: SystemLogLevel = "info"
) {
  if (cancelledOperationIds.has(operationId)) return;
  const now = new Date().toISOString();
  const active = activeOperations.get(operationId);
  if (active) activeOperations.set(operationId, { ...active, step, updatedAt: now, details: details ?? active.details });
  append({ id: crypto.randomUUID(), operationId, timestamp: now, level, status: "progress", scope, step, message, details });
}

export function completeOperation(
  operationId: string,
  scope: SystemLogEntry["scope"],
  step: string,
  message: string,
  details?: Record<string, unknown>
) {
  if (cancelledOperationIds.has(operationId)) return;
  const now = new Date().toISOString();
  activeOperations.delete(operationId);
  operationControllers.delete(operationId);
  append({ id: crypto.randomUUID(), operationId, timestamp: now, level: "success", status: "completed", scope, step, message, details });
}

export function failOperation(
  operationId: string,
  scope: SystemLogEntry["scope"],
  step: string,
  error: unknown,
  details?: Record<string, unknown>
) {
  if (cancelledOperationIds.has(operationId)) return;
  const now = new Date().toISOString();
  activeOperations.delete(operationId);
  operationControllers.delete(operationId);
  const message = error instanceof Error ? error.message : String(error);
  append({ id: crypto.randomUUID(), operationId, timestamp: now, level: "error", status: "failed", scope, step, message, details });
}

export function logEvent(
  operationId: string,
  scope: SystemLogEntry["scope"],
  step: string,
  message: string,
  details?: Record<string, unknown>,
  level: SystemLogLevel = "info",
  status: SystemLogStatus = "progress"
) {
  if (cancelledOperationIds.has(operationId) && step !== "operation_force_stopped") return;
  append({ id: crypto.randomUUID(), operationId, timestamp: new Date().toISOString(), level, status, scope, step, message, details });
}

export function getOperationSignal(operationId: string | undefined): AbortSignal | undefined {
  return operationId ? operationControllers.get(operationId)?.signal : undefined;
}

export function throwIfOperationCancelled(operationId: string | undefined): void {
  if (!operationId) return;
  const signal = getOperationSignal(operationId);
  if (cancelledOperationIds.has(operationId) || signal?.aborted) {
    throw new OperationCancelledError();
  }
}

export function forceStopOperation(operationId: string): ActiveOperation | null {
  const operation = activeOperations.get(operationId);
  if (!operation?.cancellable) return null;
  const now = new Date().toISOString();
  cancelledOperationIds.add(operationId);
  activeOperations.delete(operationId);
  const controller = operationControllers.get(operationId);
  operationControllers.delete(operationId);
  controller?.abort(new OperationCancelledError());
  append({
    id: crypto.randomUUID(),
    operationId,
    timestamp: now,
    level: "warning",
    status: "failed",
    scope: operation.scope,
    step: "operation_force_stopped",
    message: "任务已被用户强制停止",
    details: { previousStep: operation.step, label: operation.label }
  });
  if (cancelledOperationIds.size > maxEntries) {
    const oldestId = cancelledOperationIds.values().next().value;
    if (oldestId) cancelledOperationIds.delete(oldestId);
  }
  return structuredClone(operation);
}

export function getLogSnapshot(limit = 300): SystemLogSnapshot {
  return {
    activeOperations: [...activeOperations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    entries: entries.slice(-Math.max(1, Math.min(limit, maxEntries))).reverse(),
    serverTime: new Date().toISOString()
  };
}

export function getOperationModelCalls(operationId: string): ModelCallHistoryEntry[] {
  return structuredClone(modelCallsByOperation.get(operationId) ?? []);
}

export function releaseOperationModelCalls(operationId: string): void {
  modelCallsByOperation.delete(operationId);
}

export function clearCompletedLogs() {
  entries.length = 0;
}
