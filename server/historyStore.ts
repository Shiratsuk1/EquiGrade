import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GradingHistoryRecord,
  GradingResult,
  GradingTemplateDetail,
  GradingTemplateSummary,
  Rubric,
  SavedAsset
} from "../shared/types.js";
import { demoQuestion, demoReference, demoRubric } from "./demoData.js";
import { pipelineFixtureQuestion, pipelineFixtureReference, pipelineFixtureRubric } from "./pipelineFixtureData.js";
import { getOperationModelCalls, logEvent, releaseOperationModelCalls } from "./systemLog.js";

interface StoredAsset extends SavedAsset {
  diskName: string;
}

interface StoredHistoryRecord extends Omit<GradingHistoryRecord, "answerImage" | "modelCallCount" | "modelCalls"> {
  answerImage: StoredAsset;
  modelCalls?: GradingHistoryRecord["modelCalls"];
}

interface StoredTemplate {
  id: string;
  title: string;
  totalScore: number;
  builtIn?: boolean;
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

const dataDirectory = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.resolve(".data");
const assetsDirectory = path.join(dataDirectory, "history-assets");
const databasePath = path.join(dataDirectory, "history.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

export const PIPELINE_FIXTURE_TEMPLATE_ID = "00000000-0000-4000-8000-000000000001";

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

export function matchesStoredRecordId(record: { id: string; result: Pick<GradingResult, "id"> }, ids: ReadonlySet<string>): boolean {
  return ids.has(record.id) || ids.has(record.result.id);
}

export function shouldDeleteAnswerAsset(diskName: string, remainingRecords: Array<{ answerImage: Pick<StoredAsset, "diskName"> }>): boolean {
  return !remainingRecords.some((record) => record.answerImage.diskName === diskName);
}

export function normalizeLegacyReviewState(result: GradingResult): GradingResult {
  const staleReasons = new Set<string>();
  let changed = false;
  const subquestions = result.subquestions.map((subquestion) => {
    const decisions = subquestion.decisions.map((decision) => {
      const isClearDecision = decision.status === "satisfied"
        || decision.status === "not_satisfied"
        || decision.status === "not_present"
        || decision.status === "not_required";
      if (!isClearDecision || decision.decisionSource === "synthetic_missing" || !decision.requiresReview) return decision;
      if (decision.reviewReason) staleReasons.add(decision.reviewReason);
      changed = true;
      return { ...decision, requiresReview: false, reviewReason: undefined };
    });
    return {
      ...subquestion,
      decisions,
      processAuditSummary: subquestion.processAuditSummary
        ? { ...subquestion.processAuditSummary, reviewRequired: decisions.filter((decision) => decision.requiresReview).length }
        : subquestion.processAuditSummary
    };
  });
  if (!changed) return result;

  const retainedDecisionReasons = new Set(subquestions.flatMap((subquestion) => subquestion.decisions
    .filter((decision) => decision.requiresReview && decision.reviewReason)
    .map((decision) => decision.reviewReason as string)));
  const reviewReasons = result.reviewReasons.filter((reason) => !staleReasons.has(reason) || retainedDecisionReasons.has(reason));
  const teacherCommentary = result.teacherCommentary
    ? {
        ...result.teacherCommentary,
        reviewItems: result.teacherCommentary.reviewItems.filter((reason) => !staleReasons.has(reason) || retainedDecisionReasons.has(reason))
      }
    : result.teacherCommentary;
  return {
    ...result,
    status: reviewReasons.length ? "needs_review" : "completed",
    reviewReasons,
    subquestions,
    teacherCommentary
  };
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
    builtIn: Boolean(template.builtIn),
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    gradingCount: countCurrentGradingResults(template.records.map((record) => record.result)),
    questionImageCount: template.questionImages.length,
    referenceImageCount: template.referenceImages.length
  };
}

function removeInvalidUnitClaim(value: string): string {
  return value.replace(/(?:，|,)?\s*且未(?:标注|写)单位(?=[。；,，]|$)/g, "");
}

function migratePipelineFixtureResult(result: GradingResult): GradingResult {
  const subquestions = result.subquestions.map((subquestion) => {
    const score = Math.max(0, Math.min(
      subquestion.maxScore,
      subquestion.decisions.reduce((sum, decision) => sum + decision.awardedScore, 0)
    ));
    return {
      ...subquestion,
      score,
      maximumPossibleScore: score,
      finalAnswerReason: subquestion.finalAnswerReason
        ? removeInvalidUnitClaim(subquestion.finalAnswerReason)
        : subquestion.finalAnswerReason,
      deductions: [],
      auditDeductions: []
    };
  });
  const score = subquestions.reduce((sum, subquestion) => sum + subquestion.score, 0);
  const teacherCommentary = result.teacherCommentary
    ? {
        ...result.teacherCommentary,
        overallComment: removeInvalidUnitClaim(result.teacherCommentary.overallComment),
        strengths: result.teacherCommentary.strengths.map(removeInvalidUnitClaim),
        lostPoints: result.teacherCommentary.lostPoints.map((item) => ({
          ...item,
          reason: removeInvalidUnitClaim(item.reason)
        })),
        auditConcerns: result.teacherCommentary.auditConcerns.map((item) => ({
          ...item,
          reason: removeInvalidUnitClaim(item.reason)
        })),
        reviewItems: result.teacherCommentary.reviewItems.map(removeInvalidUnitClaim)
      }
    : result.teacherCommentary;
  return {
    ...result,
    score,
    maximumPossibleScore: score,
    rubricVersion: demoRubric.version,
    reviewReasons: result.reviewReasons.map(removeInvalidUnitClaim),
    subquestions,
    teacherCommentary
  };
}

export async function ensurePipelineFixtureTemplate(): Promise<GradingTemplateSummary> {
  return mutate(async () => {
    const database = await readDatabase();
    const existing = database.templates.find((item) => item.id === PIPELINE_FIXTURE_TEMPLATE_ID);
    if (existing) {
      if (!existing.builtIn || existing.rubric.version >= pipelineFixtureRubric.version) return toSummary(existing);
      existing.title = "网页自动改卷测试 · 竖直圆轨道";
      existing.totalScore = pipelineFixtureRubric.totalScore;
      existing.questionText = pipelineFixtureQuestion;
      existing.referenceText = pipelineFixtureReference;
      existing.rubric = JSON.parse(JSON.stringify({ ...pipelineFixtureRubric, status: "locked" })) as Rubric;
      existing.records = [];
      existing.updatedAt = new Date().toISOString();
      await writeFile(databasePath, JSON.stringify(database, null, 2), "utf8");
      return toSummary(existing);
    }

    const now = new Date().toISOString();
    const template: StoredTemplate = {
      id: PIPELINE_FIXTURE_TEMPLATE_ID,
      title: "网页自动改卷测试 · 竖直圆轨道",
      totalScore: pipelineFixtureRubric.totalScore,
      builtIn: true,
      createdAt: now,
      updatedAt: now,
      questionText: pipelineFixtureQuestion,
      referenceText: pipelineFixtureReference,
      rubric: JSON.parse(JSON.stringify({ ...pipelineFixtureRubric, status: "locked" })) as Rubric,
      questionImages: [],
      referenceImages: [],
      records: []
    };
    database.templates.push(template);
    await writeFile(databasePath, JSON.stringify(database, null, 2), "utf8");
    return toSummary(template);
  });
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
      builtIn: false,
      createdAt: now,
      updatedAt: now,
      questionText: input.questionText,
      referenceText: input.referenceText,
      rubric: { ...input.rubric, status: "saved" },
      questionImages,
      referenceImages,
      records: []
    };
    database.templates.unshift(template);
    await writeFile(databasePath, JSON.stringify(database, null, 2), "utf8");
    logEvent(input.operationId, "storage", "template_saved", "评分标准已保存，后续仍可修改", {
      templateId: id,
      title: template.title,
      questionImages: questionImages.length,
      referenceImages: referenceImages.length
    }, "success", "progress");
    return toSummary(template);
  });
}

