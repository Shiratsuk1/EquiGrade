import { describe, expect, it } from "vitest";
import {
  calculateImageFitScale, clampImageOffset, clampImageScale, imageOffsetAfterZoom
} from "./answerImageViewer";

describe("answer image viewer geometry", () => {
  it("fits a large answer sheet inside the viewport without upscaling", () => {
    expect(calculateImageFitScale(
      { width: 2000, height: 3000 },
      { width: 1000, height: 800 },
      20
    )).toBeCloseTo(760 / 3000);
    expect(calculateImageFitScale(
      { width: 400, height: 300 },
      { width: 1000, height: 800 }
    )).toBe(1);
  });

  it("allows fit scales below the normal zoom floor", () => {
    expect(clampImageScale(0.05, 0.1)).toBe(0.1);
    expect(clampImageScale(8, 0.1)).toBe(4);
  });

  it("keeps panning within the visible image bounds", () => {
    expect(clampImageOffset(
      { x: 900, y: -900 },
      { width: 1000, height: 800 },
      { width: 600, height: 500 },
      1
    )).toEqual({ x: 200, y: -150 });
  });

  it("keeps the point under the cursor stable while zooming", () => {
    expect(imageOffsetAfterZoom(
      { x: 0, y: 0 },
      1,
      2,
      { x: 750, y: 400 },
      { width: 1000, height: 800 }
    )).toEqual({ x: -250, y: 0 });
  });
});
