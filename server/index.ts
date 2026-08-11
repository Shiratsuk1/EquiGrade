import express from "express";
import multer from "multer";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_GRADING_MODE, DEFAULT_TEACHER_REASONING_EFFORT, DEFAULT_UNREADABLE_REVIEW_THRESHOLD } from "../shared/types.js";
import type { Rubric } from "../shared/types.js";
import { readModelConfig, requireModelConfig, saveModelConfig, toPublicConfig } from "./configStore.js";
import { createDemoResults, demoQuestion, demoReference, demoRubric } from "./demoData.js";
import { extractDocumentText } from "./documentExtractor.js";
import { testModelConnection } from "./modelClient.js";
import { assertSafeModelBaseUrl } from "./outboundUrlPolicy.js";
import {
  createLocalPipelineTask,
  getLocalPipelineTask,
  resolveLocalPipelineTaskAssetPath
} from "./localPipelineTaskStore.js";
import { assertRubricIntegrity, rubricSchema } from "./schemas.js";
import { gradeStudentAnswer, structureRubric } from "./workflows.js";
import {
  getRegradeContext,
  getTemplate,
  getTemplateGradingContext,
  ensurePipelineFixtureTemplate,
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
const port = Number(process.env.PORT ?? 8788);
const host = "127.0.0.1";
const configuredApiToken = process.env.HENGZHUN_API_TOKEN?.trim();

if (!configuredApiToken || configuredApiToken.length < 32) {
  throw new Error("本地 API 缺少 HENGZHUN_API_TOKEN，必须通过受支持的启动命令运行工作台");
}
const apiToken = configuredApiToken;

app.use(express.json({ limit: "5mb" }));

function validApiToken(value: string | undefined) {
  if (!value) return false;
  const received = Buffer.from(value);
  const expected = Buffer.from(apiToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function apiTokenFromCookie(value: string | undefined) {
  return value?.split(";").map((part) => part.trim()).find((part) => part.startsWith("hengzhun_api_token="))
    ?.slice("hengzhun_api_token=".length);
}

app.use("/api", (req, res, next) => {
  if (req.path === "/health") {
    next();
    return;
  }
  if (!validApiToken(req.get("x-hengzhun-token")) && !validApiToken(apiTokenFromCookie(req.get("cookie")))) {
    res.status(401).json({ error: "本地 API 请求未通过工作台鉴权" });
    return;
  }
  next();
});

function asyncRoute(handler: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res).catch(next);
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: "0.1.1", time: new Date().toISOString() });
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
    unreadableReviewThreshold: z.number().min(0.5).max(100).multipleOf(0.5).default(DEFAULT_UNREADABLE_REVIEW_THRESHOLD),
    gradingMode: z.enum(["vision_direct", "evidence_pipeline"]).default(DEFAULT_GRADING_MODE),
    teacherReasoningEffort: z.enum(["disabled", "low", "medium", "high"]).default(DEFAULT_TEACHER_REASONING_EFFORT),
    supportsJsonSchema: z.boolean(), supportsJsonObject: z.boolean(), supportsBase64Images: z.boolean(), enabled: z.boolean()
  });
  const config = schema.parse(req.body);
  await assertSafeModelBaseUrl(config.baseUrl);
  res.json(await saveModelConfig(config));
}));

