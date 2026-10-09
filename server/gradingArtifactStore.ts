import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GradingArtifact,
  GradingArtifactCategory,
  GradingResult,
  ModelCallHistoryEntry,
  Rubric
} from "../shared/types.js";

export interface GradingArtifactImageSource {
  mimeType: string;
  base64: string;
  label?: string;
}

export interface GradingAgentArtifactSource {
  fileName: string;
  mimeType: string;
  category: GradingArtifactCategory;
  buffer: Buffer;
}

/** 批改完成后交给历史存储的中间产物；不包含原始答卷图。 */
export interface GradingArtifactSource {
  preprocessedStudentAnswer: {
    buffer: Buffer;
    mimeType: string;
    fileName: string;
  };
  questionImages: GradingArtifactImageSource[];
  referenceImages: GradingArtifactImageSource[];
  questionText?: string;
  referenceText?: string;
  rubric: Rubric;
  /** Derived WebP grid/crop artifacts from the Responses Agent run. */
  agentArtifacts?: GradingAgentArtifactSource[];
  /** High-resolution cropped answer regions per subquestion from large-question triage. */
  subquestionCrops?: GradingAgentArtifactSource[];
}

interface PendingArtifact {
  diskName: string;
  fileName: string;
  mimeType: string;
  category: GradingArtifactCategory;
  buffer: Buffer;
}

const DEFAULT_ARTIFACT_DIRECTORY = path.resolve("grading-artifacts");
const safeSegmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;

/** 默认位于项目根目录 grading-artifacts，可用环境变量改到其他明确目录。 */
export function getGradingArtifactDirectory(): string {
  const configured = process.env.HENGZHUN_GRADING_ARTIFACT_DIR?.trim();
  return configured ? path.resolve(configured) : DEFAULT_ARTIFACT_DIRECTORY;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/bmp") return ".bmp";
  return ".jpg";
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 === 1 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("批改产物中的图片 Base64 无效");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length) throw new Error("批改产物中的图片为空");
  return buffer;
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

