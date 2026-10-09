import fs from "node:fs";

const historyPath = process.argv[2] ?? ".data/history.json";
const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
const calls = (history.templates ?? [])
  .flatMap((template) => (template.records ?? []).flatMap((record) => record.modelCalls ?? []))
  .filter((call) => call.details?.kind === "model_call");

const percentile = (values, ratio) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
};

const classifyError = (call) => {
  const status = call.details?.response?.status;
  const message = String(call.details?.error ?? "");
  if (status === 524 || /524/.test(message)) return "cloudflare_524";
  if (/JSON|Schema|结构约定|Unexpected/.test(message)) return "structured_output";
  if (/stream|socket|network|fetch failed|aborted|timeout/i.test(message)) return "transport";
  if (typeof status === "number" && status >= 400) return `http_${status}`;
  return message ? "other" : "";
};

const groups = new Map();
for (const call of calls) {
  const key = call.operationId ?? call.id;
  const list = groups.get(key) ?? [];
  list.push(call);
  groups.set(key, list);
}

const operations = [...groups.values()].map((list) => {
  list.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const first = list[0];
  const successful = list.find((call) => call.status === "completed");
  return {
    schemaName: first.details?.schemaName,
    attempts: list.length,
    firstAttemptSuccess: first.status === "completed",
    successfulDurationMs: successful?.details?.durationMs,
    totalDurationMs: list.reduce((sum, call) => sum + Number(call.details?.durationMs ?? 0), 0),
    firstContentMs: first.details?.firstContentMs,
    outputChars: successful?.details?.outputChars,
    errorClasses: [...new Set(list.map(classifyError).filter(Boolean))]
  };
});

const direct = operations.filter((operation) => operation.schemaName === "direct_vision_grading");
const firstSuccesses = direct.filter((operation) => operation.firstAttemptSuccess);
const report = {
  historyPath,
  modelCallCount: calls.length,
  directOperationCount: direct.length,
  firstAttemptSuccessRate: direct.length ? firstSuccesses.length / direct.length : null,
  firstAttemptDurationMs: {
    p50: percentile(firstSuccesses.map((item) => item.successfulDurationMs), 0.5),
    p90: percentile(firstSuccesses.map((item) => item.successfulDurationMs), 0.9)
  },
  operationDurationMs: {
    p50: percentile(direct.map((item) => item.totalDurationMs), 0.5),
    p90: percentile(direct.map((item) => item.totalDurationMs), 0.9)
  },
  firstContentMs: {
    p50: percentile(firstSuccesses.map((item) => item.firstContentMs), 0.5),
    p90: percentile(firstSuccesses.map((item) => item.firstContentMs), 0.9)
  },
  outputChars: {
    p50: percentile(firstSuccesses.map((item) => item.outputChars), 0.5),
    p90: percentile(firstSuccesses.map((item) => item.outputChars), 0.9)
  },
  errorClasses: Object.fromEntries([...direct.flatMap((item) => item.errorClasses)].reduce((counts, value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
  }, new Map()))
};

console.log(JSON.stringify(report, null, 2));