export async function updateTemplateRubric(input: {
  templateId: string;
  rubric: Rubric;
  operationId: string;
}): Promise<GradingTemplateSummary> {
  return mutate(async () => {
    const database = await readDatabase();
    const template = database.templates.find((item) => item.id === input.templateId);
    if (!template) throw new Error("找不到要修改的评分标准");
    if (template.builtIn) throw new Error("内置测试评分标准不能修改");
    if (input.rubric.version !== template.rubric.version) {
      throw new Error(`评分标准已在其他位置更新为 v${template.rubric.version}，请刷新后再修改`);
    }
    const previousRubric = structuredClone(template.rubric);
    for (const record of template.records) {
      record.rubricSnapshot ??= structuredClone(previousRubric);
    }
    const nextVersion = template.rubric.version + 1;
    template.rubric = structuredClone({ ...input.rubric, version: nextVersion, status: "saved" });
    template.title = template.rubric.title;
    template.totalScore = template.rubric.totalScore;
    template.updatedAt = new Date().toISOString();
    await writeFile(databasePath, JSON.stringify(database, null, 2), "utf8");
    logEvent(input.operationId, "storage", "template_updated", "评分标准修改已保存为新版本", {
      templateId: template.id,
      version: nextVersion,
      existingRecords: template.records.length
    }, "success", "progress");
    return toSummary(template);
  });
}

