import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { callStructured } from "../server/modelClient.js";
import { readModelConfig } from "../server/configStore.js";
import { runPaddleOcr } from "../server/paddleOcr.js";
import {
  studentAnswerReconstructionJsonSchema,
  studentAnswerReconstructionSchema
} from "../server/schemas.js";

const defaultImagePath = "C:/Users/YUZUKI~1/AppData/Local/Temp/codex-clipboard-7a51fdf0-6808-4235-b300-a2f182702ade.png";

const reconstructionSystem = `你是高中物理手写答卷的忠实还原器。你的唯一任务是记录学生在图片中实际写出的内容，不是解题、评分、纠错或整理标准答案。

必须遵守：
1. 逐行覆盖图片中所有答题痕迹，包括页面上部、下部、边缘和反复推导的内容。
2. 只把清晰、未划掉、可确认属于学生当前作答的内容标记为 active；划掉内容标记为 crossed_out。
3. 任何数字、正负号、字母、上下标、平方、分式、单位或箭头无法可靠辨认时，保留原位置，标记为 uncertain，并在 alternatives 中写出你实际考虑到的开放式候选；候选不能局限于预设列表。
4. 不根据物理常识、题目答案或公式习惯补写图片中没有出现的内容；不能把模糊的 3/5、1/7、正负号等擅自改成你认为正确的值。
5. 不要把相邻多行合并到无法追溯；每行使用稳定的 line-1、line-2 等 ID，并尽量给出原图像素坐标 [x,y,width,height]。
6. 输出的 text 和 latex 必须优先反映视觉读取结果；如果只能确认部分字符，也要保留部分结果并降低 confidence。
7. latex 字段必须是可由 KaTeX 解析的完整公式；任何上下标、撇号、分式或符号无法确认时，latex 留空，把原始可见片段放入 text 和 alternatives，绝对不要生成 v_?^' 之类的非法占位公式。
8. 只返回符合 JSON Schema 的对象，不要输出 Markdown 或额外说明。`;

const rubricAwareGuard = `
下面提供的评分标准仅用于标记“哪些模糊内容可能影响分数”和安排复核优先级，不得用它改写、补齐或替换学生实际写法。必须额外遵守：
- 标准答案不是学生答案；即使图片中的写法与标准答案接近，也必须以图像证据为准。
- 仅凭评分标准推断出的内容不得写入 text 或 latex；只能放入 alternatives/ambiguities，并标明是上下文提示。
- 如果图像读数与评分标准冲突，保留图像读数，增加 scoreImpact 为 possible 或 certain 的 ambiguity，并将 status 设为 review。
- 不要遗漏与标准答案无关的学生草稿、划除内容或中间推导。`;

type RunResult = {
  label: string;
  durationMs: number;
  outputMode: string;
  data: ReturnType<typeof studentAnswerReconstructionSchema.parse>;
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function run(
  config: NonNullable<Awaited<ReturnType<typeof readModelConfig>>>,
  label: string,
  imageBase64: string,
  ocrMarkdown: string,
  rubricText: string,
  withRubric: boolean
): Promise<RunResult> {
  const response = await callStructured<unknown>({
    ...config,
    maxRetries: 1
  }, {
    model: config.visionModel,
    system: `${reconstructionSystem}${withRubric ? rubricAwareGuard : ""}`,
    prompt: withRubric
      ? `请还原这张学生答卷图片。评分标准仅作高影响模糊点复核提示，不能当作学生答案。下面的 PaddleOCR 内容只是辅助识别，原图优先：\n\nPaddleOCR Markdown：\n${ocrMarkdown}\n\n评分标准：\n${rubricText}`
      : `请还原这张学生答卷图片。当前没有提供题干、参考答案或评分标准，请完全按照图片实际字迹进行忠实转录。下面的 PaddleOCR 内容只是辅助识别，原图优先：\n\nPaddleOCR Markdown：\n${ocrMarkdown}`,
    images: [{
      mimeType: "image/png",
      base64: imageBase64,
      label: "[学生答卷原图]"
    }],
    schemaName: `student_answer_reconstruction_${label}`,
    schema: studentAnswerReconstructionJsonSchema,
    validate: (value) => studentAnswerReconstructionSchema.parse(value)
  });
  return {
    label,
    durationMs: response.durationMs,
    outputMode: response.outputMode,
    data: studentAnswerReconstructionSchema.parse(response.data)
  };
}

const imagePath = process.argv[2] || defaultImagePath;
const rubricText = await readStdin();
if (!rubricText) {
  throw new Error("请通过 stdin 传入评分标准文本");
}

const config = await readModelConfig();
if (!config?.enabled || !config.apiKey) {
  throw new Error("当前没有可用的已启用模型配置");
}
const imageBuffer = await readFile(imagePath);
const imageBase64 = imageBuffer.toString("base64");
const ocr = await runPaddleOcr({
  imageBuffer,
  mimeType: "image/png",
  fileName: path.basename(imagePath)
});
const withoutRubric = await run(config, "without_rubric", imageBase64, ocr.markdownText, rubricText, false);
const withRubric = await run(config, "with_rubric", imageBase64, ocr.markdownText, rubricText, true);

const fullResult = {
  imagePath,
  imageBytes: imageBuffer.length,
  model: config.visionModel,
  ocr: {
    provider: ocr.provider,
    model: ocr.model,
    jobId: ocr.jobId,
    rawJsonl: ocr.rawJsonl,
    markdownText: ocr.markdownText,
    durationMs: ocr.durationMs
  },
  withRubricInputCharacters: rubricText.length,
  runs: [withoutRubric, withRubric]
};
const outputPath = path.resolve(process.env.RECONSTRUCTION_AB_OUTPUT?.trim() || ".data/reconstruction-rubric-ab-result.json");
await writeFile(outputPath, JSON.stringify(fullResult, null, 2), "utf8");
console.log(JSON.stringify({
  ...fullResult,
  ocr: {
    provider: ocr.provider,
    model: ocr.model,
    jobId: ocr.jobId,
    rawJsonlBytes: Buffer.byteLength(ocr.rawJsonl, "utf8"),
    markdownText: ocr.markdownText,
    durationMs: ocr.durationMs
  },
  fullResultPath: outputPath
}, null, 2));
