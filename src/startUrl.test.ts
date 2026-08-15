import { describe, expect, it, vi } from "vitest";
import { DEFAULT_START_URL, readStartUrl, START_URL_STORAGE_KEY } from "../shared/startUrl";

function storage(value: string | null) {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn()
  };
}

describe("startup grading URL", () => {
  it("uses and saves the Zhixue grading page for a new installation", () => {
    const target = storage(null);

    expect(readStartUrl(target)).toBe(DEFAULT_START_URL);
    expect(target.setItem).toHaveBeenCalledWith(START_URL_STORAGE_KEY, DEFAULT_START_URL);
  });

  it.each([
    "http://127.0.0.1:2398/zhixue-mock?embedded=1",
    "http://localhost:5173/zhixue-mock?embedded=1",
    "http://127.0.0.1:5173/mock-grading"
  ])("migrates an old built-in test page: %s", (legacyUrl) => {
    const target = storage(legacyUrl);

    expect(readStartUrl(target)).toBe(DEFAULT_START_URL);
    expect(target.setItem).toHaveBeenCalledWith(START_URL_STORAGE_KEY, DEFAULT_START_URL);
  });

  it("keeps a user-defined real grading URL", () => {
    const customUrl = "https://school.zhixue.com/webmarking/custom-task";
    const target = storage(customUrl);

    expect(readStartUrl(target)).toBe(customUrl);
    expect(target.setItem).not.toHaveBeenCalled();
  });
});
