import sharp from "sharp";
import { z } from "zod";
import { applyModelRouteSystemPrompt } from "../shared/modelRouting.js";
import { getBuiltInSystemPrompt } from "../shared/modelPrompts.js";
import type { ModelConfigInput, PaddleOcrAudit, PaddleOcrLayoutBlock } from "../shared/types.js";
import { callStructured } from "./modelClient.js";

export interface DetectModelNativeLayoutInput {
  imageBuffer: Buffer;
  mimeType: string;
  fileName?: string;
  config: ModelConfigInput;
  operationId: string;
}

const rawBlockSchema = z.object({
  blockId: z.string().optional(),
  label: z.enum(["handwriting", "printed", "header", "blank_area", "other"]),
  coordinate: z.array(z.number()).length(4),
  description: z.string().optional().default("")
});

const modelNativeLayoutOutputSchema = z.object({
  blocks: z.array(rawBlockSchema)
});

type ModelNativeLayoutOutput = z.infer<typeof modelNativeLayoutOutputSchema>;

const layoutDetectionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["blocks"],
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "coordinate", "description"],
        properties: {
          blockId: { type: "string" },
          label: {
            type: "string",
            enum: ["handwriting", "printed", "header", "blank_area", "other"]
          },
          coordinate: {
            type: "array",
            items: { type: "number" },
            minItems: 4,
            maxItems: 4
          },
          description: { type: "string" }
        }
      }
    }
  }
};

/**
 * Normalizes raw coordinates to pixel space [x1, y1, x2, y2].
 * Handles both 0..1000 normalized coordinates and raw pixel coordinates.
 */
export function normalizeBlockCoordinates(
  coords: [number, number, number, number],
  imageWidth: number,
  imageHeight: number
): [number, number, number, number] {
  const [c0, c1, c2, c3] = coords;
  const isNormalized = Math.max(...coords) <= 1000;

  let x1: number;
  let y1: number;
  let x2: number;
  let y2: number;

  if (isNormalized) {
    const normMinX = Math.max(0, Math.min(c0, c2));
    const normMinY = Math.max(0, Math.min(c1, c3));
    const normMaxX = Math.min(1000, Math.max(c0, c2));
    const normMaxY = Math.min(1000, Math.max(c1, c3));

    x1 = Math.round((normMinX / 1000) * imageWidth);
    y1 = Math.round((normMinY / 1000) * imageHeight);
    x2 = Math.round((normMaxX / 1000) * imageWidth);
    y2 = Math.round((normMaxY / 1000) * imageHeight);
  } else {
    x1 = Math.round(Math.max(0, Math.min(imageWidth, Math.min(c0, c2))));
    y1 = Math.round(Math.max(0, Math.min(imageHeight, Math.min(c1, c3))));
    x2 = Math.round(Math.max(0, Math.min(imageWidth, Math.max(c0, c2))));
    y2 = Math.round(Math.max(0, Math.min(imageHeight, Math.max(c1, c3))));
  }

  // Ensure minimum 2px dimension for renderable bboxes
  if (x2 <= x1) x2 = Math.min(imageWidth, x1 + 2);
  if (y2 <= y1) y2 = Math.min(imageHeight, y1 + 2);

  return [x1, y1, x2, y2];
}

/**
 * Detects visual layout blocks on a student answer image using the multimodal model directly,
 * bypassing external PaddleOCR completely.
 */
export async function detectModelNativeLayout(
  input: DetectModelNativeLayoutInput
): Promise<PaddleOcrAudit> {
  const metadata = await sharp(input.imageBuffer).metadata();
  const imageWidth = metadata.width || 900;
  const imageHeight = metadata.height || 1200;

  const routeKey = "large_question_layout_detection";
  const basePrompt = getBuiltInSystemPrompt(routeKey, "large");
  const systemPrompt = applyModelRouteSystemPrompt(basePrompt, input.config.modelRoutes?.[routeKey]);

  const startTime = Date.now();
  const { data: rawResult } = await callStructured<ModelNativeLayoutOutput>(input.config, {
    routeKey,
    model: input.config.modelRoutes?.[routeKey]?.model || input.config.visionModel,
    system: systemPrompt,
    prompt: `请查看所附学生答卷整页图（尺寸：宽 ${imageWidth} × 高 ${imageHeight} 像素），进行视觉版面分析。
定位卷面上的所有关键视觉区域：手写作答算式行/推导段落（handwriting）、印刷题干/题图（printed）、卷头信息（header）或留白未作答区域（blank_area）。
请返回矩形边界框 coordinate=[x1, y1, x2, y2]（使用 0–1000 归一化坐标），并按页面阅读顺序从上到下输出。
若学生未作答（白卷），切勿伪造 handwriting 区块，handwriting 列表请保持为空。`,
    images: [
      {
        mimeType: input.mimeType || "image/png",
        base64: input.imageBuffer.toString("base64"),
        label: "[学生答卷整页图（模型原生版面分析）]"
      }
    ],
    schemaName: "student_answer_layout_detection",
    schema: layoutDetectionJsonSchema,
    validate: (value: unknown) => modelNativeLayoutOutputSchema.parse(value),
    operationId: input.operationId
  });

  const durationMs = Date.now() - startTime;
  const blocks = rawResult.blocks ?? [];

  const layoutBlocks: PaddleOcrLayoutBlock[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const rawBlock = blocks[index]!;
    const coordinate = normalizeBlockCoordinates(rawBlock.coordinate as [number, number, number, number], imageWidth, imageHeight);
    const labelMapping: Record<string, string> = {
      handwriting: "text",
      printed: "image",
      header: "header",
      blank_area: "text",
      other: "text"
    };

    layoutBlocks.push({
      blockId: `block-${String(index).padStart(2, "0")}`,
      pageIndex: 0,
      label: labelMapping[rawBlock.label] || "text",
      score: 1.0,
      coordinate,
      polygonPoints: [
        [coordinate[0], coordinate[1]],
        [coordinate[2], coordinate[1]],
        [coordinate[2], coordinate[3]],
        [coordinate[0], coordinate[3]]
      ],
      order: index
    });
  }

  // Ensure there is always at least one usable block for downstream schemas
  if (!layoutBlocks.length) {
    layoutBlocks.push({
      blockId: "block-00",
      pageIndex: 0,
      label: "text",
      score: 1.0,
      coordinate: [0, 0, imageWidth, imageHeight],
      polygonPoints: [
        [0, 0],
        [imageWidth, 0],
        [imageWidth, imageHeight],
        [0, imageHeight]
      ],
      order: 0
    });
  }

  const markdownText = layoutBlocks.map((b, i) => {
    const desc = blocks[i]?.description ? `: ${blocks[i]?.description}` : "";
    return `- **${b.blockId}** (${b.label})${desc}`;
  }).join("\n");

  return {
    provider: "model_native",
    model: input.config.modelRoutes?.[routeKey]?.model || input.config.visionModel,
    jobId: `model-native-${Date.now()}`,
    source: "live",
    rawJsonl: JSON.stringify({ layoutBlocks, blocks }),
    markdownText,
    durationMs,
    imageWidth,
    imageHeight,
    layoutBlocks
  };
}
