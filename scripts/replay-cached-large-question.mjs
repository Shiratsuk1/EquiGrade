import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(projectDirectory, "node_modules", "tsx", "dist", "cli.mjs");

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本地回放端口"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForApi(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`回放 API 提前退出（退出码 ${child.exitCode}）`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok && (await response.json()).ok === true) return;
    } catch {
      // API 正在启动，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("回放 API 未能在限定时间内启动");
}

async function main() {
  const port = await findFreePort();
  const token = randomBytes(32).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [tsxCli, "server/index.ts"], {
    cwd: projectDirectory,
    env: { ...process.env, HENGZHUN_API_TOKEN: token, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });

  const request = async (pathname, init = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        "x-hengzhun-token": token,
        ...(init.headers ?? {})
      }
    });
    const body = await response.text();
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = body;
    }
    if (!response.ok) {
      const message = parsed && typeof parsed === "object" && typeof parsed.error === "string" ? parsed.error : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return parsed;
  };

  try {
    await waitForApi(baseUrl, child);
    const history = await request("/api/history-records?limit=500");
    const source = history.records.find((row) => row.rubric?.questionType !== "small" && row.record?.result?.gradingPipeline === "large_question" && row.record?.result?.ocrAudit?.rawJsonl?.trim());
    if (!source) throw new Error("没有找到保存同卷 OCR 审计、可安全回放的真实大题批改记录");

    const result = await request(`/api/templates/${encodeURIComponent(source.templateId)}/replay-cached-ocr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resultId: source.record.result.id,
        reason: "基于真实历史记录执行缓存 OCR 完整链路回放"
      })
    });
    const saved = await request(`/api/history-records?recordId=${encodeURIComponent(result.id)}`);
    const modelCalls = await request(`/api/history-records/${encodeURIComponent(result.id)}/model-calls`);
    const logs = await request("/api/logs?limit=500");
    const visibleSteps = new Set([
      "paddleocr_replay_started",
      "paddleocr_replay_loaded",
      "paddleocr_replay_ready",
      "large_question_answer_triage_ready",
      "large_question_reviews_started",
      "grading_completed",
      "regraded_record_saved"
    ]);
    const operationIds = [...new Set(logs.entries
      .filter((entry) => visibleSteps.has(entry.step))
      .map((entry) => entry.operationId))];
    const relevantLogs = logs.entries
      .filter((entry) => operationIds.includes(entry.operationId) && visibleSteps.has(entry.step))
      .map((entry) => ({ operationId: entry.operationId, step: entry.step, status: entry.status, level: entry.level, message: entry.message }));

    console.log(JSON.stringify({
      sourceRecordId: source.record.id,
      sourceResultId: source.record.result.id,
      newResultId: result.id,
      newScore: `${result.score}/${result.maxScore}`,
      newStatus: result.status,
      gradingPipeline: result.gradingPipeline,
      ocrSource: result.ocrAudit?.source,
      ocrJobId: result.ocrAudit?.jobId,
      historySaved: saved.records?.[0]?.record?.result?.id === result.id,
      savedModelCalls: Array.isArray(modelCalls) ? modelCalls.length : 0,
      relevantLogs
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(stderr.trim() ? `${message}\n${stderr.trim()}` : message);
  } finally {
    if (!child.killed) child.kill();
  }
}

await main();
