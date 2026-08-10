import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalPipelineTask } from "../shared/types.js";
import { normalizeUploadedFileName } from "./historyStore.js";

interface StoredLocalPipelineAnswer extends Omit<LocalPipelineTask["answers"][number], "url"> {
  diskName: string;
}

interface StoredLocalPipelineTask extends Omit<LocalPipelineTask, "answers"> {
  answers: StoredLocalPipelineAnswer[];
}

const dataDirectory = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.resolve(".data");
const taskDirectory = path.join(dataDirectory, "local-pipeline-tasks");

function extensionFor(file: Express.Multer.File): string {
  const fromName = path.extname(file.originalname).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  if (file.mimetype === "image/png") return ".png";
  if (file.mimetype === "image/webp") return ".webp";
  return ".jpg";
}

function publicTask(task: StoredLocalPipelineTask): LocalPipelineTask {
  return {
    ...task,
    answers: task.answers.map(({ diskName, ...answer }) => ({
      ...answer,
      url: `/api/pipeline-task-assets/${task.id}/${diskName}`
    }))
  };
}

export async function createLocalPipelineTask(input: {
  templateId: string;
  templateTitle: string;
  totalScore: number;
  files: Express.Multer.File[];
  studentIds: string[];
}): Promise<LocalPipelineTask> {
  const id = crypto.randomUUID();
  const directory = path.join(taskDirectory, id);
  await mkdir(directory, { recursive: true });
  const answers: StoredLocalPipelineAnswer[] = [];

  for (const [index, file] of input.files.entries()) {
    const answerId = crypto.randomUUID();
    const diskName = `answer-${answerId}${extensionFor(file)}`;
    await writeFile(path.join(directory, diskName), file.buffer);
    answers.push({
      id: answerId,
      studentId: input.studentIds[index]?.trim() || `学生 ${String(index + 1).padStart(2, "0")}`,
      fileName: normalizeUploadedFileName(file.originalname),
      mimeType: file.mimetype,
      diskName
    });
  }

  const task: StoredLocalPipelineTask = {
    id,
    templateId: input.templateId,
    templateTitle: input.templateTitle,
    totalScore: input.totalScore,
    createdAt: new Date().toISOString(),
    answers
  };
  await writeFile(path.join(directory, "task.json"), JSON.stringify(task, null, 2), "utf8");
  return publicTask(task);
}

export async function getLocalPipelineTask(id: string): Promise<LocalPipelineTask | null> {
  if (!/^[a-f0-9-]+$/i.test(id)) return null;
  try {
    const task = JSON.parse(await readFile(path.join(taskDirectory, id, "task.json"), "utf8")) as StoredLocalPipelineTask;
    if (task.id !== id) return null;
    return publicTask(task);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function resolveLocalPipelineTaskAssetPath(taskId: string, diskName: string): string | null {
  if (!/^[a-f0-9-]+$/i.test(taskId) || !/^answer-[a-f0-9-]+\.[a-z0-9]+$/i.test(diskName)) return null;
  const resolved = path.resolve(taskDirectory, taskId, diskName);
  const expectedParent = `${path.resolve(taskDirectory, taskId)}${path.sep}`;
  return resolved.startsWith(expectedParent) ? resolved : null;
}
