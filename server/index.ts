import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ModelConfigInput, Rubric } from "../shared/types.js";
import { readModelConfig, saveModelConfig, toPublicConfig } from "./configStore.js";
import { createDemoResults, demoQuestion, demoReference, demoRubric } from "./demoData.js";
import { extractDocumentText } from "./documentExtractor.js";
import { testModelConnection } from "./modelClient.js";
import { rubricSchema } from "./schemas.js";
import { gradeStudentAnswer, structureRubric } from "./workflows.js";
import {
  getRegradeContext,
  getTemplate,
  listTemplates,
  normalizeUploadedFileName,
  resolveAssetPath,
  saveGradingRecord,
  saveRegradedRecord,
  saveTemplate
} from "./historyStore.js";
import { beginOperation, clearCompletedLogs, completeOperation, failOperation, getLogSnapshot } from "./systemLog.js";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 30 }
});
const port = Number(process.env.PORT ?? 8787);

app.use(express.json({ limit: "5mb" }));

function asyncRoute(handler: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res).catch(next);
  };
}

async function requireConfig(): Promise<ModelConfigInput> {
  const config = await readModelConfig();
  if (!config?.enabled) throw new Error("请先在模型服务中保存并启用一个配置");
  if (!config.apiKey) throw new Error("当前模型配置缺少 API Key");
  return config;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: "0.1.0", time: new Date().toISOString() });
});

app.get("/api/logs", (req, res) => {
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit ?? 300) || 300));
  res.json(getLogSnapshot(limit));
});

app.delete("/api/logs", (_req, res) => {
  clearCompletedLogs();
  res.status(204).end();
});

app.get("/api/model-config", asyncRoute(async (_req, res) => {
  const config = await readModelConfig();
  res.json(config ? toPublicConfig(config) : null);
}));

app.put("/api/model-config", asyncRoute(async (req, res) => {
  const schema = z.object({
    name: z.string().min(1), baseUrl: z.string().url(), apiKey: z.string().optional(),
    visionModel: z.string().min(1), textModel: z.string().min(1),
    timeoutMs: z.number().int().min(1000).max(300000), maxRetries: z.number().int().min(0).max(5),
    maxConcurrency: z.number().int().min(1).max(20), maxOutputTokens: z.number().int().min(256).max(65536),
    supportsJsonSchema: z.boolean(), supportsJsonObject: z.boolean(), supportsBase64Images: z.boolean(), enabled: z.boolean()
  });
  const config = schema.parse(req.body);
  res.json(await saveModelConfig(config));
}));

app.post("/api/model-config/test", asyncRoute(async (req, res) => {
  const mode = z.enum(["text", "vision"]).parse(req.body.mode);
  const operationId = beginOperation("model", `开始测试${mode === "vision" ? "多模态" : "文本"}模型连接`, "connection_test", { mode });
  try {
    const config = await requireConfig();
    const result = await testModelConnection(config, mode);
    completeOperation(operationId, "model", "connection_ready", "模型连接测试成功", { model: result.model, durationMs: result.durationMs });
    res.json(result);
  } catch (error) {
    failOperation(operationId, "model", "connection_failed", error, { mode });
    throw error;
  }
}));

app.post("/api/documents/extract", upload.single("file"), asyncRoute(async (req, res) => {
  if (!req.file) throw new Error("没有收到文档文件");
  res.json({ fileName: req.file.originalname, text: await extractDocumentText(req.file) });
}));

app.post("/api/rubrics/structure", upload.fields([
  { name: "questionImages", maxCount: 10 },
  { name: "referenceImages", maxCount: 10 }
]), asyncRoute(async (req, res) => {
  const input = z.object({ questionText: z.string().min(1), referenceText: z.string().min(1) }).parse(req.body);
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const questionImages = files.questionImages ?? [];
  const referenceImages = files.referenceImages ?? [];
  for (const file of [...questionImages, ...referenceImages]) {
    if (!file.mimetype.startsWith("image/")) throw new Error(`${file.originalname} 不是支持的图片文件`);
  }
  res.json(await structureRubric(await requireConfig(), { ...input, questionImages, referenceImages }));
}));

app.get("/api/templates", asyncRoute(async (_req, res) => {
  res.json(await listTemplates());
}));

app.get("/api/templates/:id", asyncRoute(async (req, res) => {
  const template = await getTemplate(String(req.params.id));
  if (!template) {
    res.status(404).json({ error: "找不到该历史模板" });
    return;
  }
  res.json(template);
}));

