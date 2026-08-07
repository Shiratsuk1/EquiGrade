import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelConfigInput, PublicModelConfig } from "../shared/types.js";

interface StoredConfig extends ModelConfigInput {
  id: string;
  updatedAt: string;
}

interface EncryptedPayload {
  iv: string;
  tag: string;
  data: string;
}

const dataDirectory = path.resolve(".data");
const keyPath = path.join(dataDirectory, "master.key");
const configPath = path.join(dataDirectory, "model-config.enc.json");

async function getEncryptionKey(): Promise<Buffer> {
  await mkdir(dataDirectory, { recursive: true });
  try {
    return Buffer.from(await readFile(keyPath, "utf8"), "base64");
  } catch {
    const key = randomBytes(32);
    await writeFile(keyPath, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
    return key;
  }
}

async function encrypt(value: StoredConfig): Promise<EncryptedPayload> {
  const key = await getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64")
  };
}

async function decrypt(payload: EncryptedPayload): Promise<StoredConfig> {
  const key = await getEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString("utf8")) as StoredConfig;
}

export async function readModelConfig(): Promise<StoredConfig | null> {
  try {
    const payload = JSON.parse(await readFile(configPath, "utf8")) as EncryptedPayload;
    return await decrypt(payload);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveModelConfig(input: ModelConfigInput): Promise<PublicModelConfig> {
  const current = await readModelConfig();
  const apiKey = input.apiKey?.trim() || current?.apiKey || "";
  const stored: StoredConfig = {
    ...input,
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    apiKey,
    id: current?.id ?? crypto.randomUUID(),
    updatedAt: new Date().toISOString()
  };
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify(await encrypt(stored)), "utf8");
  return toPublicConfig(stored);
}

export function toPublicConfig(config: StoredConfig): PublicModelConfig {
  const apiKey = config.apiKey ?? "";
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    visionModel: config.visionModel,
    textModel: config.textModel,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxConcurrency: config.maxConcurrency,
    maxOutputTokens: config.maxOutputTokens,
    supportsJsonSchema: config.supportsJsonSchema,
    supportsJsonObject: config.supportsJsonObject,
    supportsBase64Images: config.supportsBase64Images,
    enabled: config.enabled,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 3)}${"•".repeat(10)}${apiKey.slice(-4)}` : "",
    updatedAt: config.updatedAt
  };
}

