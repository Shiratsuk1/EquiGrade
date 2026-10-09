import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { detectModelNativeLayout, normalizeBlockCoordinates } from "./modelNativeLayout.js";
import { callStructured } from "./modelClient.js";
import type { ModelConfigInput } from "../shared/types.js";

vi.mock("./modelClient.js", () => ({
  callStructured: vi.fn()
}));

const mockConfig: ModelConfigInput = {
  name: "test",
  baseUrl: "https://example.com/v1",
  visionModel: "gpt-5.6-sol",
  textModel: "gpt-5.6-sol",
  timeoutMs: 30000,
  maxRetries: 2,
  maxConcurrency: 1,
  maxOutputTokens: 2000,
  unreadableReviewThreshold: 3,
  supportsJsonSchema: true,
  supportsJsonObject: true,
  supportsBase64Images: true,
  enabled: true
};

describe("normalizeBlockCoordinates", () => {
  it("scales normalized 0..1000 coordinates to image pixel dimensions", () => {
    const coords: [number, number, number, number] = [100, 200, 900, 800];
    const [x1, y1, x2, y2] = normalizeBlockCoordinates(coords, 1000, 2000);
    expect(x1).toBe(100);
    expect(y1).toBe(400);
    expect(x2).toBe(900);
    expect(y2).toBe(1600);
  });

  it("handles reversed coordinate order [x2, y2, x1, y1]", () => {
    const coords: [number, number, number, number] = [900, 800, 100, 200];
    const [x1, y1, x2, y2] = normalizeBlockCoordinates(coords, 1000, 1000);
    expect(x1).toBe(100);
    expect(y1).toBe(200);
    expect(x2).toBe(900);
    expect(y2).toBe(800);
  });

  it("clamps out-of-bounds pixel coordinates and ensures minimum dimension", () => {
    const coords: [number, number, number, number] = [500, 500, 500, 500];
    const [x1, y1, x2, y2] = normalizeBlockCoordinates(coords, 800, 600);
    expect(x1).toBe(400); // 500/1000 * 800
    expect(y1).toBe(300); // 500/1000 * 600
    expect(x2).toBe(402); // minimum 2px
    expect(y2).toBe(302); // minimum 2px
  });
});

describe("detectModelNativeLayout", () => {
  it("formats model-detected layout blocks into a valid PaddleOcrAudit structure", async () => {
    const testImage = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 } }
    }).png().toBuffer();

    vi.mocked(callStructured).mockResolvedValueOnce({
      data: {
        blocks: [
          {
            label: "printed",
            coordinate: [50, 50, 950, 200],
            description: "题干与题图"
          },
          {
            label: "handwriting",
            coordinate: [60, 220, 900, 500],
            description: "手写计算过程"
          }
        ]
      },
      durationMs: 120,
      outputMode: "json_schema"
    });

    const audit = await detectModelNativeLayout({
      imageBuffer: testImage,
      mimeType: "image/png",
      config: mockConfig,
      operationId: "op-test-layout"
    });

    expect(audit.provider).toBe("model_native");
    expect(audit.imageWidth).toBe(800);
    expect(audit.imageHeight).toBe(600);
    expect(audit.layoutBlocks).toHaveLength(2);

    const first = audit.layoutBlocks![0]!;
    expect(first.blockId).toBe("block-00");
    expect(first.label).toBe("image");
    expect(first.coordinate).toEqual([40, 30, 760, 120]);

    const second = audit.layoutBlocks![1]!;
    expect(second.blockId).toBe("block-01");
    expect(second.label).toBe("text");
    expect(second.coordinate).toEqual([48, 132, 720, 300]);
    expect(audit.markdownText).toContain("block-01");
  });

  it("provides a fallback block when model detects no blocks on a blank sheet", async () => {
    const testImage = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 255, g: 255, b: 255 } }
    }).png().toBuffer();

    vi.mocked(callStructured).mockResolvedValueOnce({
      data: {
        blocks: []
      },
      durationMs: 100,
      outputMode: "json_schema"
    });

    const audit = await detectModelNativeLayout({
      imageBuffer: testImage,
      mimeType: "image/png",
      config: mockConfig,
      operationId: "op-test-blank"
    });

    expect(audit.provider).toBe("model_native");
    expect(audit.layoutBlocks).toHaveLength(1);
    expect(audit.layoutBlocks![0]!).toMatchObject({
      blockId: "block-00",
      label: "text",
      coordinate: [0, 0, 500, 500]
    });
  });
});