app.get("/api/history-assets/:templateId/:fileName", (req, res) => {
  const filePath = resolveAssetPath(String(req.params.templateId), String(req.params.fileName));
  if (!filePath) {
    res.status(404).json({ error: "资源路径无效" });
    return;
  }
  // This route only accepts allow-listed IDs and filenames, so assets inside
  // the hidden `.data` directory are safe to serve explicitly.
  res.sendFile(filePath, { dotfiles: "allow" });
});

app.post("/api/templates", upload.fields([
  { name: "questionImages", maxCount: 10 },
  { name: "referenceImages", maxCount: 10 }
]), asyncRoute(async (req, res) => {
  const operationId = beginOperation("storage", "正在保存锁定模板", "save_template");
  try {
    const input = z.object({
      questionText: z.string(),
      referenceText: z.string(),
      rubric: z.string().min(2)
    }).parse(req.body);
    const rubric: Rubric = rubricSchema.parse(JSON.parse(input.rubric));
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const summary = await saveTemplate({
      questionText: input.questionText,
      referenceText: input.referenceText,
      rubric: { ...rubric, status: "locked" },
      questionImages: files.questionImages ?? [],
      referenceImages: files.referenceImages ?? [],
      operationId
    });
    completeOperation(operationId, "storage", "template_ready", "锁定模板已保存，可从历史记录重新打开", { templateId: summary.id });
    res.status(201).json(summary);
  } catch (error) {
    failOperation(operationId, "storage", "template_save_failed", error);
    throw error;
  }
}));

app.post("/api/grading/grade", upload.single("image"), asyncRoute(async (req, res) => {
  if (!req.file) throw new Error("没有收到学生作答图片");
  if (!req.file.mimetype.startsWith("image/")) throw new Error("首版仅支持 JPG、PNG、WEBP 等图片格式");
  const rubric: Rubric = rubricSchema.parse(JSON.parse(String(req.body.rubric)));
  if (rubric.status !== "locked") throw new Error("评分标准尚未锁定");
  const studentId = String(req.body.studentId || req.file.originalname);
  const grading = await gradeStudentAnswer(await requireConfig(), {
    id: crypto.randomUUID(), studentId, fileName: normalizeUploadedFileName(req.file.originalname),
    mimeType: req.file.mimetype, imageBuffer: req.file.buffer, rubric
  });
  const templateId = String(req.body.templateId || "");
  if (templateId) {
    await saveGradingRecord({ templateId, answerImage: req.file, result: grading.result, operationId: grading.operationId });
  }
  res.json(grading.result);
}));

app.post("/api/templates/:templateId/regrade", asyncRoute(async (req, res) => {
  const input = z.object({
    resultId: z.string().min(1),
    reason: z.string().trim().min(1).max(300).optional()
  }).parse(req.body);
  const templateId = String(req.params.templateId);
  const context = await getRegradeContext(templateId, input.resultId);
  if (!context) {
    res.status(404).json({ error: "找不到要重判的历史批改记录" });
    return;
  }
  const grading = await gradeStudentAnswer(await requireConfig(), {
    id: crypto.randomUUID(),
    studentId: context.studentId,
    fileName: context.fileName,
    mimeType: context.mimeType,
    imageBuffer: context.imageBuffer,
    rubric: context.rubric,
    previousResultId: context.previousResultId,
    regradedAt: new Date().toISOString(),
    regradeReason: input.reason ?? "采用教师模型最终答案权威判定重新批改"
  });
  await saveRegradedRecord({
    templateId,
    sourceResultId: context.previousResultId,
    result: grading.result,
    operationId: grading.operationId
  });
  res.json(grading.result);
}));

app.get("/api/demo", (_req, res) => {
  res.json({ questionText: demoQuestion, referenceText: demoReference, rubric: demoRubric, results: createDemoResults() });
});

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const distDirectory = path.resolve(currentDirectory, "../dist");
app.use(express.static(distDirectory));
app.get("/{*path}", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(distDirectory, "index.html"), (error) => error && next(error));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "未知错误";
  console.error(`[api] ${message}`);
  res.status(error instanceof z.ZodError ? 400 : 500).json({ error: message });
});

app.listen(port, () => {
  console.log(`Physics grading API listening on http://localhost:${port}`);
});