app.post("/api/model-config/test", asyncRoute(async (req, res) => {
  const mode = z.enum(["text", "vision"]).parse(req.body.mode);
  const modeLabel = mode === "vision" ? "多模态" : "文本";
  const operationId = beginOperation("model", `开始测试${modeLabel}模型连接`, "connection_test", { mode });
  try {
    const config = await requireModelConfig();
    const result = await testModelConnection(config, mode, operationId);
    completeOperation(operationId, "model", "connection_ready", `${modeLabel}模型连接测试成功`, { model: result.model, durationMs: result.durationMs });
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
  res.json(await structureRubric(await requireModelConfig(), { ...input, questionImages, referenceImages }));
}));

app.get("/api/templates", asyncRoute(async (req, res) => {
  const includeBuiltIn = req.query.includeBuiltIn === "1";
  const templates = await listTemplates();
  res.json(includeBuiltIn ? templates : templates.filter((template) => !template.builtIn));
}));

app.get("/api/templates/:id", asyncRoute(async (req, res) => {
  const template = await getTemplate(String(req.params.id));
  if (!template) {
    res.status(404).json({ error: "找不到该历史模板" });
    return;
  }
  res.json(template);
}));

app.get("/api/pipeline/fixture", asyncRoute(async (_req, res) => {
  const summary = await ensurePipelineFixtureTemplate();
  const template = await getTemplate(summary.id);
  if (!template) throw new Error("内置流水线评分模板初始化失败");
  res.json({
    templateId: template.id,
    title: template.title,
    locked: template.rubric.status === "locked",
    questionText: template.questionText,
    referenceText: template.referenceText,
    rubric: template.rubric
  });
}));

app.post("/api/pipeline/tasks", upload.array("images", 30), asyncRoute(async (req, res) => {
  const input = z.object({
    templateId: z.string().uuid(),
    studentIds: z.string().optional()
  }).parse(req.body);
  const template = await getTemplate(input.templateId);
  if (!template || template.rubric.status !== "locked" || template.builtIn) {
    res.status(404).json({ error: "找不到可用于真实任务的锁定评分模板" });
    return;
  }
  const files = (req.files ?? []) as Express.Multer.File[];
  if (!files.length) throw new Error("请至少选择一张学生作答图片");
  for (const file of files) {
    if (!file.mimetype.startsWith("image/")) throw new Error(`${file.originalname} 不是支持的图片文件`);
  }
  let studentIds: string[] = [];
  if (input.studentIds) {
    const parsed = JSON.parse(input.studentIds) as unknown;
    studentIds = z.array(z.string().trim().max(100)).max(30).parse(parsed);
  }
  const task = await createLocalPipelineTask({
    templateId: template.id,
    templateTitle: template.title,
    totalScore: template.totalScore,
    files,
    studentIds
  });
  res.status(201).json(task);
}));

app.get("/api/pipeline/tasks/:id", asyncRoute(async (req, res) => {
  const task = await getLocalPipelineTask(String(req.params.id));
  if (!task) {
    res.status(404).json({ error: "找不到该本地答卷任务" });
    return;
  }
  res.json(task);
}));

app.get("/api/pipeline-task-assets/:taskId/:fileName", (req, res) => {
  const filePath = resolveLocalPipelineTaskAssetPath(String(req.params.taskId), String(req.params.fileName));
  if (!filePath) {
    res.status(404).json({ error: "任务图片路径无效" });
    return;
  }
  res.sendFile(filePath, { dotfiles: "deny" });
});

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
    assertRubricIntegrity(rubric);
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

app.post("/api/grading/grade", upload.fields([
  { name: "image", maxCount: 1 },
  { name: "questionImages", maxCount: 10 },
  { name: "referenceImages", maxCount: 10 }
]), asyncRoute(async (req, res) => {
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const answerImage = files.image?.[0];
  if (!answerImage) throw new Error("没有收到学生作答图片");
  if (!answerImage.mimetype.startsWith("image/")) throw new Error("首版仅支持 JPG、PNG、WEBP 等图片格式");
  const questionImages = files.questionImages ?? [];
  const referenceImages = files.referenceImages ?? [];
  for (const file of [...questionImages, ...referenceImages]) {
    if (!file.mimetype.startsWith("image/")) throw new Error(`${file.originalname} 不是支持的图片文件`);
  }
  const toModelImage = (file: Express.Multer.File, label: string) => ({
    mimeType: file.mimetype,
    base64: file.buffer.toString("base64"),
    label
  });
  const rubric: Rubric = rubricSchema.parse(JSON.parse(String(req.body.rubric)));
  if (rubric.status !== "locked") throw new Error("评分标准尚未锁定");
  assertRubricIntegrity(rubric);
  const studentId = String(req.body.studentId || answerImage.originalname);
  const grading = await gradeStudentAnswer(await requireModelConfig(), {
    id: crypto.randomUUID(), studentId, fileName: normalizeUploadedFileName(answerImage.originalname),
    mimeType: answerImage.mimetype, imageBuffer: answerImage.buffer, rubric,
    questionText: String(req.body.questionText || ""),
    referenceText: String(req.body.referenceText || ""),
    questionImages: questionImages.map((file, index) => toModelImage(file, `[题目图片 ${index + 1}：${normalizeUploadedFileName(file.originalname)}]`)),
    referenceImages: referenceImages.map((file, index) => toModelImage(file, `[参考答案图片 ${index + 1}：${normalizeUploadedFileName(file.originalname)}]`))
  });
  const templateId = String(req.body.templateId || "");
  if (templateId) {
    await saveGradingRecord({ templateId, answerImage, result: grading.result, operationId: grading.operationId });
  }
  res.json(grading.result);
}));

app.post("/api/pipeline/grade", upload.single("image"), asyncRoute(async (req, res) => {
  const templateId = z.string().min(1).parse(req.body.templateId);
  const pageKey = z.string().min(1).max(200).parse(req.body.pageKey);
  const imageHash = z.string().regex(/^[a-f0-9]{64}$/i).parse(req.body.imageHash);
  const sourcePageKey = z.string().max(200).optional().parse(req.body.sourcePageKey);
  const studentId = z.string().trim().min(1).max(100).optional().parse(req.body.studentId);
  const sourceFileName = z.string().trim().min(1).max(255).optional().parse(req.body.fileName);
  const answerImage = req.file;
  if (!answerImage || !answerImage.mimetype.startsWith("image/")) throw new Error("没有收到有效的网页答卷图片");
  const actualImageHash = createHash("sha256").update(answerImage.buffer).digest("hex");
  if (actualImageHash.toLowerCase() !== imageHash.toLowerCase()) {
    throw new Error("网页答卷图片哈希校验失败");
  }
  const context = await getTemplateGradingContext(templateId);
  if (!context) throw new Error("找不到流水线使用的锁定评分模板");
  const toModelImage = (file: { fileName: string; mimeType: string; buffer: Buffer }, label: string) => ({
    mimeType: file.mimeType,
    base64: file.buffer.toString("base64"),
    label
  });
  const grading = await gradeStudentAnswer(await requireModelConfig(), {
    id: crypto.randomUUID(),
    studentId: studentId || `网页答卷 ${sourcePageKey || pageKey}`,
    fileName: normalizeUploadedFileName(sourceFileName || answerImage.originalname || `${pageKey}.jpg`),
    mimeType: answerImage.mimetype,
    imageBuffer: answerImage.buffer,
    rubric: context.rubric,
    questionText: context.questionText,
    referenceText: context.referenceText,
    questionImages: context.questionImages.map((file, index) => toModelImage(file, `[题目图片 ${index + 1}：${file.fileName}]`)),
    referenceImages: context.referenceImages.map((file, index) => toModelImage(file, `[参考答案图片 ${index + 1}：${file.fileName}]`))
  });
  await saveGradingRecord({ templateId, answerImage, result: grading.result, operationId: grading.operationId });
  res.json({
    jobId: grading.result.id,
    pageKey,
    imageHash,
    sourcePageKey,
    score: grading.result.score,
    maxScore: grading.result.maxScore,
    status: grading.result.status,
    requiresReview: grading.result.status === "needs_review",
    result: grading.result
  });
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
  const grading = await gradeStudentAnswer(await requireModelConfig(), {
    id: crypto.randomUUID(),
    studentId: context.studentId,
    fileName: context.fileName,
    mimeType: context.mimeType,
    imageBuffer: context.imageBuffer,
    rubric: context.rubric,
    questionText: context.questionText,
    referenceText: context.referenceText,
    questionImages: context.questionImages.map((file, index) => ({
      mimeType: file.mimeType,
      base64: file.buffer.toString("base64"),
      label: `[题目图片 ${index + 1}：${file.fileName}]`
    })),
    referenceImages: context.referenceImages.map((file, index) => ({
      mimeType: file.mimeType,
      base64: file.buffer.toString("base64"),
      label: `[参考答案图片 ${index + 1}：${file.fileName}]`
    })),
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
const distDirectory = process.env.APP_DIST_DIR
  ? path.resolve(process.env.APP_DIST_DIR)
  : path.resolve(currentDirectory, "../dist");
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

async function startServer() {
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const listeningPort = address && typeof address !== "string" ? address.port : port;
      console.log(`Physics grading API listening on http://${host}:${listeningPort}`);
      process.send?.({ type: "hengzhun-api-listening", port: listeningPort });
      resolve();
    });
    server.once("error", reject);
  });
}

void startServer().catch((error) => {
  console.error("[api] failed to initialize local data", error);
  process.exitCode = 1;
});
