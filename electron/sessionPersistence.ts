import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type PersistedTargetCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  expirationDate?: number;
};

export type CookieSetDetails = {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: PersistedTargetCookie["sameSite"];
  expirationDate?: number;
};

export type PersistedPipelineTaskSelection = {
  mode: "production" | "test";
  targetUrl: string;
  templateId?: string;
};

type CookieVaultEnvelope = {
  version: 1;
  savedAt: string;
  cookies: PersistedTargetCookie[];
};

export type CookieVaultCrypto = {
  available(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(cipherText: Buffer): string;
};

export function isTargetCookieDomain(domain: string) {
  const normalized = domain.replace(/^\./, "").toLowerCase();
  return /(^|\.)zhixue\.com$/.test(normalized) || /(^|\.)onlyets\.com$/.test(normalized);
}

export function selectTargetCookies(cookies: PersistedTargetCookie[]) {
  return cookies.filter((cookie) => isTargetCookieDomain(cookie.domain));
}

// Keep the old names as compatibility aliases for existing callers and stored-session tests.
export const isZhixueCookieDomain = isTargetCookieDomain;
export const selectZhixueCookies = selectTargetCookies;

export function toCookieSetDetails(cookie: PersistedTargetCookie): CookieSetDetails {
  const hostname = cookie.domain.replace(/^\./, "");
  const cookiePath = cookie.path.startsWith("/") ? cookie.path : `/${cookie.path}`;
  return {
    url: `${cookie.secure ? "https" : "http"}://${hostname}${cookiePath}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookiePath,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate })
  };
}

function isPersistedCookie(value: unknown): value is PersistedTargetCookie {
  if (!value || typeof value !== "object") return false;
  const cookie = value as Partial<PersistedTargetCookie>;
  return typeof cookie.name === "string"
    && typeof cookie.value === "string"
    && typeof cookie.domain === "string"
    && typeof cookie.hostOnly === "boolean"
    && typeof cookie.path === "string"
    && typeof cookie.secure === "boolean"
    && typeof cookie.httpOnly === "boolean"
    && (cookie.expirationDate === undefined || Number.isFinite(cookie.expirationDate));
}

export class EncryptedCookieVault {
  constructor(private readonly filePath: string, private readonly crypto: CookieVaultCrypto) {}

  isAvailable() {
    return this.crypto.available();
  }

  async save(cookies: PersistedTargetCookie[]) {
    if (!this.crypto.available()) return 0;
    const selected = selectTargetCookies(cookies);
    const envelope: CookieVaultEnvelope = {
      version: 1,
      savedAt: new Date().toISOString(),
      cookies: selected
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, this.crypto.encrypt(JSON.stringify(envelope)));
    await rename(temporaryPath, this.filePath).catch(async () => {
      await writeFile(this.filePath, this.crypto.encrypt(JSON.stringify(envelope)));
      await unlink(temporaryPath).catch(() => undefined);
    });
    return selected.length;
  }

  async load() {
    if (!this.crypto.available()) return [];
    let cipherText: Buffer;
    try {
      cipherText = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const envelope = JSON.parse(this.crypto.decrypt(cipherText)) as Partial<CookieVaultEnvelope>;
    if (envelope.version !== 1 || !Array.isArray(envelope.cookies)) throw new Error("认证 Cookie 保险库格式无效");
    return selectTargetCookies(envelope.cookies.filter(isPersistedCookie));
  }
}

export function isAuthenticationUrl(value: string) {
  try {
    const url = new URL(value);
    if (!isTargetCookieDomain(url.hostname)) return false;
    return /(?:^|[\/_-])(login|logout|loginout|passport|sso)(?=[\/_.-]|$)/i.test(`${url.pathname}${url.hash}`);
  } catch {
    return false;
  }
}

export function isRestorableTargetUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (isAuthenticationUrl(value)) return false;
    if (isTargetCookieDomain(url.hostname) && url.pathname === "/" && !url.search && !url.hash) return false;
    return true;
  } catch {
    return false;
  }
}

export class TargetNavigationStore {
  constructor(private readonly filePath: string) {}

  async save(url: string) {
    if (!isRestorableTargetUrl(url)) return false;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), url }, null, 2), "utf8");
    return true;
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as { version?: number; url?: string };
      return value.version === 1 && typeof value.url === "string" && isRestorableTargetUrl(value.url) ? value.url : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export class PipelineTaskStore {
  constructor(private readonly filePath: string) {}

  async save(selection: PersistedPipelineTaskSelection) {
    if (!isRestorableTargetUrl(selection.targetUrl)) throw new Error("当前阅卷页面地址不可持久化");
    if (selection.mode === "production" && !selection.templateId?.trim()) {
      throw new Error("真实批改任务缺少评分模板 ID，无法持久化");
    }
    const payload = {
      version: 1 as const,
      savedAt: new Date().toISOString(),
      mode: selection.mode,
      targetUrl: selection.targetUrl,
      ...(selection.templateId?.trim() ? { templateId: selection.templateId.trim() } : {})
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2), "utf8");
    await rename(temporaryPath, this.filePath).catch(async () => {
      await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
      await unlink(temporaryPath).catch(() => undefined);
    });
  }

  async load(): Promise<PersistedPipelineTaskSelection | undefined> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PersistedPipelineTaskSelection> & { version?: number };
      if (value.version !== 1
        || (value.mode !== "production" && value.mode !== "test")
        || typeof value.targetUrl !== "string"
        || !isRestorableTargetUrl(value.targetUrl)
        || (value.mode === "production" && (typeof value.templateId !== "string" || !value.templateId.trim()))) return undefined;
      return {
        mode: value.mode,
        targetUrl: value.targetUrl,
        ...(typeof value.templateId === "string" && value.templateId.trim() ? { templateId: value.templateId.trim() } : {})
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async clear() {
    await unlink(this.filePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
