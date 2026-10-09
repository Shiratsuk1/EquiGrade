import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { preprocessResponsesAgentImage, preprocessStudentAnswerImage } from "./imagePreprocess.js";

async function createAnswerImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: { r: 245, g: 245, b: 245 }
    }
  })
    .composite([{
      input: Buffer.from(`<svg width="120" height="80"><path d="M 12 26 L 108 26 M 12 52 L 86 52" stroke="black" stroke-width="3" fill="none"/></svg>`)
    }])
    .png()
    .toBuffer();
}

async function createColorImage(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: color
    }
  }).png().toBuffer();
}

describe("student answer image preprocessing", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("treats the legacy dual setting as a single enhanced image", async () => {
    vi.stubEnv("HENGZHUN_STUDENT_IMAGE_PREPROCESSING", "dual");
    const input = await createAnswerImage();
    const result = await preprocessStudentAnswerImage({ imageBuffer: input, mimeType: "image/png" });
    const metadata = await sharp(result.buffer).metadata();

    expect(result.audit).toMatchObject({
      provider: "sharp",
      mode: "enhanced",
      applied: true,
      inputMimeType: "image/png",
      outputMimeType: "image/png",
      inputBytes: input.length,
      geometryPreserved: true,
      width: 120,
      height: 80,
      operations: ["flatten_white_background", "normalize_contrast", "sharpen_1px"]
    });
    expect(result.audit.outputBytes).toBe(result.buffer.length);
    expect(metadata.width).toBe(120);
    expect(metadata.height).toBe(80);
  });

  it("uses the unenhanced input when preprocessing is disabled", async () => {
    vi.stubEnv("HENGZHUN_STUDENT_IMAGE_PREPROCESSING", "off");
    const input = Buffer.from("original-image");
    const result = await preprocessStudentAnswerImage({ imageBuffer: input, mimeType: "image/jpeg" });

    expect(result.buffer).toBe(input);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.audit).toMatchObject({ mode: "off", applied: false, operations: [], geometryPreserved: true });
  });

  it("falls back to the unenhanced input when the image cannot be decoded", async () => {
    vi.stubEnv("HENGZHUN_STUDENT_IMAGE_PREPROCESSING", "enhanced");
    const input = Buffer.from("not-a-real-image");
    const result = await preprocessStudentAnswerImage({ imageBuffer: input, mimeType: "image/png" });

    expect(result.buffer).toBe(input);
    expect(result.audit).toMatchObject({
      mode: "enhanced",
      applied: false,
      outputMimeType: "image/png",
      fallbackReason: "本地增强处理失败，已使用未增强输入作为回退结果"
    });
  });

  it("does not blow out faint scanner fold noise on a near-blank answer sheet into black artifacts", async () => {
    vi.stubEnv("HENGZHUN_STUDENT_IMAGE_PREPROCESSING", "enhanced");
    // Create an image that is 99% white (255) with a tiny 1-pixel title mark (0) and a faint crease (246)
    const raw = Buffer.alloc(100 * 100 * 3, 255);
    // 1 black pixel in corner (simulating title)
    raw[0] = 0; raw[1] = 0; raw[2] = 0;
    // Faint crease across the middle (brightness 246)
    for (let x = 0; x < 100; x++) {
      const idx = (50 * 100 + x) * 3;
      raw[idx] = 246; raw[idx + 1] = 246; raw[idx + 2] = 246;
    }
    const input = await sharp(raw, { raw: { width: 100, height: 100, channels: 3 } }).png().toBuffer();
    const result = await preprocessStudentAnswerImage({ imageBuffer: input, mimeType: "image/png" });
    const processedRaw = await sharp(result.buffer).raw().toBuffer();

    // Check that the crease at y=50 did NOT get clamped to 0 (pitch black)
    const creasePixel = processedRaw[(50 * 100 + 50) * 3]!;
    expect(creasePixel).toBeGreaterThan(200);
  });
});

describe("Responses Agent image preprocessing", () => {
  it("encodes the student page as grayscale WebP q90 without changing geometry", async () => {
    const input = await createColorImage({ r: 220, g: 40, b: 20 });
    const result = await preprocessResponsesAgentImage({ imageBuffer: input, mimeType: "image/png", grayscale: true });
    const metadata = await sharp(result.buffer).metadata();

    expect(result.mimeType).toBe("image/webp");
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(120);
    expect(metadata.height).toBe(80);
    expect(result.audit).toMatchObject({
      inputMimeType: "image/png",
      outputMimeType: "image/webp",
      quality: 90,
      grayscale: true,
      geometryPreserved: true,
      operations: ["flatten_white_background", "grayscale", "normalize_contrast", "sharpen_1px", "webp_q90"]
    });

    const decoded = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info.channels).toBeGreaterThanOrEqual(3);
    for (let offset = 0; offset < decoded.data.length; offset += decoded.info.channels) {
      expect(Math.abs(decoded.data[offset]! - decoded.data[offset + 1]!)).toBeLessThanOrEqual(3);
      expect(Math.abs(decoded.data[offset + 1]! - decoded.data[offset + 2]!)).toBeLessThanOrEqual(3);
    }
  });

  it("keeps question/reference color while still encoding every model image as WebP q90", async () => {
    const input = await createColorImage({ r: 220, g: 40, b: 20 });
    const result = await preprocessResponsesAgentImage({ imageBuffer: input, mimeType: "image/png", grayscale: false });
    const metadata = await sharp(result.buffer).metadata();
    const decoded = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });

    expect(result.mimeType).toBe("image/webp");
    expect(metadata.format).toBe("webp");
    expect(result.audit).toMatchObject({
      quality: 90,
      grayscale: false,
      operations: ["flatten_white_background", "webp_q90"]
    });
    expect(decoded.data[0]).toBeGreaterThan(decoded.data[1]! + 80);
    expect(decoded.data[0]).toBeGreaterThan(decoded.data[2]! + 80);
  });
});
