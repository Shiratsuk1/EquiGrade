import sharp from "sharp";
import { z } from "zod";
import type {
  AnswerEvidence,
  AnswerPresence,
  FinalAnswerJudgement,
  FinalAnswerRule,
  FinalAnswerStatus,
  GradingResult,
  ModelConfigInput,
  Rubric,
  SmallQuestionAudit,
  SmallQuestionBlankCropAudit,
  SmallQuestionBlankRecognitionAudit,
  SubquestionResult
} from "../shared/types.js";
import { getBuiltInSystemPrompt } from "../shared/modelPrompts.js";
import { callStructured } from "./modelClient.js";
import { resolveModelRoute } from "./modelRouting.js";
import { comparePhysicsAnswer } from "./physicsAnswerEquivalence.js";
import { calculateGrade, createFallbackTeacherCommentary, normalizeEvidenceReferences } from "./gradingEngine.js";
import type { GradingArtifactSource } from "./gradingArtifactStore.js";
import type { StudentAnswerImagePreparation } from "./imagePreprocess.js";
import {
  completeOperation,
  logProgress,
  throwIfOperationCancelled
} from "./systemLog.js";

export interface SmallQuestionGradingImage {
  mimeType: string;
  base64: string;
  label?: string;
}

export interface SmallQuestionPreparedStudentAnswer {
  preparation: StudentAnswerImagePreparation;
  studentImage: SmallQuestionGradingImage;
  modelImages: SmallQuestionGradingImage[];
}

export interface SmallQuestionGradingInput {
  id: string;
  studentId: string;
  fileName: string;
  mimeType: string;
  imageBuffer: Buffer;
  rubric: Rubric;
  questionText?: string;
  referenceText?: string;
  questionImages?: SmallQuestionGradingImage[];
  referenceImages?: SmallQuestionGradingImage[];
  previousResultId?: string;
  regradedAt?: string;
  regradeReason?: string;
}

// 1. 各空定位 Schema
export const smallQuestionBlankLayoutSchema = z.object({
  blanks: z.array(z.object({
    subquestionId: z.string(),
    coordinate: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
    hasAnswer: z.boolean(),
    description: z.string().optional()
  }))
});

export const smallQuestionBlankLayoutJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["blanks"],
  properties: {
    blanks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "coordinate", "hasAnswer"],
        properties: {
          subquestionId: { type: "string" },
          coordinate: {
            type: ["array", "null"],
            items: { type: "number" },
            minItems: 4,
            maxItems: 4
          },
          hasAnswer: { type: "boolean" },
          description: { type: "string" }
        }
      }
    }
  }
};

// 2. 盲审转录员 Schema (请求 A，不提供参考答案)
export const smallQuestionBlindTranscriberSchema = z.object({
  extractedAnswer: z.string().default(""),
  confidence: z.number().min(0).max(1),
  visualNotes: z.string().optional().default("")
});

export const smallQuestionBlindTranscriberJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["extractedAnswer", "confidence"],
  properties: {
    extractedAnswer: { type: "string", description: "切片中实际可见的手写作答字符、数字或符号" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    visualNotes: { type: "string", description: "笔画闭合、涂改痕迹或微观特征记录" }
  }
};

// 3. 挑刺审查员 Schema (请求 B，对照参考答案严查漏洞)
export const smallQuestionSkepticAssessorSchema = z.object({
  extractedAnswer: z.string().default(""),
  status: z.enum(["correct", "incorrect", "uncertain", "missing"]),
  confidence: z.number().min(0).max(1),
  issues: z.array(z.string()).default([]),
  reason: z.string().default("")
});

export const smallQuestionSkepticAssessorJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["extractedAnswer", "status", "confidence", "issues", "reason"],
  properties: {
    extractedAnswer: { type: "string", description: "手写答案内容" },
    status: { type: "string", enum: ["correct", "incorrect", "uncertain", "missing"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    issues: { type: "array", items: { type: "string" }, description: "发现的潜在瑕疵、有效数字问题或涂改点" },
    reason: { type: "string", description: "判定依据" }
  }
};

// 4. 高思考预算深度复检 Schema (请求 C，拉满推理预算)
export const smallQuestionEscalatedReviewSchema = z.object({
  finalExtractedAnswer: z.string().default(""),
  status: z.enum(["correct", "incorrect", "uncertain", "missing"]),
  confidence: z.number().min(0).max(1),
  visualAnalysis: z.string().default(""),
  resolutionReason: z.string().default("")
});

export const smallQuestionEscalatedReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["finalExtractedAnswer", "status", "confidence", "visualAnalysis", "resolutionReason"],
  properties: {
    finalExtractedAnswer: { type: "string", description: "深度视觉审阅后确切的学生手写答案" },
    status: { type: "string", enum: ["correct", "incorrect", "uncertain", "missing"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    visualAnalysis: { type: "string", description: "对笔画、连笔、涂改、正负号的微观视觉分析" },
    resolutionReason: { type: "string", description: "终审裁决理由" }
  }
};

interface BlankCropInternal {
  subquestionId: string;
  title: string;
  finalAnswers: readonly FinalAnswerRule[];
  criteriaGuidance?: string;
  cropBuffer: Buffer;
  cropBase64: string;
  cropWidth: number;
  cropHeight: number;
  coordinate: [number, number, number, number] | null;
  hasAnswer: boolean;
  artifactFileName?: string;
}

/**
 * 格式化参考答案文本表达供提示词使用
 */
function formatFinalAnswers(rules: readonly FinalAnswerRule[] | undefined): string {
  if (!rules || !rules.length) return "无明确参考答案";
  return rules.map((r) => r.expression).filter(Boolean).join(" 或 ");
}

/**
 * 字符串预处理（去除空格、归一化物理负号和常规乘号）
 */
function normalizeAnswerString(str: string): string {
  return str.trim()
    .replace(/[−﹣－]/g, "-")
    .replace(/[×✕]/g, "*")
    .replace(/\s+/g, "");
}

/**
 * 小题免 OCR 独立批改链路：
 * 原生视觉定位各空 -> Sharp 高清切片 -> 盲审A/挑刺B 双路并发 -> 本地硬规则防御 -> 按需拉满思考复检C -> 本地权威计分
 */
export async function gradeSmallQuestionStaged(
  config: ModelConfigInput,
  input: SmallQuestionGradingInput,
  operationId: string,
  preparedStudentAnswer: SmallQuestionPreparedStudentAnswer,
  artifactSource?: GradingArtifactSource
): Promise<GradingResult> {
  const studentImage = preparedStudentAnswer.preparation;
  const layoutRoute = resolveModelRoute(config, "small_question_blank_layout");
  const blindRoute = resolveModelRoute(config, "small_question_blind_transcription");
  const skepticRoute = resolveModelRoute(config, "small_question_skeptic_assessment");
  let reviewRoute: ReturnType<typeof resolveModelRoute>;
  try {
    reviewRoute = resolveModelRoute(config, "small_question_escalated_review");
  } catch {
    reviewRoute = skepticRoute;
  }

  logProgress(operationId, "grading", "small_question_layout_started", "小题链路正在调用原生视觉模型定位各空手写作答区域（已彻底绕过 PaddleOCR）", {
    model: layoutRoute.model,
    routeKey: layoutRoute.routeKey,
    subquestions: input.rubric.subquestions.length
  });

  // ----------------------------------------------------
  // 阶段 1：原生视觉分空定位
  // ----------------------------------------------------
  const subquestionsList = input.rubric.subquestions.map((sq: Rubric["subquestions"][number]) => `- ${sq.id} (${sq.title})`).join("\n");
  const layoutStart = performance.now();
  const layoutResponse = await callStructured(layoutRoute.config, {
    model: layoutRoute.model,
    routeKey: layoutRoute.routeKey,
    system: getBuiltInSystemPrompt(layoutRoute.routeKey),
    prompt: `请识别这份物理小题答卷中每个空的手写作答区域位置。
必须覆盖的空位列表：
${subquestionsList}

题目文字（参考）：${input.questionText?.trim() || "见题图"}

关键要求：
1. 每个空必须返回 coordinate: [x1, y1, x2, y2]（0..1000 归一化手写边界框，x1左，y1上，x2右，y2下），仅紧密框选手写作答内容；
2. 若某空明确未作答（空白或仅有试卷印刷横线），coordinate 必须返回 null，且 hasAnswer 设为 false。`,
    images: preparedStudentAnswer.modelImages,
    schemaName: "small_question_blank_layout",
    schema: smallQuestionBlankLayoutJsonSchema,
    validate: (val) => smallQuestionBlankLayoutSchema.parse(val),
    reasoningEffort: layoutRoute.reasoningEffort,
    operationId
  });
  throwIfOperationCancelled(operationId);
  const layoutDurationMs = Math.round(performance.now() - layoutStart);
  const layout = smallQuestionBlankLayoutSchema.parse(layoutResponse.data);

  let imageWidth = 0;
  let imageHeight = 0;
  try {
    const meta = await sharp(studentImage.buffer).metadata();
    imageWidth = meta.width ?? 0;
    imageHeight = meta.height ?? 0;
  } catch {
    // metadata fallback
  }

  // ----------------------------------------------------
  // 阶段 2：Sharp 局部高清大图裁切
  // ----------------------------------------------------
  const crops: BlankCropInternal[] = [];
  const cropAudits: SmallQuestionBlankCropAudit[] = [];

  for (const sq of input.rubric.subquestions) {
    const blank = layout.blanks.find((b) => b.subquestionId === sq.id);
    const finalAnswers = sq.finalAnswers ?? [];
    if (!blank || !blank.coordinate || !blank.hasAnswer || !imageWidth || !imageHeight) {
      crops.push({
        subquestionId: sq.id,
        title: sq.title,
        finalAnswers,
        cropBuffer: Buffer.alloc(0),
        cropBase64: "",
        cropWidth: 0,
        cropHeight: 0,
        coordinate: blank?.coordinate ?? null,
        hasAnswer: Boolean(blank?.hasAnswer)
      });
      cropAudits.push({
        subquestionId: sq.id,
        title: sq.title,
        coordinate: blank?.coordinate ?? null,
        hasAnswer: Boolean(blank?.hasAnswer)
      });
      continue;
    }

    const [nx1, ny1, nx2, ny2] = blank.coordinate;
    const padX = 24;
    const padY = 16;
    const left = Math.max(0, Math.floor((Math.min(nx1, nx2) / 1000) * imageWidth - padX));
    const top = Math.max(0, Math.floor((Math.min(ny1, ny2) / 1000) * imageHeight - padY));
    const right = Math.min(imageWidth, Math.ceil((Math.max(nx1, nx2) / 1000) * imageWidth + padX));
    const bottom = Math.min(imageHeight, Math.ceil((Math.max(ny1, ny2) / 1000) * imageHeight + padY));
    const width = Math.max(10, right - left);
    const height = Math.max(10, bottom - top);

    let cropBuffer: Buffer;
    try {
      cropBuffer = await sharp(studentImage.buffer)
        .extract({ left, top, width, height })
        .webp({ quality: 95 })
        .toBuffer();
    } catch {
      cropBuffer = studentImage.buffer;
    }

    const fileName = `small-blank-${sq.id}-crop.webp`;
    const criteriaGuidance = sq.scorePoints
      .map((p) => [p.title, p.description, p.expected].filter(Boolean).join("："))
      .filter(Boolean)
      .join("；");
    crops.push({
      subquestionId: sq.id,
      title: sq.title,
      finalAnswers,
      criteriaGuidance,
      cropBuffer,
      cropBase64: cropBuffer.length ? cropBuffer.toString("base64") : "",
      cropWidth: width,
      cropHeight: height,
      coordinate: blank.coordinate,
      hasAnswer: true,
      artifactFileName: fileName
    });
    cropAudits.push({
      subquestionId: sq.id,
      title: sq.title,
      coordinate: blank.coordinate,
      hasAnswer: true,
      artifactFileName: fileName,
      cropWidth: width,
      cropHeight: height
    });

    if (artifactSource && cropBuffer.length) {
      artifactSource.subquestionCrops = artifactSource.subquestionCrops ?? [];
      artifactSource.subquestionCrops.push({
        fileName,
        mimeType: "image/webp",
        category: "agent_region",
        buffer: cropBuffer
      });
    }
  }

  logProgress(operationId, "grading", "small_question_crops_ready", `小题各空高清切片已生成（${crops.filter((c) => c.hasAnswer).length}/${input.rubric.subquestions.length}）`, {
    totalSubquestions: input.rubric.subquestions.length,
    activeCrops: crops.filter((c) => c.hasAnswer).length,
    durationMs: layoutDurationMs
  });

  // ----------------------------------------------------
  // 阶段 3 & 4：正交双路并发识别 (盲审 A + 挑刺 B) 与按需深度复检 C
  // ----------------------------------------------------
  const dualStart = performance.now();
  let escalatedReviewTotalDurationMs = 0;
  const recognitionAudits: SmallQuestionBlankRecognitionAudit[] = [];
  const finalJudgements: FinalAnswerJudgement[] = [];

  for (const crop of crops) {
    throwIfOperationCancelled(operationId);

    // 判空快速短路
    if (!crop.hasAnswer) {
      finalJudgements.push({
        subquestionId: crop.subquestionId,
        status: "missing",
        answerPresence: "no_effective_answer",
        evidenceLineIds: [],
        studentAnswer: "",
        referenceAnswer: formatFinalAnswers(crop.finalAnswers),
        reason: "该空经原生版面定位确认未作答，未检测到任何有效手写笔迹",
        confidence: 1,
        decisionSource: "teacher_model"
      });
      recognitionAudits.push({
        subquestionId: crop.subquestionId,
        blindTranscriber: { extractedAnswer: "", confidence: 1 },
        skepticAssessor: { extractedAnswer: "", status: "missing", confidence: 1, issues: [], reason: "未作答" },
        comparisonStatus: "consensus",
        finalStatus: "missing",
        finalAnswer: "",
        finalConfidence: 1,
        decisionSource: "blank_missing"
      });
      continue;
    }

    const imagePayload = [{
      mimeType: "image/webp",
      base64: crop.cropBase64
    }];

    // 盲审 A：严禁给出参考答案
    const promptBlind = `请客观像素级识别该切片中学生实际写出的答案。
对应小题：${crop.title}

要求：
1. 仔细观察手写笔迹，严格照实输出字符、数字或公式；
2. 严禁主观猜测，严禁根据外部经验纠正或补写学生笔迹；
3. 给出识别出的完整手写作答与置信度。`;

    // 挑刺 B：对照参考答案与评分要求严查
    const promptSkeptic = `请严加挑刺审查该切片中学生手写作答与参考答案及评分要求。
对应小题：${crop.title}
参考答案（满足任一即为正确）：${formatFinalAnswers(crop.finalAnswers)}
${crop.criteriaGuidance ? `评分规则与特殊要求：${crop.criteriaGuidance}\n` : ""}
要求：
1. 重点查找潜在错误：有效数字位数是否不足或多出？正负号/上下标是否混淆？是否有涂改未清？是否违反上述评分规则？
2. 只有在完全没有任何漏洞且完全符合参考答案与评分要求时，status 才能为 correct；
3. 发现任何瑕疵在 issues 中明确列出。`;

    // 并发发起双路请求 A 和 B
    const [responseA, responseB] = await Promise.all([
      callStructured(blindRoute.config, {
        model: blindRoute.model,
        routeKey: blindRoute.routeKey,
        system: getBuiltInSystemPrompt(blindRoute.routeKey),
        prompt: promptBlind,
        images: imagePayload,
        schemaName: "small_question_blind_transcriber",
        schema: smallQuestionBlindTranscriberJsonSchema,
        validate: (val) => smallQuestionBlindTranscriberSchema.parse(val),
        reasoningEffort: blindRoute.reasoningEffort,
        operationId
      }),
      callStructured(skepticRoute.config, {
        model: skepticRoute.model,
        routeKey: skepticRoute.routeKey,
        system: getBuiltInSystemPrompt(skepticRoute.routeKey),
        prompt: promptSkeptic,
        images: imagePayload,
        schemaName: "small_question_skeptic_assessor",
        schema: smallQuestionSkepticAssessorJsonSchema,
        validate: (val) => smallQuestionSkepticAssessorSchema.parse(val),
        reasoningEffort: skepticRoute.reasoningEffort,
        operationId
      })
    ]);
    throwIfOperationCancelled(operationId);

    const resA = smallQuestionBlindTranscriberSchema.parse(responseA.data);
    const resB = smallQuestionSkepticAssessorSchema.parse(responseB.data);

    // ----------------------------------------------------
    // 本地比对与一致性校验（本地不推翻模型打分，仅做比对与验证）
    // ----------------------------------------------------
    let isConsistent = false;
    let localComparisonReason = "";

    const cleanA = normalizeAnswerString(resA.extractedAnswer);
    const cleanB = normalizeAnswerString(resB.extractedAnswer);

    // 规则 1：盲审提取与挑刺提取是否一致？
    if (cleanA && cleanB) {
      if (cleanA === cleanB) {
        isConsistent = true;
      } else {
        // 利用物理等价对比识别字符是否一致（如分数小数形式）
        const equiv = comparePhysicsAnswer(resA.extractedAnswer, [{ expression: resB.extractedAnswer }]);
        if (equiv.status === "equivalent") {
          isConsistent = true;
        } else {
          isConsistent = false;
          localComparisonReason = `盲审转录(${resA.extractedAnswer})与挑刺审查(${resB.extractedAnswer})字符不一致`;
        }
      }
    } else {
      isConsistent = false;
      localComparisonReason = "至少一路未提取出有效作答字符";
    }

    // 规则 2：若挑刺模型认为不正确或存疑，本地不擅自推翻模型打分，进入深度终审 C 裁决
    if (isConsistent) {
      if (resB.status !== "correct") {
        isConsistent = false;
        localComparisonReason = `挑刺审查员判定状态为 ${resB.status}，存在质疑: ${resB.reason}`;
      } else if (resB.issues.length > 0 && resB.confidence < 0.92) {
        isConsistent = false;
        localComparisonReason = `挑刺审查员指出潜在疑点: ${resB.issues.join("; ")}`;
      }
    }

    // 分歧处理与深度终审 C
    if (!isConsistent) {
      logProgress(operationId, "grading", "small_question_discrepancy_detected", `${crop.title}初检出现分歧或疑点，正在调起思考预算拉满的深度终审模型`, {
        subquestionId: crop.subquestionId,
        extractedA: resA.extractedAnswer,
        extractedB: resB.extractedAnswer,
        statusB: resB.status,
        issuesB: resB.issues,
        triggerReason: localComparisonReason
      }, "warning");

      const cStart = performance.now();
      const responseC = await callStructured(reviewRoute.config, {
        model: reviewRoute.model,
        routeKey: reviewRoute.routeKey,
        system: getBuiltInSystemPrompt(reviewRoute.routeKey),
        prompt: `请对该切片手写作答进行拉满思考预算的终审裁决。
对应小题：${crop.title}
参考答案（满足任一即为正确）：${formatFinalAnswers(crop.finalAnswers)}
${crop.criteriaGuidance ? `评分规则与特殊要求：${crop.criteriaGuidance}\n` : ""}
两路初检结论出现分歧或疑点：
- 盲审转录（不知参考答案）识别为: "${resA.extractedAnswer}" (置信度: ${resA.confidence})
- 挑刺审查（已知参考答案）识别为: "${resB.extractedAnswer}" (判定: ${resB.status}, 置信度: ${resB.confidence}, 疑点: ${resB.issues.join("; ") || "无"})
- 拦截原因: ${localComparisonReason}

请展开完整的微观视觉反思链，逐笔分析笔迹闭合、有效数字、涂改或正负号，严格根据参考答案及评分规则做出权威终审判定。`,
        images: imagePayload,
        schemaName: "small_question_escalated_review",
        schema: smallQuestionEscalatedReviewJsonSchema,
        validate: (val) => smallQuestionEscalatedReviewSchema.parse(val),
        reasoningEffort: "high",
        operationId
      });
      throwIfOperationCancelled(operationId);
      const cDuration = Math.round(performance.now() - cStart);
      escalatedReviewTotalDurationMs += cDuration;

      const resC = smallQuestionEscalatedReviewSchema.parse(responseC.data);

      // 严格尊重终审模型的判定，本地不做推翻，只做总分累加与安全验证
      const finalConfirmedStatus: FinalAnswerStatus = resC.status;

      recognitionAudits.push({
        subquestionId: crop.subquestionId,
        blindTranscriber: { extractedAnswer: resA.extractedAnswer, confidence: resA.confidence },
        skepticAssessor: { extractedAnswer: resB.extractedAnswer, status: resB.status, confidence: resB.confidence, issues: resB.issues, reason: resB.reason },
        comparisonStatus: "discrepancy",
        escalatedReview: {
          finalExtractedAnswer: resC.finalExtractedAnswer,
          status: resC.status,
          confidence: resC.confidence,
          visualAnalysis: resC.visualAnalysis,
          resolutionReason: resC.resolutionReason
        },
        finalStatus: finalConfirmedStatus,
        finalAnswer: resC.finalExtractedAnswer,
        finalConfidence: resC.confidence,
        decisionSource: "escalated_review_c"
      });

      const presence: AnswerPresence = finalConfirmedStatus === "missing" ? "no_effective_answer" : "confirmed_answer";
      finalJudgements.push({
        subquestionId: crop.subquestionId,
        status: finalConfirmedStatus,
        answerPresence: presence,
        evidenceLineIds: [],
        studentAnswer: resC.finalExtractedAnswer,
        referenceAnswer: formatFinalAnswers(crop.finalAnswers),
        reason: `终审裁决(${resC.resolutionReason})`,
        confidence: resC.confidence,
        decisionSource: "visual_local_review"
      });
    } else {
      // 双路完全一致放行
      recognitionAudits.push({
        subquestionId: crop.subquestionId,
        blindTranscriber: { extractedAnswer: resA.extractedAnswer, confidence: resA.confidence },
        skepticAssessor: { extractedAnswer: resB.extractedAnswer, status: resB.status, confidence: resB.confidence, issues: resB.issues, reason: resB.reason },
        comparisonStatus: "consensus",
        finalStatus: "correct",
        finalAnswer: resB.extractedAnswer,
        finalConfidence: Math.max(resA.confidence, resB.confidence),
        decisionSource: "consensus_ab"
      });

      finalJudgements.push({
        subquestionId: crop.subquestionId,
        status: "correct",
        answerPresence: "confirmed_answer",
        evidenceLineIds: [],
        studentAnswer: resB.extractedAnswer,
        referenceAnswer: formatFinalAnswers(crop.finalAnswers),
        reason: `正交双路一致采信: 盲审与挑刺均认定为正确作答(${resB.extractedAnswer})`,
        confidence: Math.max(resA.confidence, resB.confidence),
        decisionSource: "teacher_model"
      });
    }
  }

  const dualRecognitionDurationMs = Math.round(performance.now() - dualStart);

  // ----------------------------------------------------
  // 阶段 5：本地权威计分与结构化评语生成
  // ----------------------------------------------------
  // 为小题生成各小问决策列表（最终答案 correct 无条件满分）
  const decisions = input.rubric.subquestions.flatMap((sq: Rubric["subquestions"][number]) => {
    const judgement = finalJudgements.find((j) => j.subquestionId === sq.id);
    const isCorrect = judgement?.status === "correct";
    return sq.scorePoints.map((point: Rubric["subquestions"][number]["scorePoints"][number]) => ({
      subquestionId: sq.id,
      pointId: point.id,
      status: isCorrect ? ("satisfied" as const) : ("not_satisfied" as const),
      evidenceLineIds: [],
      evidenceQuote: judgement?.studentAnswer ?? "",
      reason: judgement?.reason ?? "小题直接判定",
      confidence: judgement?.confidence ?? 1,
      requiresReview: judgement?.status === "uncertain"
    }));
  });

  const dummyEvidence: AnswerEvidence = normalizeEvidenceReferences({
    lines: [],
    finalAnswers: [],
    ambiguities: []
  });

  const result = calculateGrade({
    id: input.id,
    studentId: input.studentId,
    fileName: input.fileName,
    rubric: input.rubric,
    evidence: dummyEvidence,
    finalAnswerJudgements: finalJudgements,
    decisions,
    appliedDeductions: [],
    modelName: layoutRoute.model,
    gradingMode: "vision_direct",
    durationMs: layoutDurationMs + dualRecognitionDurationMs + escalatedReviewTotalDurationMs,
    unreadableReviewThreshold: config.unreadableReviewThreshold,
    operationId,
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason
  });

  result.gradingPipeline = "small_question_staged";
  result.imagePreprocessAudit = preparedStudentAnswer.preparation.audit;
  const smallQuestionAudit: SmallQuestionAudit = {
    pipeline: "staged_vision_crops",
    layoutDurationMs,
    dualRecognitionDurationMs,
    escalatedReviewDurationMs: escalatedReviewTotalDurationMs,
    crops: cropAudits,
    recognitions: recognitionAudits
  };
  result.smallQuestionAudit = smallQuestionAudit;

  for (const rec of recognitionAudits) {
    if (rec.escalatedReview && rec.finalStatus === "uncertain") {
      if (rec.escalatedReview.resolutionReason) {
        result.reviewReasons.push(rec.escalatedReview.resolutionReason);
      }
    }
  }

  // 检查是否全对快速通道
  const allCorrect = input.rubric.subquestions.length > 0 &&
    finalJudgements.length === input.rubric.subquestions.length &&
    finalJudgements.every((j) => j.status === "correct");

  if (allCorrect) {
    logProgress(operationId, "grading", "small_question_all_correct_fast_path", `全卷各空均判定正确，成功触发小题满分快速通道（${result.score}/${result.maxScore}分）`, {
      score: result.score,
      maxScore: result.maxScore,
      cropsCount: crops.length
    }, "success");
  }

  // 生成本地结构化教师评语
  result.teacherCommentary = createFallbackTeacherCommentary(result);

  completeOperation(operationId, "grading", "grading_completed", `${input.studentId}小题分阶段批改完成：${result.score}/${result.maxScore}分`, {
    status: result.status,
    gradingPipeline: "small_question_staged",
    reviewReasons: result.reviewReasons.length,
    cropsCount: crops.length,
    scoreResolved: result.scoreResolved
  });

  return result;
}
