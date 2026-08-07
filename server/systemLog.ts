import type {
  ActiveOperation,
  SystemLogEntry,
  SystemLogLevel,
  SystemLogSnapshot,
  SystemLogStatus
} from "../shared/types.js";

const maxEntries = 1000;
const entries: SystemLogEntry[] = [];
const activeOperations = new Map<string, ActiveOperation>();

function append(entry: SystemLogEntry) {
  entries.push(entry);
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
  activeOperations.set(id, { id, scope, label, step, startedAt: now, updatedAt: now, details });
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
  const now = new Date().toISOString();
  activeOperations.delete(operationId);
  append({ id: crypto.randomUUID(), operationId, timestamp: now, level: "success", status: "completed", scope, step, message, details });
}

export function failOperation(
  operationId: string,
  scope: SystemLogEntry["scope"],
  step: string,
  error: unknown,
  details?: Record<string, unknown>
) {
  const now = new Date().toISOString();
  activeOperations.delete(operationId);
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
  append({ id: crypto.randomUUID(), operationId, timestamp: new Date().toISOString(), level, status, scope, step, message, details });
}

export function getLogSnapshot(limit = 300): SystemLogSnapshot {
  return {
    activeOperations: [...activeOperations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    entries: entries.slice(-Math.max(1, Math.min(limit, maxEntries))).reverse(),
    serverTime: new Date().toISOString()
  };
}

export function clearCompletedLogs() {
  entries.length = 0;
}

