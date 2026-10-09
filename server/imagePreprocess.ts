import sharp from "sharp";
import { MAX_IMAGE_BYTES } from "../shared/uiConstants.js";
import type {
  ResponsesAgentImageAudit,
  StudentAnswerImagePreprocessAudit,
  StudentAnswerImagePreprocessMode
} from "../shared/types.js";

const PREPROCESS_ENV = "HENGZHUN_STUDENT_IMAGE_PREPROCESSING";
const DEFAULT_MODE: StudentAnswerImagePreprocessMode = "enhanced";

export interface StudentAnswerImagePreparation {
  buffer: Buffer;
  mimeType: string;
  audit: StudentAnswerImagePreprocessAudit;
}

export interface ResponsesAgentImagePreparation {
  buffer: Buffer;
  mimeType: "image/webp";
  audit: ResponsesAgentImageAudit;
}

function configuredMode(): StudentAnswerImagePreprocessMode {
  const value = process.env[PREPROCESS_ENV]?.trim().toLowerCase();
  if (value === "off" || value === "false" || value === "0" || value === "disabled") return "off";
  if (value === "enhanced" || value === "single") return "enhanced";
  // Keep the old values readable for existing deployments, but the model
  // input policy is now single-image: the processed result is the only image
  // sent downstream. "dual"/"both" therefore behave as "enhanced".
  if (value === "dual" || value === "both") return "enhanced";
  return DEFAULT_MODE;
}

function fallbackPreparation(
  imageBuffer: Buffer,
  mimeType: string,
  mode: StudentAnswerImagePreprocessMode,
  fallbackReason?: string
): StudentAnswerImagePreparation {
  return {
    buffer: imageBuffer,
    mimeType,
    audit: {
      provider: "sharp",
      mode,
      applied: false,
      inputMimeType: mimeType,
      outputMimeType: mimeType,
      inputBytes: imageBuffer.length,
      outputBytes: imageBuffer.length,
      geometryPreserved: true,
      operations: [],
      ...(fallbackReason ? { fallbackReason } : {})
    }
  };
}

/**
 * Apply conservative, geometry-preserving enhancement to a student answer image.
 * The input buffer is never modified. The output deliberately avoids crop,
 * rotate, resize, or threshold operations so OCR/model regions remain valid
 * after the processed image becomes the only downstream image.
 */
export async function preprocessStudentAnswerImage(input: {
  imageBuffer: Buffer;
  mimeType: string;
}): Promise<StudentAnswerImagePreparation> {
  const mode = configuredMode();
  const mimeType = input.mimeType || "image/png";
  if (mode === "off") return fallbackPreparation(input.imageBuffer, mimeType, mode);
  if (!input.imageBuffer.length) return fallbackPreparation(input.imageBuffer, mimeType, mode, "输入图片为空");

  try {
    const metadata = await sharp(input.imageBuffer).metadata();
    if (!metadata.width || !metadata.height) {
      return fallbackPreparation(input.imageBuffer, mimeType, mode, "无法读取图片尺寸");
    }

    const stats = await sharp(input.imageBuffer).stats();
    const darkestPixel = Math.min(...stats.channels.map((channel) => channel.min));
    const shouldNormalize = darkestPixel <= 160;

    const operations = [
      "flatten_white_background",
      "normalize_contrast",
      "sharpen_1px"
    ];
    let builder = sharp(input.imageBuffer)
      .flatten({ background: { r: 255, g: 255, b: 255 } });
    if (shouldNormalize) {
      builder = builder.normalize({ lower: 0, upper: 100 });
    }
    builder = builder.sharpen({ sigma: 1 });
    let outputBuffer = await builder
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    let outputMimeType = "image/png";

    // Scanned pages can contain substantial background noise. Keep the enhanced
    // image below the shared safety ceiling without changing its geometry.
    if (outputBuffer.length > MAX_IMAGE_BYTES) {
      let fallbackBuilder = sharp(input.imageBuffer)
        .flatten({ background: { r: 255, g: 255, b: 255 } });
      if (shouldNormalize) {
        fallbackBuilder = fallbackBuilder.normalize({ lower: 0, upper: 100 });
      }
      fallbackBuilder = fallbackBuilder.sharpen({ sigma: 1 });
      outputBuffer = await fallbackBuilder
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
      outputMimeType = "image/jpeg";
      operations.push("jpeg_size_fallback");
    }

    if (outputBuffer.length > MAX_IMAGE_BYTES) {
      return fallbackPreparation(input.imageBuffer, mimeType, mode, "增强图片超过 25 MB 安全上限");
    }

    return {
      buffer: outputBuffer,
      mimeType: outputMimeType,
      audit: {
        provider: "sharp",
        mode,
        applied: true,
        inputMimeType: mimeType,
        outputMimeType,
        inputBytes: input.imageBuffer.length,
        outputBytes: outputBuffer.length,
        width: metadata.width,
        height: metadata.height,
        geometryPreserved: true,
        operations
      }
    };
  } catch {
    // Enhancement is an auxiliary aid. A malformed/unsupported image is passed
    // through as the single downstream image so the existing validation path
    // still reports the real input problem.
    return fallbackPreparation(input.imageBuffer, mimeType, mode, "本地增强处理失败，已使用未增强输入作为回退结果");
  }
}

/**
 * Prepare an image for the Responses Agent path only.  The stable staged and
 * small-question pipelines intentionally continue to use the function above.
 * Every successful Agent input is WebP quality 90; answer pages are enhanced
 * in grayscale while question/reference material preserves its color.
 */
export async function preprocessResponsesAgentImage(input: {
  imageBuffer: Buffer;
  mimeType: string;
  grayscale: boolean;
}): Promise<ResponsesAgentImagePreparation> {
  if (!input.imageBuffer.length) throw new Error("Responses Agent 输入图片为空");
  const metadata = await sharp(input.imageBuffer).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Responses Agent 无法读取图片尺寸");
  const operations = ["flatten_white_background"];
  let pipeline = sharp(input.imageBuffer).flatten({ background: { r: 255, g: 255, b: 255 } });
  if (input.grayscale) {
    const stats = await sharp(input.imageBuffer).stats();
    const darkestPixel = Math.min(...stats.channels.map((channel) => channel.min));
    pipeline = pipeline.grayscale();
    if (darkestPixel <= 160) {
      pipeline = pipeline.normalize({ lower: 0, upper: 100 });
    }
    pipeline = pipeline.sharpen({ sigma: 1 });
    operations.push("grayscale", "normalize_contrast", "sharpen_1px");
  }
  operations.push("webp_q90");
  const outputBuffer = await pipeline.webp({ quality: 90 }).toBuffer();
  if (outputBuffer.length > MAX_IMAGE_BYTES) {
    throw new Error("Responses Agent WebP 图片超过 25 MB 安全上限");
  }
  return {
    buffer: outputBuffer,
    mimeType: "image/webp",
    audit: {
      inputMimeType: input.mimeType || "application/octet-stream",
      outputMimeType: "image/webp",
      inputBytes: input.imageBuffer.length,
      outputBytes: outputBuffer.length,
      width: metadata.width,
      height: metadata.height,
      quality: 90,
      grayscale: input.grayscale,
      geometryPreserved: true,
      operations
    }
  };
}
