import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("durable system log", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("writes non-model events and reloads them in a new module instance", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hengzhun-system-log-"));
    try {
      vi.stubEnv("APP_DATA_DIR", directory);
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("HENGZHUN_PERSIST_SYSTEM_LOGS", "1");
      vi.resetModules();
      const first = await import("./systemLog.js");
      const operationId = first.beginOperation("grading", "持久化日志测试", "test_start");
      first.logEvent(operationId, "grading", "test_persisted", "持久化日志测试事件");
      first.completeOperation(operationId, "grading", "test_complete", "持久化日志测试完成");
      await first.flushPersistedLogs();

      const logPath = path.join(directory, "system-log.jsonl");
      const raw = await readFile(logPath, "utf8");
      expect(raw).toContain("test_persisted");
      expect(raw).not.toContain('"kind":"model_call"');

      vi.resetModules();
      const second = await import("./systemLog.js");
      expect(second.getLogSnapshot(20).entries.some((entry) => entry.step === "test_persisted")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
