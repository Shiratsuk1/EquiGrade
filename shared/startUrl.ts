export const DEFAULT_START_URL = "https://www.zhixue.com/htm-container-web/index.html?app-0=%252Fwebmarking%252FmasYORCzV%252F%2523%252Fmarking%252Fpersonal%252F%253FisArbitration%253Dfalse%2526markingPaperId%253D404da69b-2927-4a9d-9874-ec585c49e09a%2526examId%253D1a49e5f0-b0e2-457c-9f0d-9887766a235e%2526gradeCode%253D12#/zx-subapp-dlkeWj9mrqO39IW3IeYQzARZKMejb6vzHyApfrcYTrnGXA5UlkFsxvTxduSpjL";

export const START_URL_STORAGE_KEY = "hengzhun.startUrl";

type StartUrlStorage = {
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

export function readStartUrl(storage: StartUrlStorage) {
  const saved = storage.getItem(START_URL_STORAGE_KEY)?.trim();
  if (saved && !isLegacyMockStartUrl(saved)) return saved;
  storage.setItem(START_URL_STORAGE_KEY, DEFAULT_START_URL);
  return DEFAULT_START_URL;
}