export async function saveGradingRecord(input: {
  templateId: string;
  answerImage: Express.Multer.File;
  result: GradingResult;
  rubricSnapshot: Rubric;
  operationId: string;
}): Promise<void> {
  await mutate(async () => {
    const database = await readDatabase();
    const template = database.templates.find((item) => item.id === input.templateId);
    if (!template) throw new Error("找不到当前批改模板，无法保存历史记录");
    const answerImage = await saveAsset(template.id, input.answerImage, "answer");
    const modelCalls = getOperationModelCalls(input.operationId);
    template.records.unshift({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      answerImage,
      result: input.result,
      rubricSnapshot: structuredClone(input.rubricSnapshot),
      modelCalls
    });
    template.updatedAt = new Date().toISOString();
    await writeFile(databasePath, JSON.stringify(database, null, 2), "utf8");
    releaseOperationModelCalls(input.operationId);
    logEvent(input.operationId, "storage", "grading_record_saved", "学生答卷与批改结果已写入历史记录", {
      templateId: template.id,
      studentId: input.result.studentId,
      score: input.result.score,
      maxScore: input.result.maxScore,
      modelCalls: modelCalls.length
    }, "success", "completed");
  });
}

export async function getRegradeContext(templateId: string, resultId: string): Promise<{
  rubric: Rubric;
  questionText: string;
  referenceText: string;
  questionImages: Array<{ fileName: string; mimeType: string; buffer: Buffer }>;
  referenceImages: Array<{ fileName: string; mimeType: string; buffer: Buffer }>;
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
  const loadTemplateImage = async (asset: StoredAsset) => ({
    fileName: normalizeUploadedFileName(asset.fileName),
    mimeType: asset.mimeType,
    buffer: await readFile(path.join(assetsDirectory, template.id, asset.diskName))
  });
  return {
    rubric: record.rubricSnapshot ?? template.rubric,
    questionText: template.questionText,
    referenceText: template.referenceText,
    questionImages: await Promise.all(template.questionImages.map(loadTemplateImage)),
    referenceImages: await Promise.all(template.referenceImages.map(loadTemplateImage)),
    studentId: record.result.studentId,
    fileName: normalizeUploadedFileName(record.answerImage.fileName),
    mimeType: record.answerImage.mimeType,
    imageBuffer: await readFile(path.join(assetsDirectory, template.id, record.answerImage.diskName)),
    previousResultId: record.result.id
  };
}

export async function getTemplateGradingContext(templateId: string): Promise<{
  rubric: Rubric;
  questionText: string;
  referenceText: string;
  questionImages: Array<{ fileName: string; mimeType: string; buffer: Buffer }>;
  referenceImages: Array<{ fileName: string; mimeType: string; buffer: Buffer }>;
} | null> {
  const database = await readDatabase();
  const template = database.templates.find((item) => item.id === templateId);
  if (!template) return null;
  const loadImage = async (asset: StoredAsset) => ({
    fileName: normalizeUploadedFileName(asset.fileName),
    mimeType: asset.mimeType,
    buffer: await readFile(path.join(assetsDirectory, template.id, asset.diskName))
  });
  return {
    rubric: template.rubric,
    questionText: template.questionText,
    referenceText: template.referenceText,
    questionImages: await Promise.all(template.questionImages.map(loadImage)),
    referenceImages: await Promise.all(template.referenceImages.map(loadImage))
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
    const modelCalls = getOperationModelCalls(input.operationId);
    template.records.unshift({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      answerImage: sourceRecord.answerImage,
      result: input.result,
      rubricSnapshot: structuredClone(sourceRecord.rubricSnapshot ?? template.rubric),
      modelCalls
    });
    template.updatedAt = new Date().toISOString();
    await writeFile(databasePath, JSON.stringify(database, null, 2), "utf8");
    releaseOperationModelCalls(input.operationId);
    logEvent(input.operationId, "storage", "regraded_record_saved", "重判结果已作为新版本写入历史记录，原结果保持不变", {
      templateId: template.id,
      previousResultId: input.sourceResultId,
      resultId: input.result.id,
      studentId: input.result.studentId,
      score: input.result.score,
      maxScore: input.result.maxScore,
      modelCalls: modelCalls.length
    }, "success", "completed");
  });
}

export async function listTemplates(): Promise<GradingTemplateSummary[]> {
  return (await readDatabase()).templates.map(toSummary);
}

