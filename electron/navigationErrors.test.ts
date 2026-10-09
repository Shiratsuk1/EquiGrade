import { describe, expect, it } from "vitest";
import { isAbortedNavigationError } from "./navigationErrors.js";

describe("Electron navigation error recognition", () => {
  it("recognizes Electron's aborted navigation variants", () => {
    expect(isAbortedNavigationError({ code: "ERR_ABORTED" })).toBe(true);
    expect(isAbortedNavigationError({ errno: -3 })).toBe(true);
    expect(isAbortedNavigationError(new Error("ERR_ABORTED (-3) loading 'https://example.com'"))).toBe(true);
  });

  it("does not hide unrelated navigation failures", () => {
    expect(isAbortedNavigationError({ code: "ERR_FAILED", errno: -2 })).toBe(false);
    expect(isAbortedNavigationError("ERR_ABORTED")).toBe(false);
  });
});
