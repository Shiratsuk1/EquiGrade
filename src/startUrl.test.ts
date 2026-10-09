import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_START_URL_MIGRATION_VERSION,
  DEFAULT_START_URL,
  detectStartUrlPreset,
  readStartUrl,
  RUIYA_START_URL,
  saveStartUrl,
  START_URL_MIGRATION_KEY,
  START_URL_PRESETS,
  START_URL_STORAGE_KEY,
  ZHIXUE_START_URL
} from "../shared/startUrl";

function storage(initialMap: Record<string, string | null> = {}) {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(initialMap)) {
    if (v !== null) map.set(k, v);
  }
  const getItem = vi.fn((key: string) => map.get(key) ?? null);
  const setItem = vi.fn((key: string, value: string) => {
    map.set(key, value);
  });
  return { getItem, setItem, map };
}

describe("startup grading URL", () => {
  it("uses and saves the Zhixue grading page for a new installation", () => {
    const target = storage();

    expect(readStartUrl(target)).toBe(DEFAULT_START_URL);
    expect(DEFAULT_START_URL).toBe(ZHIXUE_START_URL);
    expect(target.setItem).toHaveBeenCalledWith(START_URL_STORAGE_KEY, ZHIXUE_START_URL);
    expect(target.setItem).toHaveBeenCalledWith(START_URL_MIGRATION_KEY, CURRENT_START_URL_MIGRATION_VERSION);
  });

  it("migrates the previous temporary default Ruiya grading page back to Zhixue", () => {
    const target = storage({ [START_URL_STORAGE_KEY]: RUIYA_START_URL });

    expect(readStartUrl(target)).toBe(ZHIXUE_START_URL);
    expect(target.setItem).toHaveBeenCalledWith(START_URL_STORAGE_KEY, ZHIXUE_START_URL);
    expect(target.setItem).toHaveBeenCalledWith(START_URL_MIGRATION_KEY, CURRENT_START_URL_MIGRATION_VERSION);
  });

  it("preserves Ruiya once explicitly chosen or migrated in current version", () => {
    const target = storage({
      [START_URL_STORAGE_KEY]: RUIYA_START_URL,
      [START_URL_MIGRATION_KEY]: CURRENT_START_URL_MIGRATION_VERSION
    });

    expect(readStartUrl(target)).toBe(RUIYA_START_URL);
    expect(target.setItem).not.toHaveBeenCalled();
  });

  it("migrates a stale Zhixue login landing page", () => {
    const target = storage({ [START_URL_STORAGE_KEY]: "https://www.zhixue.com/login.html" });

    expect(readStartUrl(target)).toBe(DEFAULT_START_URL);
    expect(target.setItem).toHaveBeenCalledWith(START_URL_STORAGE_KEY, DEFAULT_START_URL);
  });

  it.each([
    "http://127.0.0.1:2398/zhixue-mock?embedded=1",
    "http://localhost:5173/zhixue-mock?embedded=1",
    "http://127.0.0.1:5173/mock-grading"
  ])("migrates an old built-in test page: %s", (legacyUrl) => {
    const target = storage({ [START_URL_STORAGE_KEY]: legacyUrl });

    expect(readStartUrl(target)).toBe(DEFAULT_START_URL);
    expect(target.setItem).toHaveBeenCalledWith(START_URL_STORAGE_KEY, DEFAULT_START_URL);
  });

  it("keeps a user-defined real grading URL", () => {
    const customUrl = "https://school.zhixue.com/webmarking/custom-task";
    const target = storage({ [START_URL_STORAGE_KEY]: customUrl });

    expect(readStartUrl(target)).toBe(customUrl);
    expect(target.setItem).toHaveBeenCalledWith(START_URL_MIGRATION_KEY, CURRENT_START_URL_MIGRATION_VERSION);
  });

  it("correctly identifies presets with detectStartUrlPreset", () => {
    expect(detectStartUrlPreset(ZHIXUE_START_URL)).toBe("zhixue");
    expect(detectStartUrlPreset(RUIYA_START_URL)).toBe("ruiya");
    expect(detectStartUrlPreset("https://www.zhixue.com/custom-page")).toBe("zhixue");
    expect(detectStartUrlPreset("https://ruiya.onlyets.com/custom-page")).toBe("ruiya");
    expect(detectStartUrlPreset("https://example.com/other")).toBeNull();
  });

  it("saves a new preset with saveStartUrl and updates migration marker", () => {
    const target = storage();
    saveStartUrl(target, RUIYA_START_URL);

    expect(target.setItem).toHaveBeenCalledWith(START_URL_STORAGE_KEY, RUIYA_START_URL);
    expect(target.setItem).toHaveBeenCalledWith(START_URL_MIGRATION_KEY, CURRENT_START_URL_MIGRATION_VERSION);
    expect(readStartUrl(target)).toBe(RUIYA_START_URL);
  });

  it("exports both zhixue and ruiya in START_URL_PRESETS", () => {
    const ids = START_URL_PRESETS.map((p) => p.id);
    expect(ids).toContain("zhixue");
    expect(ids).toContain("ruiya");
  });
});