export async function deleteTemplates(templateIds: string[]): Promise<{ deletedTemplates: number; deletedRecords: number }> {
  return mutate(async () => {
    const ids = new Set(templateIds);
    const database = await readDatabase();
    const targets = database.templates.filter((template) => ids.has(template.id));
    const protectedTemplate = targets.find((template) => template.builtIn);
    if (protectedTemplate) throw new Error(`内置评分标准“${protectedTemplate.title}”不能删除`);
    if (!targets.length) return { deletedTemplates: 0, deletedRecords: 0 };

    database.templates = database.templates.filter((template) => !ids.has(template.id));
    await writeFile(databasePath, JSON.stringify(database, null, 2), "utf8");
    await Promise.all(targets.map((template) => rm(path.join(assetsDirectory, template.id), { recursive: true, force: true })));
    return {
      deletedTemplates: targets.length,
      deletedRecords: targets.reduce((total, template) => total + template.records.length, 0)
    };
  });
}

export async function deleteGradingRecords(recordIds: string[]): Promise<{ deletedRecords: number; deletedAssets: number }> {
  return mutate(async () => {
    const ids = new Set(recordIds);
    const database = await readDatabase();
    const assetsToDelete: string[] = [];
    let deletedRecords = 0;

    for (const template of database.templates) {
      const removed = template.records.filter((record) => matchesStoredRecordId(record, ids));
      if (!removed.length) continue;
      const remaining = template.records.filter((record) => !removed.includes(record));
      const candidateDiskNames = new Set(removed.map((record) => record.answerImage.diskName));
      for (const diskName of candidateDiskNames) {
        if (shouldDeleteAnswerAsset(diskName, remaining)) {
          assetsToDelete.push(path.join(assetsDirectory, template.id, diskName));
        }
      }
      template.records = remaining;
      template.updatedAt = new Date().toISOString();
      deletedRecords += removed.length;
    }

    if (!deletedRecords) return { deletedRecords: 0, deletedAssets: 0 };
    await writeFile(databasePath, JSON.stringify(database, null, 2), "utf8");
    await Promise.all(assetsToDelete.map((assetPath) => rm(assetPath, { force: true })));
    return { deletedRecords, deletedAssets: assetsToDelete.length };
  });
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
    records: template.records.map(toPublicHistoryRecord)
  };
}

function toPublicHistoryRecord(record: StoredHistoryRecord): GradingHistoryRecord {
  const { modelCalls, ...publicRecord } = record;
  return {
    ...publicRecord,
    answerImage: publicAsset(record.answerImage),
    result: normalizeLegacyReviewState({ ...record.result, fileName: normalizeUploadedFileName(record.result.fileName) }),
    modelCallCount: modelCalls?.length ?? 0
  };
}

export interface HistoryRecordRow {
  record: GradingHistoryRecord;
  templateId: string;
  templateTitle: string;
  /** 当次评分标准快照；旧记录缺失时回退到模板当前版本，保证详情页可展示评分依据。 */
  rubric: Rubric;
}

function historyRecordRows(database: HistoryDatabase, match?: (record: StoredHistoryRecord) => boolean): HistoryRecordRow[] {
  const rows: HistoryRecordRow[] = [];
  for (const template of database.templates) {
    for (const record of template.records) {
      if (match && !match(record)) continue;
      rows.push({
        record: toPublicHistoryRecord(record),
        templateId: template.id,
        templateTitle: template.title,
        rubric: record.rubricSnapshot ?? template.rubric
      });
    }
  }
  rows.sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt));
  return rows;
}

/** 聚合历史记录列表（按批改时间倒序），避免前端逐个模板拉取详情的 N+1 请求。 */
export async function listGradingRecords(limit = 100): Promise<HistoryRecordRow[]> {
  const database = await readDatabase();
  return historyRecordRows(database).slice(0, Math.max(1, Math.min(limit, 500)));
}

/** 按记录 id 或结果 id 精确查找一条历史记录。 */
export async function findGradingRecord(recordId: string): Promise<HistoryRecordRow | null> {
  const database = await readDatabase();
  const rows = historyRecordRows(database, (record) => record.id === recordId || record.result.id === recordId);
  return rows[0] ?? null;
}

export async function getGradingRecordModelCalls(recordId: string): Promise<GradingHistoryRecord["modelCalls"] | null> {
  const database = await readDatabase();
  for (const template of database.templates) {
    const record = template.records.find((item) => item.id === recordId || item.result.id === recordId);
    if (record) return structuredClone(record.modelCalls ?? []);
  }
  return null;
}

export function resolveAssetPath(templateId: string, diskName: string): string | null {
  if (!/^[a-f0-9-]+$/i.test(templateId) || !/^[a-z]+-[a-f0-9-]+\.[a-z0-9]+$/i.test(diskName)) return null;
  const resolved = path.resolve(assetsDirectory, templateId, diskName);
  const expectedParent = `${path.resolve(assetsDirectory, templateId)}${path.sep}`;
  return resolved.startsWith(expectedParent) ? resolved : null;
}
