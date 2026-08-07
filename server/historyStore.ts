import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GradingHistoryRecord,
  GradingResult,
  GradingTemplateDetail,
  GradingTemplateSummary,
  Rubric,
  SavedAsset
} from "../shared/types.js";
import { logEvent } from "./systemLog.js";

interface StoredAsset extends SavedAsset {
  diskName: string;
}

interface StoredHistoryRecord extends Omit<GradingHistoryRecord, "answerImage"> {
  answerImage: StoredAsset;
}

interface StoredTemplate {
  id: string;
  title: string;
  totalScore: number;
  createdAt: string;
  updatedAt: string;
  questionText: string;
  referenceText: string;
  rubric: Rubric;
  questionImages: StoredAsset[];
  referenceImages: StoredAsset[];
  records: StoredHistoryRecord[];
}

interface HistoryDatabase {
  templates: StoredTemplate[];
}

const dataDirectory = path.resolve(".data");
const assetsDirectory = path.join(dataDirectory, "history-assets");
const databasePath = path.join(dataDirectory, "history.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

export function normalizeUploadedFileName(value: string): string {
  const bytes = Array.from(value, (character) => character.charCodeAt(0));
  if (!bytes.some((byte) => byte >= 0x80) || bytes.some((byte) => byte > 0xff)) return value;
  const decoded = Buffer.from(bytes).toString("utf8");
  return decoded.includes("\uFFFD") ? value : decoded;
}

export function countCurrentGradingResults(results: Array<Pick<GradingResult, "id" | "previousResultId">>): number {
  const supersededIds = new Set(results.flatMap((result) => result.previousResultId ? [result.previousResultId] : []));
  return results.filter((result) => !supersededIds.has(result.id)).length;
}

async function readDatabase(): Promise<HistoryDatabase> {
  await mkdir(assetsDirectory, { recursive: true });
  try {
    return JSON.parse(await readFile(databasePath, "utf8")) as HistoryDatabase;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { templates: [] };
    throw error;
  }
}

function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function extensionFor(file: Express.Multer.File): string {
  const fromName = path.extname(file.originalname).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  if (file.mimetype === "image/png") return ".png";
  if (file.mimetype === "image/webp") return ".webp";
  return ".jpg";
}

async function saveAsset(templateId: string, file: Express.Multer.File, prefix: string): Promise<StoredAsset> {
  const directory = path.join(assetsDirectory, templateId);
  await mkdir(directory, { recursive: true });
  const id = crypto.randomUUID();
  const diskName = `${prefix}-${id}${extensionFor(file)}`;
  await writeFile(path.join(directory, diskName), file.buffer);
  return {
    id,
    fileName: normalizeUploadedFileName(file.originalname),
    mimeType: file.mimetype,
    diskName,
    url: `/api/history-assets/${templateId}/${diskName}`
  };
}

function toSummary(template: StoredTemplate): GradingTemplateSummary {
  return {
    id: template.id,
    title: template.title,
    totalScore: template.totalScore,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    gradingCount: countCurrentGradingResults(template.records.map((record) => record.result)),
    questionImageCount: template.questionImages.length,
    referenceImageCount: template.referenceImages.length
  };
}

function publicAsset(asset: StoredAsset): SavedAsset {
  const { diskName: _diskName, ...publicFields } = asset;
  return { ...publicFields, fileName: normalizeUploadedFileName(publicFields.fileName) };
}

export async function saveTemplate(input: {
  questionText: string;
  referenceText: string;
  rubric: Rubric;
  questionImages: Express.Multer.File[];
  referenceImages: Express.Multer.File[];
  operationId: string;
}): Promise<GradingTemplateSummary> {
  return mutate(async () => {
    const database = await readDatabase();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const questionImages = await Promise.all(input.questionImages.map((file) => saveAsset(id, file, "question")));
    const referenceImages = await Promise.all(input.referenceImages.map((file) => saveAsset(id, file, "reference")));
    const template: StoredTemplate = {
      id,
      title: input.rubric.title,
      totalScore: input.rubric.totalScore,
      createdAt: now,
      updatedAt: now,
      questionText: input.questionText,
      referenceText: input.referenceText,
      rubric: { ...input.rubric, status: "locked" },
      questionImages,
      referenceImages,
      records: []
    };
    database.templates.unshift(template);
    await writeFile(databasePath, JSON.stringify(database, null, 2), "utf8");
    logEvent(input.operationId, "storage", "template_saved", "已自动保存锁定模板", {
      templateId: id,
      title: template.title,
      questionImages: questionImages.length,
      referenceImages: referenceImages.length
    }, "success", "progress");
    return toSummary(template);
  });
}

export async function saveGradingRecord(input: {
  templateId: string;
  answerImage: Express.Multer.File;
  result: GradingResult;
  operationId: string;
}): Promise<void> {
  await mutate(async () => {
    const database = await readDatabase();
    const template = database.templates.find((item) => item.id === input.templateId);
    if (!template) throw new Error("找不到当前批改模板，无法保存历史记录");
    const answerImage = await saveAsset(template.id, input.answerImage, "answer");
    template.records.unshift({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      answerImage,
      result: input.result
    });
    template.updatedAt = new Date().toISOString();
    await writeFile(databasePath, JSON.stringify(database, null, 2), "utf8");
    logEvent(input.operationId, "storage", "grading_record_saved", "学生答卷与批改结果已写入历史记录", {
      templateId: template.id,
      studentId: input.result.studentId,
      score: input.result.score,
      maxScore: input.result.maxScore
    }, "success", "completed");
  });
}

export async function getRegradeContext(templateId: string, resultId: string): Promise<{
  rubric: Rubric;
  studentId: string;
  fileName: string;
  mimeType: string;
  imageBuffer: Buffer;
  previousResultId: string;
} | null> {
  const database = await readDatabase();
  const template = database.templates.find((item) => item.id === templateId);
  const record = template?.records.find((item) => item.result.id === resultId);
  if (!template || !record) return null;
  return {
    rubric: template.rubric,
    studentId: record.result.studentId,
    fileName: normalizeUploadedFileName(record.answerImage.fileName),
    mimeType: record.answerImage.mimeType,
    imageBuffer: await readFile(path.join(assetsDirectory, template.id, record.answerImage.diskName)),
    previousResultId: record.result.id
  };
}

export async function saveRegradedRecord(input: {
  templateId: string;
  sourceResultId: string;
  result: GradingResult;
  operationId: string;
}): Promise<void> {
  await mutate(async () => {
    const database = await readDatabase();
    const template = database.templates.find((item) => item.id === input.templateId);
    const sourceRecord = template?.records.find((item) => item.result.id === input.sourceResultId);
    if (!template || !sourceRecord) throw new Error("找不到要重判的历史批改记录");
    template.records.unshift({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      answerImage: sourceRecord.answerImage,
      result: input.result
    });
    template.updatedAt = new Date().toISOString();
    await writeFile(databasePath, JSON.stringify(database, null, 2), "utf8");
    logEvent(input.operationId, "storage", "regraded_record_saved", "重判结果已作为新版本写入历史记录，原结果保持不变", {
      templateId: template.id,
      previousResultId: input.sourceResultId,
      resultId: input.result.id,
      studentId: input.result.studentId,
      score: input.result.score,
      maxScore: input.result.maxScore
    }, "success", "completed");
  });
}

export async function listTemplates(): Promise<GradingTemplateSummary[]> {
  return (await readDatabase()).templates.map(toSummary);
}

export async function getTemplate(id: string): Promise<GradingTemplateDetail | null> {
  const template = (await readDatabase()).templates.find((item) => item.id === id);
  if (!template) return null;
  return {
    ...toSummary(template),
    questionText: template.questionText,
    referenceText: template.referenceText,
    rubric: template.rubric,
    questionImages: template.questionImages.map(publicAsset),
    referenceImages: template.referenceImages.map(publicAsset),
    records: template.records.map((record) => ({
      ...record,
      answerImage: publicAsset(record.answerImage),
      result: { ...record.result, fileName: normalizeUploadedFileName(record.result.fileName) }
    }))
  };
}

export function resolveAssetPath(templateId: string, diskName: string): string | null {
  if (!/^[a-f0-9-]+$/i.test(templateId) || !/^[a-z]+-[a-f0-9-]+\.[a-z0-9]+$/i.test(diskName)) return null;
  const resolved = path.resolve(assetsDirectory, templateId, diskName);
  const expectedParent = `${path.resolve(assetsDirectory, templateId)}${path.sep}`;
  return resolved.startsWith(expectedParent) ? resolved : null;
}
