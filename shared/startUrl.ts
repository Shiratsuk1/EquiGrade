export const ZHIXUE_DEFAULT_START_URL =
  "https://www.zhixue.com/htm-container-web/index.html?app-0=%252Fwebmarking%252FmasYORCzV%252F%2523%252Fmarking%252Fpersonal%252F%253FisArbitration%253Dfalse%2526markingPaperId%253D404da69b-2927-4a9d-9874-ec585c49e09a%2526examId%253D1a49e5f0-b0e2-457c-9f0d-9887766a235e%2526gradeCode%253D12#/zx-subapp-dlkeWj9mrqO39IW3IeYQzARZKMejb6vzHyApfrcYTrnGXA5UlkFsxvTxduSpjL";

export const RUIYA_DEFAULT_START_URL =
  "https://ruiya.onlyets.com/mark/v6/view/06D1A36DED0224A761ACB3EF568FF7C1";

export const ZHIXUE_START_URL = ZHIXUE_DEFAULT_START_URL;
export const RUIYA_START_URL = RUIYA_DEFAULT_START_URL;

export const DEFAULT_START_URL = ZHIXUE_DEFAULT_START_URL;
export const LEGACY_DEFAULT_START_URL = ZHIXUE_DEFAULT_START_URL;

export const START_URL_STORAGE_KEY = "hengzhun.startUrl";
export const START_URL_MIGRATION_KEY = "hengzhun.startUrlMigratedVersion";
export const CURRENT_START_URL_MIGRATION_VERSION = "20260910-zhixue";

export type StartUrlPresetId = "zhixue" | "ruiya";

export interface StartUrlPreset {
  id: StartUrlPresetId;
  name: string;
  url: string;
  description: string;
  adapterId: string;
}

export const START_URL_PRESETS: readonly StartUrlPreset[] = [
  {
    id: "zhixue",
    name: "智学网",
    url: ZHIXUE_DEFAULT_START_URL,
    description: "智学网个人阅卷页（多小题分布写分、提交与翻页）",
    adapterId: "zhixue-grading"
  },
  {
    id: "ruiya",
    name: "睿芽网",
    url: RUIYA_DEFAULT_START_URL,
    description: "睿芽考试服务云阅卷页（单题总分写入与自动进入下一份）",
    adapterId: "ruiya-grading"
  }
] as const;

export type StartUrlStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function isLegacyMockStartUrl(value: string) {
  try {
    const url = new URL(value);
    const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.protocol === "http:"
      && localHost
      && (url.pathname === "/zhixue-mock" || url.pathname === "/mock-grading");
  } catch {
    return false;
  }
}

export function isLegacyDefaultStartUrl(_value: string) {
  return false;
}

export function isLegacyZhixueLoginStartUrl(value: string) {
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const isZhixueHost = hostname === "zhixue.com" || hostname.endsWith(".zhixue.com");
    return url.protocol === "https:"
      && isZhixueHost
      && url.pathname.toLowerCase() === "/login.html"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function detectStartUrlPreset(url: string): StartUrlPresetId | null {
  const trimmed = url.trim();
  if (trimmed === ZHIXUE_DEFAULT_START_URL) return "zhixue";
  if (trimmed === RUIYA_DEFAULT_START_URL) return "ruiya";
  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "zhixue.com" || hostname.endsWith(".zhixue.com")) return "zhixue";
    if (hostname === "onlyets.com" || hostname.endsWith(".onlyets.com") || hostname.includes("ruiya")) return "ruiya";
  } catch {
    // ignore
  }
  return null;
}

export function saveStartUrl(storage: StartUrlStorage, value: string) {
  const trimmed = value.trim();
  storage.setItem(START_URL_STORAGE_KEY, trimmed);
  storage.setItem(START_URL_MIGRATION_KEY, CURRENT_START_URL_MIGRATION_VERSION);
  return trimmed;
}

export function readStartUrl(storage: StartUrlStorage) {
  const saved = storage.getItem(START_URL_STORAGE_KEY)?.trim();
  const migrated = storage.getItem(START_URL_MIGRATION_KEY);

  if (migrated === CURRENT_START_URL_MIGRATION_VERSION) {
    if (saved && !isLegacyMockStartUrl(saved) && !isLegacyZhixueLoginStartUrl(saved)) {
      return saved;
    }
    storage.setItem(START_URL_STORAGE_KEY, DEFAULT_START_URL);
    return DEFAULT_START_URL;
  }

  // 首次升级到以智学网为默认的当前版本：
  // 若之前保存的是旧临时默认睿芽地址或不可用地址，迁移回智学网默认地址；若用户配置了其他自定义地址则保留。
  storage.setItem(START_URL_MIGRATION_KEY, CURRENT_START_URL_MIGRATION_VERSION);
  if (!saved || isLegacyMockStartUrl(saved) || isLegacyZhixueLoginStartUrl(saved) || saved === RUIYA_DEFAULT_START_URL) {
    storage.setItem(START_URL_STORAGE_KEY, DEFAULT_START_URL);
    return DEFAULT_START_URL;
  }
  return saved;
}