function textBuffer(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function materialFileName(prefix: string, index: number, mimeType: string): string {
  return `${prefix}-${String(index + 1).padStart(2, "0")}${extensionForMimeType(mimeType)}`;
}

function artifactUrl(resultId: string, diskName: string): string {
  return `/api/grading-artifacts/${encodeURIComponent(resultId)}/${encodeURIComponent(diskName)}`;
}

function publicArtifact(resultId: string, artifact: PendingArtifact): GradingArtifact {
  return {
    id: artifact.diskName,
    fileName: artifact.fileName,
    mimeType: artifact.mimeType,
    bytes: artifact.buffer.length,
    category: artifact.category,
    url: artifactUrl(resultId, artifact.diskName)
  };
}

export async function saveGradingArtifacts(input: {
  result: GradingResult;
  source: GradingArtifactSource;
  modelCalls: ModelCallHistoryEntry[];
}): Promise<GradingArtifact[]> {
  const resultId = input.result.id;
  if (!safeSegmentPattern.test(resultId)) throw new Error("批改结果 ID 不能用于创建产物目录");

  const directory = path.join(getGradingArtifactDirectory(), resultId);
  const pending: PendingArtifact[] = [];
  const add = (diskName: string, fileName: string, mimeType: string, category: GradingArtifactCategory, buffer: Buffer) => {
    if (!safeSegmentPattern.test(diskName)) throw new Error(`批改产物文件名无效：${diskName}`);
    pending.push({ diskName, fileName, mimeType, category, buffer });
  };

  const preprocessedExtension = extensionForMimeType(input.source.preprocessedStudentAnswer.mimeType);
  add(
    `student-answer-preprocessed${preprocessedExtension}`,
    `学生答卷-预处理后${preprocessedExtension}`,
    input.source.preprocessedStudentAnswer.mimeType,
    "preprocessed_answer",
    input.source.preprocessedStudentAnswer.buffer
  );

  const questionMaterials = input.source.questionImages.map((image, index) => ({
    diskName: materialFileName("question", index, image.mimeType),
    fileName: `题目图片-${String(index + 1).padStart(2, "0")}${extensionForMimeType(image.mimeType)}`,
    mimeType: image.mimeType,
    label: image.label,
    buffer: decodeBase64(image.base64)
  }));
  const referenceMaterials = input.source.referenceImages.map((image, index) => ({
    diskName: materialFileName("reference", index, image.mimeType),
    fileName: `参考答案图片-${String(index + 1).padStart(2, "0")}${extensionForMimeType(image.mimeType)}`,
    mimeType: image.mimeType,
    label: image.label,
    buffer: decodeBase64(image.base64)
  }));
  for (const image of [...questionMaterials, ...referenceMaterials]) {
    add(image.diskName, image.fileName, image.mimeType, "material", image.buffer);
  }

  for (const artifact of input.source.agentArtifacts ?? []) {
    const diskName = `agent-${artifact.fileName.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    add(diskName, artifact.fileName, artifact.mimeType, artifact.category, artifact.buffer);
  }

  for (const artifact of input.source.subquestionCrops ?? []) {
    const diskName = `answer-crop-${artifact.fileName.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    add(diskName, artifact.fileName, artifact.mimeType, artifact.category, artifact.buffer);
  }

  add("grading-context.json", "批改上下文.json", "application/json", "result", jsonBuffer({
    version: 1,
    resultId,
    studentId: input.result.studentId,
    sourceFileName: input.result.fileName,
    sourceMimeType: input.source.preprocessedStudentAnswer.mimeType,
    rubricVersion: input.result.rubricVersion,
    questionType: input.source.rubric.questionType,
    gradingPipeline: input.result.gradingPipeline,
    gradingMode: input.result.gradingMode,
    questionText: input.source.questionText ?? "",
    referenceText: input.source.referenceText ?? "",
    rubric: input.source.rubric,
    preprocessedStudentAnswer: {
      fileName: input.source.preprocessedStudentAnswer.fileName,
      mimeType: input.source.preprocessedStudentAnswer.mimeType,
      bytes: input.source.preprocessedStudentAnswer.buffer.length
    },
    questionImages: questionMaterials.map(({ diskName, fileName, mimeType, label, buffer }) => ({ diskName, fileName, mimeType, label, bytes: buffer.length })),
    referenceImages: referenceMaterials.map(({ diskName, fileName, mimeType, label, buffer }) => ({ diskName, fileName, mimeType, label, bytes: buffer.length }))
  }));

  if (input.result.ocrAudit) {
    add("ocr.raw.jsonl", "PaddleOCR-原始JSONL.jsonl", "application/jsonl", "ocr", textBuffer(input.result.ocrAudit.rawJsonl));
    add("ocr.markdown.md", "PaddleOCR-辅助文本.md", "text/markdown", "ocr", textBuffer(input.result.ocrAudit.markdownText));
    add("ocr.layout-blocks.json", "PaddleOCR-bbox区块.json", "application/json", "ocr", jsonBuffer(input.result.ocrAudit.layoutBlocks ?? []));
    add("ocr.audit.json", "PaddleOCR-审计结果.json", "application/json", "ocr", jsonBuffer(input.result.ocrAudit));
  }

  add("model-calls.json", "模型调用记录.json", "application/json", "model", jsonBuffer(input.modelCalls));
  add("grading-result.json", "批改结果.json", "application/json", "result", jsonBuffer(input.result));

  await mkdir(directory, { recursive: true });
  try {
    await Promise.all(pending.map((artifact) => writeFile(path.join(directory, artifact.diskName), artifact.buffer)));
    const publicArtifacts = pending.map((artifact) => publicArtifact(resultId, artifact));
    const manifestBuffer = jsonBuffer({
      version: 1,
      resultId,
      createdAt: new Date().toISOString(),
      note: "原始学生答卷图不在本目录重复保存；student-answer-preprocessed 为稳定链路使用的结果图，agent-* 为 Responses Agent 的 WebP q90 网格和局部图。",
      files: publicArtifacts
    });
    await writeFile(path.join(directory, "artifact-manifest.json"), manifestBuffer);
    publicArtifacts.push({
      id: "artifact-manifest.json",
      fileName: "批改产物清单.json",
      mimeType: "application/json",
      bytes: manifestBuffer.length,
      category: "result",
      url: artifactUrl(resultId, "artifact-manifest.json")
    });
    return publicArtifacts;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function resolveGradingArtifactPath(resultId: string, diskName: string): string | null {
  if (!safeSegmentPattern.test(resultId) || !safeSegmentPattern.test(diskName)) return null;
  const resultDirectory = path.resolve(getGradingArtifactDirectory(), resultId);
  const resolved = path.resolve(resultDirectory, diskName);
  const expectedParent = `${resultDirectory}${path.sep}`;
  return resolved.startsWith(expectedParent) ? resolved : null;
}

export async function deleteGradingArtifacts(resultIds: string[]): Promise<void> {
  const directories = resultIds
    .filter((resultId) => safeSegmentPattern.test(resultId))
    .map((resultId) => path.join(getGradingArtifactDirectory(), resultId));
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
}
