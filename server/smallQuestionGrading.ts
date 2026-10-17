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

// 1. 各空初检与定位 Schema
export const smallQuestionBlankLayoutSchema = z.object({
  isEntirelyBlank: z.boolean().default(false),
  blanks: z.array(z.object({
    subquestionId: z.string(),
    coordinate: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
    hasAnswer: z.boolean(),
    extractedAnswer: z.string().default(""),
    status: z.enum(["correct", "incorrect", "uncertain", "missing"]).default("uncertain"),
    confidence: z.number().min(0).max(1).default(0.5),
    riskPoints: z.array(z.string()).default(["无"]),
    issues: z.array(z.string()).default([]),
    reason: z.string().default(""),
    description: z.string().optional()
  }))
});

export const smallQuestionBlankLayoutJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["blanks"],
  properties: {
    isEntirelyBlank: { type: "boolean", description: "整张答题区域是否完全空白无任何有效手写笔迹" },
    blanks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subquestionId", "coordinate", "hasAnswer", "extractedAnswer", "status", "confidence", "riskPoints", "issues", "reason"],
        properties: {
          subquestionId: { type: "string" },
          coordinate: {
            type: ["array", "null"],
            items: { type: "number" },
            minItems: 4,
            maxItems: 4,
            description: "手写作答紧密边界框 [x1, y1, x2, y2] (0..1000)，若未作答为 null"
          },
          hasAnswer: { type: "boolean", description: "是否存在有效手写笔迹" },
          extractedAnswer: { type: "string", description: "学生手写的答案文本、数字或符号" },
          status: { type: "string", enum: ["correct", "incorrect", "uncertain", "missing"], description: "初步正误判定" },
          confidence: { type: "number", minimum: 0, maximum: 1, description: "初检置信度" },
          riskPoints: {
            type: "array",
            items: {
              type: "string",
              enum: ["无", "切片截断", "严重涂改", "符号歧义", "字迹难辨"]
            },
            description: "影响打分可靠性的风险点列表。若卷面正常无任何风险，必须填 [\"无\"]；仅在存在确凿风险时填入对应枚举项"
          },
          issues: { type: "array", items: { type: "string" }, description: "仅记录涂改、模糊、选项混淆歧义或有效数字不符等实质性瑕疵；正常草写连笔请保持为空数组 []" },
          reason: { type: "string", description: "判定依据说明" },
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
  riskPoints: z.array(z.string()).default(["无"]),
  issues: z.array(z.string()).default([]),
  reason: z.string().default("")
});

export const smallQuestionSkepticAssessorJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["extractedAnswer", "status", "confidence", "riskPoints", "issues", "reason"],
  properties: {
    extractedAnswer: { type: "string", description: "手写答案内容" },
    status: { type: "string", enum: ["correct", "incorrect", "uncertain", "missing"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    riskPoints: {
      type: "array",
      items: {
        type: "string",
        enum: ["无", "切片截断", "严重涂改", "符号歧义", "字迹难辨"]
      },
      description: "影响打分可靠性的风险点列表。若切片清晰无任何风险，必须填 [\"无\"]；仅在存在确凿风险时填入对应枚举项"
    },
    issues: { type: "array", items: { type: "string" }, description: "发现的潜在瑕疵、有效数字问题或涂改点" },
    reason: { type: "string", description: "判定依据" }
  }
};

// 4. 高思考预算深度复检 Schema (请求 C，拉满推理预算)
export const smallQuestionEscalatedReviewSchema = z.object({
  finalExtractedAnswer: z.string().default(""),
  status: z.enum(["correct", "incorrect", "uncertain", "missing"]),
  confidence: z.number().min(0).max(1),
  riskPoints: z.array(z.string()).default(["无"]),
  visualAnalysis: z.string().default(""),
  resolutionReason: z.string().default("")
});

export const smallQuestionEscalatedReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["finalExtractedAnswer", "status", "confidence", "riskPoints", "visualAnalysis", "resolutionReason"],
  properties: {
    finalExtractedAnswer: { type: "string", description: "深度视觉审阅后确切的学生手写答案" },
    status: { type: "string", enum: ["correct", "incorrect", "uncertain", "missing"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    riskPoints: {
      type: "array",
      items: {
        type: "string",
        enum: ["无", "切片截断", "严重涂改", "符号歧义", "字迹难辨"]
      },
      description: "终审核验后是否存在影响打分可靠性的风险点。对照全景图后若确认无风险，必须填 [\"无\"]；若仍存在无法消解的风险则填入对应枚举项"
    },
    visualAnalysis: { type: "string", description: "对笔画、连笔、涂改、正负号的微观视觉分析" },
    resolutionReason: { type: "string", description: "终审裁决理由" }
  }
};

export type BlankSemanticDomain = "choice_letter" | "numeric" | "chinese_text" | "formula" | "general";

/**
 * 自动根据参考答案推断空位的语义类型与字符域
 */
export function detectBlankDomain(rules: readonly FinalAnswerRule[] | undefined): BlankSemanticDomain {
  if (!rules || rules.length === 0) return "general";
  const expressions = rules.map((r) => r.expression.trim()).filter(Boolean);
  if (expressions.length === 0) return "general";

  // 单选或多选字母（如 A, B, C, D 或 AB）
  const isChoiceLetter = expressions.every((e) => /^[A-Ga-g]{1,4}$/.test(e));
  if (isChoiceLetter) return "choice_letter";

  // 纯中文汉字/词语（如 甲、增大、顺时针）
  const isChinese = expressions.every((e) => /^[\u4e00-\u9fa5\s]+$/.test(e));
  if (isChinese) return "chinese_text";

  // 纯数值（包含小数、科学计数法等，如 3.80, 2, 1.5e-3）
  const isNumeric = expressions.every((e) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(e) || /^[+-]?(?:\d+\.?\d*|\.\d+)\s*[×x*]\s*10\^?\{?[+-]?\d+\}?$/.test(e));
  if (isNumeric) return "numeric";

  // 包含公式字符（反斜杠、上下标、运算符、等号等，或字母代数式如 U/I, mg/k, R1+R2）
  const isFormula = expressions.some((e) => /[\\_^={}+*/]/.test(e) || /[a-zA-Z]/.test(e));
  if (isFormula) return "formula";

  return "general";
}

interface BlankCropInternal {
  subquestionId: string;
  title: string;
  finalAnswers: readonly FinalAnswerRule[];
  domain: BlankSemanticDomain;
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

const SUBSTANTIVE_ISSUE_KEYWORDS = [
  "涂改", "修改", "划掉", "划线", "覆盖", "涂抹", "擦除", "改写", "重写", "重叠", "多重",
  "模糊", "看不清", "不清", "难认", "难辨", "辨认不清", "无法辨认", "无法确定", "不确定", "无法看清",
  "歧义", "模棱两可", "混淆", "冲突", "矛盾", "多选", "改选", "两可",
  "存疑", "疑问", "怀疑", "争议", "瑕疵",
  "未闭合", "漏写", "少写", "多写", "不符", "不一致", "不匹配", "错误", "违规",
  "形似", "疑似", "缺失", "缺少", "位数", "有效数字", "小数",
  "截断", "残缺", "视野", "裁切", "切片", "切边", "切除", "边缘", "不完整"
];

const BENIGN_HANDWRITING_PATTERNS = [
  /无(?:明显)?(?:涂改|瑕疵|疑问)/,
  /字迹(?:清晰|正常|工整|规范)/,
  /书写(?:清晰|正常|工整|规范)/,
  /(?:草写|连笔|连带|拖尾|倾斜|笔画|笔势|笔锋|手写体|尖顶|运笔|微倾)/
];

/**
 * 过滤并提取实质性疑点（如涂改、模糊、选项冲突混淆、有效数字不符等）。
 * 排除良性字迹形态描述（如“草写A，尖顶连笔略长”、“连笔稍长”等正常书写特征）。
 */
export function filterSubstantiveIssues(issues: readonly string[] | undefined): string[] {
  if (!issues || issues.length === 0) return [];
  return issues.filter((issue) => {
    const trimmed = issue.trim();
    if (!trimmed) return false;

    // 1. 显式肯定/排除性说明（如“无涂改”、“无明显涂改”、“无瑕疵”、“字迹清晰规范”）直接认定为非 issue
    if (/无(?:明显)?(?:涂改|瑕疵|疑问)/.test(trimmed)) {
      return false;
    }

    // 2. 实质性风险词优先检测：只要含有实质性风险词，一律保留为 issue
    const hasSubstantive = SUBSTANTIVE_ISSUE_KEYWORDS.some((kw) => trimmed.includes(kw));
    if (hasSubstantive) {
      return true;
    }

    // 3. 在没有任何实质风险词的前提下，若是良性字迹/运笔/工整确认描述，则视为非实质性说明，予以放行
    const isBenign = BENIGN_HANDWRITING_PATTERNS.some((pat) => pat.test(trimmed));
    if (isBenign) {
      return false;
    }

    // 4. 兜底防御：若未知且既非风险词又非明确良性运笔描述，保留为实质性疑点
    return true;
  });
}

export const SMALL_QUESTION_RISK_POINTS = [
  "无",
  "切片截断",
  "严重涂改",
  "符号歧义",
  "字迹难辨"
] as const;

export type SmallQuestionRiskPoint = typeof SMALL_QUESTION_RISK_POINTS[number];

/**
 * 归一化模型返回的风险点枚举值。支持中文或英文枚举，兼容去除多余空格。
 * 若为 "无" / "none" / "无风险" / "正常" 或空值，返回 "无"。
 */
export function normalizeRiskPoint(point: string): SmallQuestionRiskPoint | null {
  const p = point.trim();
  if (!p || p === "无" || p === "none" || p === "无风险" || p === "正常") {
    return "无";
  }
  // 明确排除否定句式（如“无截断”、“未见涂改”等）
  if (/(?:无|未见|没有|不存在|排除|并?非|未发现|未受到?)[^，。；\n]*(?:截断|残缺|涂改|歧义|模糊)/.test(p)) {
    return "无";
  }
  if (p === "切片截断" || p === "truncation" || p === "image_crop_truncated" || p.includes("截断") || p.includes("视野受限") || p.includes("视野残缺") || p.includes("裁切") || p.includes("残缺")) {
    return "切片截断";
  }
  if (p === "严重涂改" || p === "alteration" || p === "severe_alteration" || p.includes("涂改")) {
    return "严重涂改";
  }
  if (p === "符号歧义" || p === "symbol_ambiguity" || p.includes("小数点") || p.includes("符号")) {
    return "符号歧义";
  }
  if (p === "字迹难辨" || p === "unclear_handwriting" || p === "handwriting_unclear" || p.includes("难辨") || p.includes("潦草") || p.includes("模糊")) {
    return "字迹难辨";
  }
  return null;
}

/**
 * 提取影响打分可靠性的有效风险点集合。若仅包含“无”或为空，返回空数组（表示无风险，不复核）。
 */
export function extractActiveRiskPoints(riskPoints?: readonly string[]): SmallQuestionRiskPoint[] {
  if (!riskPoints || riskPoints.length === 0) return [];
  const normalized = riskPoints
    .map(normalizeRiskPoint)
    .filter((x): x is SmallQuestionRiskPoint => Boolean(x) && x !== "无");
  return [...new Set(normalized)];
}

export interface BlankRiskSignalResult {
  requiresReview: boolean;
  riskReasons: string[];
}

/**
 * 消除明确的事实排除性否定短语（如“无任何视野残缺或边缘截断”、“未见截断”、“无明显涂改”），避免将否定说明误判为风险
 */
export function stripNegatedRiskPhrases(text: string): string {
  return text
    .replace(/(?:无|未见|没有|不存在|排除|并?非|未发现|未受到?)(?:任何|明显的?|实质性)?(?:切片|图像|答卷|卷面|字符|手写|整卷)?(?:的)?(?:视野|边界)?(?:残缺|截断|裁切|切边|边界截断|不完整|笔画缺失|受限|模糊|涂改|划掉|修改|瑕疵)/g, "")
    .replace(/(?:无任何|未见任何|没有发现|不存在任何)[^，。；\n]*(?:截断|残缺|裁切|受限|涂改)/g, "");
}

/**
 * 检测单空批改结果中的高风险特征（模型明确返回的打分可靠性风险点、切片切偏、低置信度等）。
 * 严禁根据模型自由文本意见原文进行机械正则搜索。
 * 若模型明确返回 riskPoints 为 ["无"]，则表示卷面清晰无上述风险，不复核！
 */
export function detectBlankHighRiskSignals(options: {
  subquestionTitle: string;
  judgement?: FinalAnswerJudgement;
  recognitionAudit?: SmallQuestionBlankRecognitionAudit;
  cropAudit?: SmallQuestionBlankCropAudit;
}): BlankRiskSignalResult {
  const riskReasons: string[] = [];
  const { subquestionTitle, judgement, recognitionAudit, cropAudit } = options;

  const finalConfidence = judgement?.confidence ?? recognitionAudit?.finalConfidence ?? 1;
  const isMissing = judgement?.status === "missing" || recognitionAudit?.finalStatus === "missing";

  // 1. 显式存疑或不确定状态 (模型直接输出 uncertain)
  if (judgement?.status === "uncertain" || recognitionAudit?.finalStatus === "uncertain") {
    riskReasons.push(`${subquestionTitle}最终答案判定存疑，需人工复核`);
  }

  // 2. 检查模型明确返回的结构化打分可靠性风险点（绝不根据自由文本意见原文正则匹配！）
  // 终审 C 为终局仲裁：若经过终审 C 裁决，优先采信 C 的 riskPoints（终审高推理比对全景后若标“无”，权威消解前期切片存疑）
  let candidateRiskPoints: string[] | undefined = undefined;
  if (recognitionAudit?.decisionSource === "escalated_review_c") {
    candidateRiskPoints = recognitionAudit.escalatedReview?.riskPoints;
  } else if (recognitionAudit?.skepticAssessor?.riskPoints) {
    candidateRiskPoints = recognitionAudit.skepticAssessor.riskPoints;
  } else if (recognitionAudit?.finalRiskPoints) {
    candidateRiskPoints = recognitionAudit.finalRiskPoints;
  }

  // 提取有效打分可靠性风险点：严格采信模型结构化输出，若标“无”则无风险，绝不扫描意见原文！
  let activeRiskPoints: SmallQuestionRiskPoint[] = [];
  if (candidateRiskPoints !== undefined) {
    activeRiskPoints = extractActiveRiskPoints(candidateRiskPoints);
  } else {
    // 仅在完全没有结构化 riskPoints 的历史遗留审计记录中（如老旧单测或旧版数据），降级兜底检测
    const hasEscalatedResolution = recognitionAudit?.decisionSource === "escalated_review_c" && finalConfidence >= 0.95;
    const fallbackIssues: string[] = [];
    if (recognitionAudit?.skepticAssessor?.issues) fallbackIssues.push(...recognitionAudit.skepticAssessor.issues);
    for (const issue of fallbackIssues) {
      const rp = normalizeRiskPoint(stripNegatedRiskPhrases(issue));
      if (rp && rp !== "无") {
        if (rp === "切片截断" && hasEscalatedResolution) {
          // 切片截断已由终审 C 结合整卷全景多视角权威消解，不再从 B 的历史 issue 中重复标记
          continue;
        }
        activeRiskPoints.push(rp);
      }
    }
    activeRiskPoints = [...new Set(activeRiskPoints)];
  }

  for (const riskPoint of activeRiskPoints) {
    switch (riskPoint) {
      case "切片截断":
        riskReasons.push(`${subquestionTitle}存在切片视野裁切或笔画截断风险，需人工核验完整作答`);
        break;
      case "严重涂改":
        riskReasons.push(`${subquestionTitle}模型明确报告存在严重涂改争议，需人工核对`);
        break;
      case "符号歧义":
        riskReasons.push(`${subquestionTitle}存在涂改或小数点清晰度争议，需人工核验`);
        break;
      case "字迹难辨":
        riskReasons.push(`${subquestionTitle}模型明确报告字迹难辨无法确证，需人工核对`);
        break;
    }
  }

  // 3. 初检全景检测到有有效笔迹，但切片复核终判为空（物理切片偏离风险）
  // 核心保障：若已经过具备整卷全景输入的深度终审 C 权威裁决且非存疑状态，说明疑点已被全景仲裁权威消解，绝不假报风险拦截流水线！
  const isResolvedByEscalatedC = recognitionAudit?.decisionSource === "escalated_review_c" &&
    finalConfidence >= 0.90 &&
    recognitionAudit?.finalStatus !== "uncertain";

  if (cropAudit?.hasAnswer && isMissing && !isResolvedByEscalatedC) {
    riskReasons.push(`${subquestionTitle}初检全景检测到有效手写笔迹，但切片复核判定为未作答，疑似切片偏离，需人工核对`);
  }

  // 4. 低置信度兜底防线（非全卷空卷缺失时的低置信度）
  if (!isMissing && finalConfidence < 0.90) {
    riskReasons.push(`${subquestionTitle}识别置信度偏低(${finalConfidence})，需人工核对`);
  }

  return {
    requiresReview: riskReasons.length > 0,
    riskReasons: [...new Set(riskReasons)]
  };
}

/**
 * 校验某空是否满足满分快速放行的本地防御性硬规则门禁
 */
export function validateFastPassBlank(
  blank: {
    subquestionId: string;
    hasAnswer: boolean;
    extractedAnswer: string;
    status: "correct" | "incorrect" | "missing" | "uncertain";
    confidence: number;
    riskPoints?: string[];
    issues: string[];
    reason?: string;
  },
  subquestion: Rubric["subquestions"][number],
  domain: BlankSemanticDomain
): { pass: boolean; reason?: string } {
  if (!blank.hasAnswer) {
    return { pass: false, reason: "该空无有效作答笔迹" };
  }
  if (blank.status !== "correct") {
    return { pass: false, reason: `初检状态为 ${blank.status}，非 correct` };
  }
  if (blank.confidence < 0.90) {
    return { pass: false, reason: `初检置信度 ${blank.confidence} 低于快速放行门禁阈值 0.90` };
  }
  const activeRisks = extractActiveRiskPoints(blank.riskPoints);
  if (activeRisks.length > 0) {
    return { pass: false, reason: `初检明确报告存在卷面风险: ${activeRisks.join("、")}` };
  }
  const substantiveIssues = filterSubstantiveIssues(blank.issues);
  if (substantiveIssues.length > 0) {
    return { pass: false, reason: `初检存在实质疑点: ${substantiveIssues.join("; ")}` };
  }

  const cleanExtracted = normalizeAnswerString(blank.extractedAnswer);
  if (!cleanExtracted) {
    return { pass: false, reason: "提取作答内容为空" };
  }

  const finalAnswers = subquestion.finalAnswers ?? [];
  if (!finalAnswers.length) {
    return { pass: false, reason: "缺少明确参考答案规则" };
  }

  // 针对不同语义域的硬校验
  if (domain === "choice_letter") {
    const upper = cleanExtracted.toUpperCase();
    if (!/^[A-G]$/.test(upper)) {
      return { pass: false, reason: `选择题作答 ${cleanExtracted} 超出合法单选项集合 [A-G]` };
    }
    const matched = finalAnswers.some((f) => normalizeAnswerString(f.expression).toUpperCase() === upper);
    if (!matched) {
      return { pass: false, reason: `选择题作答 ${cleanExtracted} 与参考答案不匹配` };
    }
    return { pass: true };
  }

  if (domain === "numeric") {
    const isNum = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(cleanExtracted) ||
      /^[+-]?(?:\d+\.?\d*|\.\d+)\s*[×x*]\s*10\^?\{?[+-]?\d+\}?$/.test(cleanExtracted);
    if (!isNum) {
      return { pass: false, reason: `数值题作答 ${cleanExtracted} 不符合规范数字格式` };
    }

    // 小数位数严格匹配检查（防漏写末尾0）
    const refExpressions = finalAnswers.map((f) => f.expression.trim());
    for (const ref of refExpressions) {
      const refDotIdx = ref.indexOf(".");
      if (refDotIdx !== -1) {
        const expectedDecimals = ref.length - refDotIdx - 1;
        const studentDotIdx = cleanExtracted.indexOf(".");
        const studentDecimals = studentDotIdx === -1 ? 0 : cleanExtracted.length - studentDotIdx - 1;
        if (studentDecimals !== expectedDecimals) {
          return {
            pass: false,
            reason: `有效数字小数位数不符：参考答案期望 ${expectedDecimals} 位，实际写了 ${studentDecimals} 位`
          };
        }
      }
    }

    const equiv = comparePhysicsAnswer(cleanExtracted, finalAnswers);
    if (equiv.status !== "equivalent") {
      return { pass: false, reason: `数值比对不相等: ${equiv.reason}` };
    }
    return { pass: true };
  }

  if (domain === "chinese_text") {
    const matched = finalAnswers.some((f) => normalizeAnswerString(f.expression) === cleanExtracted);
    if (!matched) {
      return { pass: false, reason: `汉字作答 ${cleanExtracted} 与参考答案不一致` };
    }
    return { pass: true };
  }

  if (domain === "formula") {
    const equiv = comparePhysicsAnswer(blank.extractedAnswer, finalAnswers);
    if (equiv.status !== "equivalent") {
      return { pass: false, reason: `公式代数不等价: ${equiv.reason}` };
    }
    return { pass: true };
  }

  const matched = finalAnswers.some((f) => normalizeAnswerString(f.expression) === cleanExtracted);
  if (!matched) {
    const equiv = comparePhysicsAnswer(blank.extractedAnswer, finalAnswers);
    if (equiv.status !== "equivalent") {
      return { pass: false, reason: `作答与参考答案不匹配` };
    }
  }

  return { pass: true };
}

export type SmallQuestionBlankLayoutItem = z.infer<typeof smallQuestionBlankLayoutSchema>["blanks"][number];
export type SmallQuestionSkepticAssessorOutput = Omit<z.infer<typeof smallQuestionSkepticAssessorSchema>, "riskPoints"> & {
  riskPoints?: string[];
};

export interface SafeCropBoxContext {
  /** 同卷或同行中，右侧后续小空的最小 x 坐标（0..1000 归一化） */
  nextBlankNormalizedX?: number | null;
  /** 同卷或同行中，左侧前置小空的最大 x 坐标（0..1000 归一化） */
  prevBlankNormalizedX?: number | null;
}

/**
 * 健壮的答卷局部切片坐标计算：
 * 1. 纵向防御：针对高度较矮的扁平横条答卷（高度 <= 220px），纵向直接取满整图高度（0 到 imageHeight），
 *    彻底消除视觉大模型纵向归一化估计偏小导致字符上下边缘被硬生生截断的问题；
 * 2. 横向防御（彻底杜绝切偏/切空）：
 *    - 当右侧没有后续小问时（如横向多题排布的最后一题 (3)），右边界直接吃满整张答卷的右边缘，
 *      从几何上 100% 杜绝模型将坐标锚定在小问序号印刷标号（如“(3)”）或横线起点而导致右侧手写作答被切在区域外；
 *    - 当右侧存在后续小问时，右边界安全延伸至下一小问之前，同时保证至少充足的横向作答区横线宽度；
 *    - 对较高全页图像，同样保留充分的上下左右安全外扩冗余。
 */
export function computeSafeCropBox(
  coordinate: [number, number, number, number],
  imageWidth: number,
  imageHeight: number,
  context?: SafeCropBoxContext
): { left: number; top: number; width: number; height: number } {
  const [nx1, ny1, nx2, ny2] = coordinate;
  const isFlatStrip = imageHeight <= 220;

  const minNX = Math.min(nx1, nx2);
  const maxNX = Math.max(nx1, nx2);
  const coordLeft = (minNX / 1000) * imageWidth;
  const coordRight = (maxNX / 1000) * imageWidth;

  let padLeft: number;
  let padRight: number;

  if (isFlatStrip) {
    padLeft = Math.max(48, Math.round(imageWidth * 0.055));
    padRight = Math.max(80, Math.round(imageWidth * 0.09));
  } else {
    padLeft = Math.max(48, Math.round(imageWidth * 0.05));
    padRight = Math.max(64, Math.round(imageWidth * 0.065));
  }

  let left = Math.max(0, Math.floor(coordLeft - padLeft));
  if (context?.prevBlankNormalizedX != null) {
    const prevRightPixel = Math.ceil((context.prevBlankNormalizedX / 1000) * imageWidth);
    // 确保不过度侵入上一小问的核心手写区域
    if (prevRightPixel < coordLeft) {
      left = Math.max(left, prevRightPixel + 8);
    }
  }

  let right: number;
  if (isFlatStrip) {
    if (context?.nextBlankNormalizedX == null) {
      // 关键：右侧无后续小问时，直接取满整图右边缘！彻底杜绝右侧手写字被切在框外
      right = imageWidth;
    } else {
      const nextLeftPixel = Math.floor((context.nextBlankNormalizedX / 1000) * imageWidth);
      const safeRightLimit = Math.max(coordRight, nextLeftPixel - Math.max(16, Math.round(imageWidth * 0.02)));
      const desiredRight = Math.ceil(coordRight + Math.max(padRight, Math.round(imageWidth * 0.15)));
      right = Math.min(imageWidth, Math.min(safeRightLimit, Math.max(coordRight + 48, desiredRight)));
    }
  } else {
    if (context?.nextBlankNormalizedX == null) {
      right = Math.min(imageWidth, Math.ceil(coordRight + Math.max(padRight, Math.round(imageWidth * 0.15))));
    } else {
      const nextLeftPixel = Math.floor((context.nextBlankNormalizedX / 1000) * imageWidth);
      const safeRightLimit = Math.max(coordRight, nextLeftPixel - Math.max(16, Math.round(imageWidth * 0.02)));
      const desiredRight = Math.ceil(coordRight + padRight);
      right = Math.min(imageWidth, Math.min(safeRightLimit, desiredRight));
    }
  }

  let top = 0;
  let bottom = imageHeight;
  if (!isFlatStrip) {
    const padY = Math.max(32, Math.round(imageHeight * 0.08));
    top = Math.max(0, Math.floor((Math.min(ny1, ny2) / 1000) * imageHeight - padY));
    bottom = Math.min(imageHeight, Math.ceil((Math.max(ny1, ny2) / 1000) * imageHeight + padY));
  }

  const width = Math.max(10, right - left);
  const height = Math.max(10, bottom - top);
  return { left, top, width, height };
}

/**
 * 依据整卷版面中已定位的各空坐标，构建横向相对拓扑上下文（相邻左右邻居的坐标边界），
 * 赋能各空切片自适应覆盖完整的下划线作答区间并彻底消除切空。
 */
export function buildBlankLayoutContextMap(
  blanks: Array<{ subquestionId: string; coordinate: [number, number, number, number] | null; hasAnswer?: boolean }>
): Map<string, SafeCropBoxContext> {
  const map = new Map<string, SafeCropBoxContext>();
  const activeBlanksWithCoord = blanks
    .filter((b) => b.coordinate && b.hasAnswer)
    .map((b) => ({
      subquestionId: b.subquestionId,
      coordinate: b.coordinate!,
      minX: Math.min(b.coordinate![0], b.coordinate![2]),
      maxX: Math.max(b.coordinate![0], b.coordinate![2])
    }))
    .sort((a, b) => a.minX - b.minX);

  for (let i = 0; i < activeBlanksWithCoord.length; i++) {
    const current = activeBlanksWithCoord[i];
    const prev = i > 0 ? activeBlanksWithCoord[i - 1] : null;
    const next = i < activeBlanksWithCoord.length - 1 ? activeBlanksWithCoord[i + 1] : null;
    map.set(current.subquestionId, {
      prevBlankNormalizedX: prev?.maxX ?? null,
      nextBlankNormalizedX: next?.minX ?? null
    });
  }
  return map;
}

export interface DiscrepancyLayoutBlankInput {
  subquestionId?: string;
  hasAnswer?: boolean;
  status: "correct" | "incorrect" | "missing" | "uncertain";
  extractedAnswer: string;
  confidence?: number;
  reason?: string;
  issues?: string[];
}

/**
 * 严格检测初审（全卷全图初检）与挑刺审查 B（切片核验）之间的实质冲突：
 * 1. 初审全图检测到有效作答，但切片判空或未作答（切片偏离/漏检）；
 * 2. 初审全图判空，但切片审查识别出有效作答；
 * 3. 初审判定 correct，而 B 判定 incorrect 或 uncertain；
 * 4. 初审判定 incorrect，而 B 判定 correct；
 * 5. 提取内容实质不一致且正误或解释存在分歧；
 * 6. B 明确报告局部切片存在严重截断、残缺或视野受限。
 */
export function detectInitialVsSkepticDiscrepancy(
  layoutBlank: DiscrepancyLayoutBlankInput | undefined,
  resB: SmallQuestionSkepticAssessorOutput
): { isDiscrepant: boolean; reason: string } {
  if (!layoutBlank) {
    return { isDiscrepant: false, reason: "" };
  }

  const cleanInit = normalizeAnswerString(layoutBlank.extractedAnswer);
  const cleanB = normalizeAnswerString(resB.extractedAnswer);
  const initHasAnswer = Boolean(layoutBlank.hasAnswer || cleanInit);
  const bHasAnswer = Boolean(cleanB || resB.status !== "missing");

  // 1. 初审全图检测到有作答，但切片审查判定为未作答（严重切片偏移风险）
  if (initHasAnswer && !bHasAnswer) {
    return {
      isDiscrepant: true,
      reason: `初检全图检测到有效作答(提取:"${layoutBlank.extractedAnswer || "有笔迹"}")，但切片审查判定为未作答，疑似切片偏离或漏检`
    };
  }

  // 2. 初审全图未见作答，但切片审查识别出有效作答
  if (!initHasAnswer && bHasAnswer) {
    return {
      isDiscrepant: true,
      reason: `初检全图未检测到作答，但切片审查识别出有效作答("${resB.extractedAnswer}")，存在作答存在性分歧`
    };
  }

  // 3. 初审判定为 correct，但 B 判定为 incorrect 或 uncertain
  if (layoutBlank.status === "correct" && resB.status !== "correct") {
    return {
      isDiscrepant: true,
      reason: `初检全图判定为正确(提取:"${layoutBlank.extractedAnswer}")，但切片审查判定为${resB.status}(提取:"${resB.extractedAnswer}")，存在正误判断冲突`
    };
  }

  // 4. 初审判定为 incorrect，但 B 判定为 correct
  if (layoutBlank.status === "incorrect" && resB.status === "correct") {
    return {
      isDiscrepant: true,
      reason: `初检全图判定为错误(提取:"${layoutBlank.extractedAnswer}")，但切片审查判定为正确(提取:"${resB.extractedAnswer}")，存在正误判断冲突`
    };
  }

  // 5. 提取作答内容实质不一致
  if (cleanInit && cleanB && cleanInit !== cleanB) {
    const equiv = comparePhysicsAnswer(layoutBlank.extractedAnswer, [{ expression: resB.extractedAnswer }]);
    if (equiv.status !== "equivalent") {
      return {
        isDiscrepant: true,
        reason: `初检提取内容("${layoutBlank.extractedAnswer}")与切片审查内容("${resB.extractedAnswer}")实质不一致`
      };
    }
  }

  // 6. B 明确报告切片存在截断或视野残缺
  const activeRisksB = extractActiveRiskPoints(resB.riskPoints);
  const isNegatedTruncation = (text: string) =>
    /(?:无|未见|没有|不存在|排除|并?非|未发现|未受到?)(?:任何|明显的?|实质性)?(?:切片|图像|视野|边界)?(?:截断|残缺|视野受限|视野残缺|下半部分缺失|上半部分缺失|底部存在裁切|顶部存在裁切|边缘裁切|切片边缘|切边|边界截断|不完整|笔画缺失|裁切|严重变形)/.test(text);

  const mentionsTruncation = activeRisksB.includes("切片截断") ||
    (resB.riskPoints === undefined && (
      (resB.issues || []).some((issue) => !isNegatedTruncation(issue) && /截断|残缺|视野受限|下半部分缺失|上半部分缺失|裁切/.test(issue)) ||
      (!isNegatedTruncation(resB.reason || "") && /截断|残缺|视野受限|视野残缺|裁切/.test(resB.reason || ""))
    ));
  if (mentionsTruncation && (layoutBlank.status === "correct" || resB.status === "uncertain")) {
    return {
      isDiscrepant: true,
      reason: `切片审查指出作答区域存在严重截断或视野残缺，需对照整卷全图终审裁决`
    };
  }

  return { isDiscrepant: false, reason: "" };
}

export interface CheckThreeWayConsensusOptions {
  layoutBlank: DiscrepancyLayoutBlankInput | undefined;
  resA: { extractedAnswer: string; confidence: number };
  resB: SmallQuestionSkepticAssessorOutput;
  finalAnswers: readonly FinalAnswerRule[];
}

/**
 * 首评（全卷初检）、盲审 A、挑刺 B 三方一致性门禁判定：
 * 核心法则：模型首评、A、B 三者识别到的作答内容均一致且无未消解疑点时，才不用调用终审 C！
 * 1. 首评检测到有效作答，但切片判空（A/B 无字或 missing）：存在切片偏离，必须判定为不一致；
 * 2. 首评未见作答，但切片检出有效笔迹：存在有无作答分歧，必须判定为不一致；
 * 3. 首评、A、B 三者提取字符实质不一致：必须判定为不一致；
 * 4. 切片存在未消解的截断、残缺，或 B 存疑/低置信实质质疑：必须判定为不一致；
 * 5. 仅当三者提取内容完全一致（或物理等价），且无严重截断与质疑时，才判定为一致放行。
 */
export function checkThreeWayConsensus(options: CheckThreeWayConsensusOptions): {
  isConsistent: boolean;
  reason: string;
} {
  const { layoutBlank, resA, resB, finalAnswers } = options;
  const cleanInit = normalizeAnswerString(layoutBlank?.extractedAnswer || "");
  const cleanA = normalizeAnswerString(resA.extractedAnswer || "");
  const cleanB = normalizeAnswerString(resB.extractedAnswer || "");

  const areEquivalent = (ans1: string, ans2: string): boolean => {
    if (ans1 === ans2) return true;
    if (!ans1 || !ans2) return false;
    return comparePhysicsAnswer(ans1, [{ expression: ans2 }]).status === "equivalent";
  };

  const activeRisksB = extractActiveRiskPoints(resB.riskPoints);
  const isNegatedTruncation = (text: string) =>
    /(?:无|未见|没有|不存在|排除|并?非|未发现|未受到?)(?:任何|明显的?|实质性)?(?:切片|图像|视野|边界)?(?:截断|残缺|视野受限|视野残缺|下半部分缺失|上半部分缺失|底部存在裁切|顶部存在裁切|边缘裁切|切片边缘|切边|边界截断|不完整|笔画缺失|裁切|严重变形)/.test(text);

  const mentionsTruncation = activeRisksB.includes("切片截断") ||
    (resB.riskPoints === undefined && (
      (resB.issues || []).some((issue) => !isNegatedTruncation(issue) && /截断|残缺|视野受限|下半部分缺失|上半部分缺失|裁切/.test(issue)) ||
      (!isNegatedTruncation(resB.reason || "") && /截断|残缺|视野受限|视野残缺|裁切/.test(resB.reason || ""))
    ));

  if (mentionsTruncation) {
    return {
      isConsistent: false,
      reason: `挑刺审查员指出作答切片存在截断或视野残缺: ${resB.issues.join("; ") || resB.reason}`
    };
  }

  if (activeRisksB.length > 0) {
    return {
      isConsistent: false,
      reason: `挑刺审查员明确指出卷面风险: ${activeRisksB.join("、")}`
    };
  }

  // 1. 初检有作答 vs 切片判空（切片切偏风险，典型如 zhixue:8ffa3436）
  const initHasAnswer = Boolean((layoutBlank?.hasAnswer ?? false) || cleanInit);
  if (initHasAnswer && (!cleanA || !cleanB || resB.status === "missing")) {
    return {
      isConsistent: false,
      reason: `初检全图检测到有效作答(提取:"${layoutBlank?.extractedAnswer || "有笔迹"}")，但切片核验(盲审:"${resA.extractedAnswer}", 挑刺:"${resB.extractedAnswer}")判空，疑似切片偏离`
    };
  }

  // 2. 初检无作答 vs 切片识别出作答
  if (!initHasAnswer && (cleanA || cleanB || resB.status !== "missing")) {
    return {
      isConsistent: false,
      reason: `初检全图未检测到作答，但切片核验识别出有效作答(盲审:"${resA.extractedAnswer}", 挑刺:"${resB.extractedAnswer}")，存在有无作答分歧`
    };
  }

  // 3. 全空一致：三者均确认未作答
  if (!initHasAnswer && !cleanA && !cleanB && resB.status === "missing") {
    return {
      isConsistent: true,
      reason: ""
    };
  }

  // 4. 内容一致性对比：三者提取内容是否均一致
  if (cleanInit) {
    const initVsA = areEquivalent(cleanInit, cleanA);
    const aVsB = areEquivalent(cleanA, cleanB);
    const initVsB = areEquivalent(cleanInit, cleanB);

    if (!initVsA || !aVsB || !initVsB) {
      return {
        isConsistent: false,
        reason: `首评("${layoutBlank?.extractedAnswer}")、盲审A("${resA.extractedAnswer}")与挑刺B("${resB.extractedAnswer}")三者识别作答内容不一致`
      };
    }
  } else {
    // 若 cleanInit 为空但 initHasAnswer 为 true 的边缘情况：至少 A 与 B 必须一致
    if (!areEquivalent(cleanA, cleanB)) {
      return {
        isConsistent: false,
        reason: `盲审转录(${resA.extractedAnswer})与挑刺审查(${resB.extractedAnswer})字符不一致`
      };
    }
  }

  // 5. 挑刺审查员质疑或存疑
  if (resB.status !== "correct" && resB.status !== "missing") {
    return {
      isConsistent: false,
      reason: `挑刺审查员判定状态为 ${resB.status}，存在质疑: ${resB.reason}`
    };
  }

  // 6. 挑刺审查员指出实质瑕疵且置信度不足
  if (resB.issues.length > 0 && resB.confidence < 0.92) {
    return {
      isConsistent: false,
      reason: `挑刺审查员指出潜在疑点且置信度偏低(${resB.confidence}): ${resB.issues.join("; ")}`
    };
  }

  return {
    isConsistent: true,
    reason: ""
  };
}

export function buildDomainGuardC(domain: BlankSemanticDomain, finalAnswers: readonly FinalAnswerRule[]): string {
  if (domain === "choice_letter") {
    return `\n【终审重要警示与常识约束】：
1. 考场理性人假定：本空为单项选择题，考生的合法作答仅为单个大写字母选项（如 A、B、C、D）。初检中若出现脱离字母域的无关多位数字（如 18、19 等），属于典型的计算机视觉对草写单字母的跨域误读。严禁将单字母的潦草笔迹脑补为脱离单选题常识的无关数字或题号！
2. 假设检验与意图优先：请以“验证考生是否书写了参考答案（${formatFinalAnswers(finalAnswers)}）”为优先检验假设。微观分析该笔划轨迹是否符合学生一气呵成书写该字母时的动态手写变形习惯（例如大写 A 笔画分体、左竖右圈、或手写体 a 轮廓）；
3. 排除法裁决：若卷面笔迹非涂改，且没有确凿证据表明学生实际书写了其他选项字母（如 B/C/D），整体书写动态倾向于参考答案，必须纠偏并判定为正确（status: correct）；
4. 【涂改微观解构与防拼接】：若字符上有穿透性单竖线、斜线或划线（如竖划线穿过弧线字母 C），明确为考生主动划掉作废，已被划掉的字符绝对作废，【严禁误判为字母 D 或 d】！有效作答必须剔除被划掉的字符。`;
  }
  if (domain === "formula") {
    return `\n【代数公式题终审裁决准则】：
1. 物理上下文与已知量先验：结合高中物理试题常规已知量，微观审视考生书写的符号到底是物理变量还是数字（例如分母/因数中的 g 绝非数字 9 或字母 q，分子中的 l 绝非数字 1）。严禁脱离物理试题背景进行孤立字符误读；
2. 严格代数恒等推导：在数学上验证学生的表达式是否与参考答案恒等（允许系数外提、因式展开/分解、多项式换序等）。只要物理意义和代数关系完全一致，无论形式如何，终审必须判定为正确（status: correct）；
3. 根号与分式容错：只要能判断考生书写的物理意图完整，不因根号横线未拉至末尾或分数线轻微断连而苛求判错。`;
  }
  return `\n【终审善意推定准则】：
高中物理阅卷以考查学科实质为准，只要考生的笔迹动态能合理解释为参考答案的书写习惯，且不存在实质错误与严重涂改冲突，终审应倾向于认定正确。`;
}

export function buildEscalatedReviewPrompt(params: {
  title: string;
  finalAnswers: readonly FinalAnswerRule[];
  criteriaGuidance?: string;
  domainGuardC: string;
  comparisonDetails: string;
  triggerReason: string;
}): string {
  return `请对该小题手写作答进行拉满思考预算的权威终审裁决。
对应小题：${params.title}
参考答案（满足任一即为正确）：${formatFinalAnswers(params.finalAnswers)}
${params.criteriaGuidance ? `评分规则与特殊要求：${params.criteriaGuidance}\n` : ""}${params.domainGuardC}

【多视角输入说明】：
- 图 1：本空高清局部切片（可能存在算法定位偏移、边缘截断或仅截取了部分笔画的情况）；
- 图 2 起：学生答卷整卷/整页全景图（包含该题完整原始手写笔迹上下文）。

【前序审查结论与分歧】：
${params.comparisonDetails}
- 触发仲裁原因：${params.triggerReason}

终审要求：
1. 【多视角与切片截断核查】：请特别注意“局部切片打歪截断”的假象！若局部切片（图1）仅截取到了字符的上半截、下半截或部分孤立笔画（如半边圆弧），你必须立即对照整卷全景图（图2起）中对应题目的完整原始手写笔迹！若全景图完整笔迹明确符合正确答案（如手写大写字母 C），切片打歪截断绝不能作为扣分、判错或 uncertain 的理由；
2. 【涂改微观解构】：若存在重叠笔画或穿透性划线，辨别考生先写与后划的墨迹关系。被明显划掉的废弃笔迹绝对作废（如在 C 上画竖线划掉，有效作答绝非 D/d）；
3. 展开完整的微观视觉反思链，综合切片高清细节与整卷全景完整性，严格根据参考答案及评分规则做出权威终审判定；
4. 【打分可靠性风险点裁决（riskPoints）】：终审必须明确输出 riskPoints 数组。若对照全景图后视野完整、笔迹清晰，必须填 ["无"]；若对照全景图后仍存在确凿的卷面物理风险，选择对应枚举项（"切片截断"、"严重涂改"、"符号歧义"、"字迹难辨"）。若无风险请标无，绝不无故复核。`;
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
  // 阶段 1：整卷全景初检与各空定位
  // ----------------------------------------------------
  const subquestionsList = input.rubric.subquestions.map((sq: Rubric["subquestions"][number]) => {
    const finalAnswers = sq.finalAnswers ?? [];
    const domain = detectBlankDomain(finalAnswers);
    const domainName = domain === "choice_letter" ? "单项选择题(选项单字母A/B/C/D)" :
      domain === "numeric" ? "数值计算/读数" :
      domain === "chinese_text" ? "汉字词语填空" :
      domain === "formula" ? "物理字母代数式公式" : "常规填空";
    const criteriaGuidance = sq.scorePoints
      .map((p) => [p.title, p.description, p.expected].filter(Boolean).join("："))
      .filter(Boolean)
      .join("；");
    return `- ${sq.id} (${sq.title}) [题型: ${domainName}]：参考答案: ${formatFinalAnswers(finalAnswers)}${criteriaGuidance ? `；评分规则: ${criteriaGuidance}` : ""}`;
  }).join("\n");

  const layoutStart = performance.now();
  const layoutResponse = await callStructured(layoutRoute.config, {
    model: layoutRoute.model,
    routeKey: layoutRoute.routeKey,
    system: getBuiltInSystemPrompt(layoutRoute.routeKey),
    prompt: `请对这份高中物理小题答卷进行整卷全景初检与版面分析：
空位列表与参考标准：
${subquestionsList}

题目文字（参考）：${input.questionText?.trim() || "见题图"}

核心任务：
1. 全卷作答状态：若整张答题区域完全空白未见任何有效手写笔迹，isEntirelyBlank 设为 true；
2. 逐空定位与手写区域框选：
   - coordinate: [x1, y1, x2, y2]（0..1000 归一化手写边界框）：
     【手写笔迹核心定位准则】：coordinate 必须精准框选【学生手写笔迹自身】（即你所提取的 extractedAnswer 字符本身）！
     【严禁框选印刷小问序号】：学生作答通常书写在印刷题号/序号（如“(1)”、“(2)”、“(3)”）右侧的横线上，绝对禁止将边界框坐标锚定在左侧印刷小问序号或横线起点！若某空提取了答案（如“D”或“2.1”），coordinate 必须完整包含右侧实际书写的“D”或“2.1”字符，绝不能只框住印刷标号“(3)”而遗漏右侧手写答案；
   - 若某空明确未作答（完全空白或仅有试卷印刷横线，无任何有效手写笔迹），coordinate 必须返回 null，且 hasAnswer 设为 false，status 设为 "missing"；
3. 初检转录与正误初评：
   - 忠实提取学生实际书写的答案（extractedAnswer）；
   - 对照参考答案与评分要求给出初步判定（status: "correct" | "incorrect" | "uncertain" | "missing"）；
   - 给出判定置信度（confidence: 0..1）；
   - 评估影响打分可靠性的风险点（riskPoints）：若卷面完整正常无风险，必须填 ["无"]；若存在影响判分可靠性的确凿卷面问题，填入对应枚举项（"切片截断"、"严重涂改"、"符号歧义"、"字迹难辨"）；
   - 记录任何实质性笔迹瑕疵、涂改、歧义混淆或有效数字疑问（issues）；中学生正常草写连笔若无歧义请保持 issues 为空 []；
4. 阅卷准则与常识警示：
   - 【选择题】：考生的合法作答仅限单字母（A/B/C/D）。注意中学生常见草写变形（如大写 A 的左竖右圈、连笔横杠、尖顶稍长）。若整体笔势符合参考选项且未选其他冲突选项，初评应果断认定为 correct，且 issues 保持为空 []；严禁将正常草写连笔误当作 issue，严禁脱离单选题背景将单字母误读为多位无关数字！
   - 【涂改划掉与防拼接警示】：考生写错后常在字符上画穿透性的竖线、斜线或单横线划掉作废。已被划掉作废的字符绝对作废，【严禁将划线与字符残影机械拼接误读为新字母】（特别警惕经典多模态视觉错觉：在圆弧字母 C 上画竖线划掉，极易被机械拼接误判为字母 D 或 d！写了 A、B 且将随后的 C 划掉时，有效作答应提取为 AB，绝非 ABD；若写了 C 划掉改写 A，有效作答为 A）。被划掉的字符应在 issues 中注明；
   - 【数值题】：仔细核对有效数字位数与小数点位置（例如参考答案要求3.80时，是否保留了2位小数）；
   - 【公式题】：输出规范 LaTeX 表达式，物理/数学代数恒等形式应认定为 correct。`,
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
  // 快速通道门禁 1：空卷快速通道 (全空直接 0 分结卷)
  // ----------------------------------------------------
  const isAllMissing = layout.isEntirelyBlank ||
    (input.rubric.subquestions.length > 0 &&
      input.rubric.subquestions.every((sq) => {
        const b = layout.blanks.find((x) => x.subquestionId === sq.id);
        return !b || !b.hasAnswer || b.status === "missing";
      }));

  if (isAllMissing) {
    logProgress(operationId, "grading", "small_question_blank_fast_path", `空卷快速通道触发：全卷未作答，直接判定 0 分（耗时 ${layoutDurationMs}ms）`, {
      subquestionsCount: input.rubric.subquestions.length,
      durationMs: layoutDurationMs
    }, "success");

    const finalJudgements: FinalAnswerJudgement[] = [];
    const recognitionAudits: SmallQuestionBlankRecognitionAudit[] = [];
    const cropAudits: SmallQuestionBlankCropAudit[] = [];

    for (const sq of input.rubric.subquestions) {
      const b = layout.blanks.find((x) => x.subquestionId === sq.id);
      cropAudits.push({
        subquestionId: sq.id,
        title: sq.title,
        coordinate: b?.coordinate ?? null,
        hasAnswer: false
      });
      finalJudgements.push({
        subquestionId: sq.id,
        status: "missing",
        answerPresence: "no_effective_answer",
        evidenceLineIds: [],
        studentAnswer: "",
        referenceAnswer: formatFinalAnswers(sq.finalAnswers),
        reason: "整卷初检确认未作答，未检测到任何有效手写笔迹",
        confidence: 1,
        decisionSource: "teacher_model"
      });
      recognitionAudits.push({
        subquestionId: sq.id,
        blindTranscriber: { extractedAnswer: "", confidence: 1 },
        skepticAssessor: { extractedAnswer: "", status: "missing", confidence: 1, issues: [], reason: "未作答" },
        comparisonStatus: "consensus",
        finalStatus: "missing",
        finalAnswer: "",
        finalConfidence: 1,
        decisionSource: "blank_missing"
      });
    }

    const decisions = input.rubric.subquestions.flatMap((sq) =>
      sq.scorePoints.map((point) => ({
        subquestionId: sq.id,
        pointId: point.id,
        status: "not_satisfied" as const,
        evidenceLineIds: [],
        evidenceQuote: "",
        reason: "整卷初检确认未作答",
        confidence: 1,
        requiresReview: false
      }))
    );

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
      durationMs: layoutDurationMs,
      unreadableReviewThreshold: config.unreadableReviewThreshold,
      operationId,
      previousResultId: input.previousResultId,
      regradedAt: input.regradedAt,
      regradeReason: input.regradeReason
    });

    result.gradingPipeline = "small_question_staged";
    result.imagePreprocessAudit = preparedStudentAnswer.preparation.audit;
    result.smallQuestionAudit = {
      pipeline: "staged_vision_crops",
      layoutDurationMs,
      dualRecognitionDurationMs: 0,
      escalatedReviewDurationMs: 0,
      crops: cropAudits,
      recognitions: recognitionAudits
    };
    result.teacherCommentary = createFallbackTeacherCommentary(result);

    completeOperation(operationId, "grading", "grading_completed", `${input.studentId}小题空卷批改完成：0/${result.maxScore}分`, {
      status: result.status,
      gradingPipeline: "small_question_staged",
      reviewReasons: result.reviewReasons.length,
      cropsCount: 0,
      scoreResolved: result.scoreResolved
    });

    return result;
  }

  // ----------------------------------------------------
  // 快速通道门禁 2：全卷满分快速通道 (全对且通过本地硬规则门禁直接满分结卷)
  // ----------------------------------------------------
  const fastPassValidationResults = new Map<string, { pass: boolean; reason?: string }>();
  for (const sq of input.rubric.subquestions) {
    const b = layout.blanks.find((x) => x.subquestionId === sq.id);
    const domain = detectBlankDomain(sq.finalAnswers);
    if (!b) {
      fastPassValidationResults.set(sq.id, { pass: false, reason: "版面初检未定位到该空" });
    } else {
      fastPassValidationResults.set(sq.id, validateFastPassBlank(b, sq, domain));
    }
  }

  const allFastPass = input.rubric.subquestions.length > 0 &&
    input.rubric.subquestions.every((sq) => fastPassValidationResults.get(sq.id)?.pass === true);

  if (allFastPass) {
    logProgress(operationId, "grading", "small_question_all_correct_fast_path", `全卷各空初检均判定正确且通过本地硬校验，成功触发满分快速放行通道（耗时 ${layoutDurationMs}ms）`, {
      subquestionsCount: input.rubric.subquestions.length,
      durationMs: layoutDurationMs
    }, "success");

    const finalJudgements: FinalAnswerJudgement[] = [];
    const recognitionAudits: SmallQuestionBlankRecognitionAudit[] = [];
    const cropAudits: SmallQuestionBlankCropAudit[] = [];
    const cropContextMap = buildBlankLayoutContextMap(layout.blanks);

    for (const sq of input.rubric.subquestions) {
      const b = layout.blanks.find((x) => x.subquestionId === sq.id)!;
      let cropBuffer = Buffer.alloc(0);
      let cropWidth = 0;
      let cropHeight = 0;
      const fileName = `small-blank-${sq.id}-crop.webp`;

      if (b.coordinate && imageWidth && imageHeight) {
        const cropBox = computeSafeCropBox(b.coordinate, imageWidth, imageHeight, cropContextMap.get(sq.id));
        cropWidth = cropBox.width;
        cropHeight = cropBox.height;
        try {
          cropBuffer = await sharp(studentImage.buffer)
            .extract({ left: cropBox.left, top: cropBox.top, width: cropBox.width, height: cropBox.height })
            .webp({ quality: 95 })
            .toBuffer();
        } catch {
          cropBuffer = studentImage.buffer;
        }
      }

      if (artifactSource && cropBuffer.length) {
        artifactSource.subquestionCrops = artifactSource.subquestionCrops ?? [];
        artifactSource.subquestionCrops.push({
          fileName,
          mimeType: "image/webp",
          category: "agent_region",
          buffer: cropBuffer
        });
      }

      cropAudits.push({
        subquestionId: sq.id,
        title: sq.title,
        coordinate: b.coordinate,
        hasAnswer: true,
        artifactFileName: fileName,
        cropWidth,
        cropHeight
      });

      finalJudgements.push({
        subquestionId: sq.id,
        status: "correct",
        answerPresence: "confirmed_answer",
        evidenceLineIds: [],
        studentAnswer: b.extractedAnswer,
        referenceAnswer: formatFinalAnswers(sq.finalAnswers),
        reason: `整卷初检确认正确并通过本地硬校验: ${b.reason || b.extractedAnswer}`,
        confidence: b.confidence,
        decisionSource: "teacher_model"
      });

      recognitionAudits.push({
        subquestionId: sq.id,
        blindTranscriber: { extractedAnswer: b.extractedAnswer, confidence: b.confidence },
        skepticAssessor: {
          extractedAnswer: b.extractedAnswer,
          status: "correct",
          confidence: b.confidence,
          issues: [],
          reason: b.reason || "初检正确并通过本地硬校验"
        },
        comparisonStatus: "consensus",
        finalStatus: "correct",
        finalAnswer: b.extractedAnswer,
        finalConfidence: b.confidence,
        decisionSource: "consensus_ab"
      });
    }

    const decisions = input.rubric.subquestions.flatMap((sq) =>
      sq.scorePoints.map((point) => ({
        subquestionId: sq.id,
        pointId: point.id,
        status: "satisfied" as const,
        evidenceLineIds: [],
        evidenceQuote: layout.blanks.find((x) => x.subquestionId === sq.id)?.extractedAnswer ?? "",
        reason: "整卷初检确认正确并通过本地硬校验",
        confidence: layout.blanks.find((x) => x.subquestionId === sq.id)?.confidence ?? 1,
        requiresReview: false
      }))
    );

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
      durationMs: layoutDurationMs,
      unreadableReviewThreshold: config.unreadableReviewThreshold,
      operationId,
      previousResultId: input.previousResultId,
      regradedAt: input.regradedAt,
      regradeReason: input.regradeReason
    });

    result.gradingPipeline = "small_question_staged";
    result.imagePreprocessAudit = preparedStudentAnswer.preparation.audit;
    result.smallQuestionAudit = {
      pipeline: "staged_vision_crops",
      layoutDurationMs,
      dualRecognitionDurationMs: 0,
      escalatedReviewDurationMs: 0,
      crops: cropAudits,
      recognitions: recognitionAudits
    };
    result.teacherCommentary = createFallbackTeacherCommentary(result);

    completeOperation(operationId, "grading", "grading_completed", `${input.studentId}小题满分快速放行完成：${result.score}/${result.maxScore}分`, {
      status: result.status,
      gradingPipeline: "small_question_staged",
      reviewReasons: result.reviewReasons.length,
      cropsCount: cropAudits.length,
      scoreResolved: result.scoreResolved
    });

    return result;
  }

  // ----------------------------------------------------
  // 阶段 2：Sharp 局部高清大图裁切
  // ----------------------------------------------------
  const crops: BlankCropInternal[] = [];
  const cropAudits: SmallQuestionBlankCropAudit[] = [];
  const cropContextMap = buildBlankLayoutContextMap(layout.blanks);

  for (const sq of input.rubric.subquestions) {
    const blank = layout.blanks.find((b) => b.subquestionId === sq.id);
    const finalAnswers = sq.finalAnswers ?? [];
    const domain = detectBlankDomain(finalAnswers);
    if (!blank || !blank.coordinate || !blank.hasAnswer || !imageWidth || !imageHeight) {
      crops.push({
        subquestionId: sq.id,
        title: sq.title,
        finalAnswers,
        domain,
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

    const cropBox = computeSafeCropBox(blank.coordinate, imageWidth, imageHeight, cropContextMap.get(sq.id));
    const width = cropBox.width;
    const height = cropBox.height;

    let cropBuffer: Buffer;
    try {
      cropBuffer = await sharp(studentImage.buffer)
        .extract({ left: cropBox.left, top: cropBox.top, width: cropBox.width, height: cropBox.height })
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
      domain,
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
  // 阶段 3 & 4：正交双路并发识别 (盲审 A + 挑刺 B) 与按需深度复检 C (跨空全并发)
  // ----------------------------------------------------
  const dualStart = performance.now();
  let escalatedReviewTotalDurationMs = 0;

  const cropResults = await Promise.all(
    crops.map(async (crop) => {
      throwIfOperationCancelled(operationId);

      const layoutBlank = layout.blanks.find((x) => x.subquestionId === crop.subquestionId);

      // 判空快速短路
      if (!crop.hasAnswer) {
        return {
          finalJudgement: {
            subquestionId: crop.subquestionId,
            status: "missing" as FinalAnswerStatus,
            answerPresence: "no_effective_answer" as AnswerPresence,
            evidenceLineIds: [],
            studentAnswer: "",
            referenceAnswer: formatFinalAnswers(crop.finalAnswers),
            reason: "该空经原生版面定位确认未作答，未检测到任何有效手写笔迹",
            confidence: 1,
            decisionSource: "teacher_model" as const
          },
          recognitionAudit: {
            subquestionId: crop.subquestionId,
            blindTranscriber: { extractedAnswer: "", confidence: 1 },
            skepticAssessor: { extractedAnswer: "", status: "missing" as const, confidence: 1, issues: [], reason: "未作答" },
            comparisonStatus: "consensus" as const,
            finalStatus: "missing" as FinalAnswerStatus,
            finalAnswer: "",
            finalConfidence: 1,
            decisionSource: "blank_missing" as const
          },
          escalatedDurationMs: 0
        };
      }

      const validation = fastPassValidationResults.get(crop.subquestionId);
      if (validation?.pass) {
        logProgress(operationId, "grading", "small_question_blank_accepted_from_triage", `${crop.title}初检确认正确并通过本地硬校验，已直接采信放行（免除二次切片复验）`, {
          subquestionId: crop.subquestionId,
          studentAnswer: layoutBlank?.extractedAnswer || "",
          confidence: layoutBlank?.confidence || 1
        });
        return {
          finalJudgement: {
            subquestionId: crop.subquestionId,
            status: "correct" as FinalAnswerStatus,
            answerPresence: "confirmed_answer" as AnswerPresence,
            evidenceLineIds: [],
            studentAnswer: layoutBlank?.extractedAnswer || "",
            referenceAnswer: formatFinalAnswers(crop.finalAnswers),
            reason: `初检确认正确并通过本地硬校验: ${layoutBlank?.reason || layoutBlank?.extractedAnswer || ""}`,
            confidence: layoutBlank?.confidence || 1,
            decisionSource: "teacher_model" as const
          },
          recognitionAudit: {
            subquestionId: crop.subquestionId,
            blindTranscriber: { extractedAnswer: layoutBlank?.extractedAnswer || "", confidence: layoutBlank?.confidence || 1 },
            skepticAssessor: {
              extractedAnswer: layoutBlank?.extractedAnswer || "",
              status: "correct" as const,
              confidence: layoutBlank?.confidence || 1,
              issues: [],
              reason: layoutBlank?.reason || "初检正确并通过本地硬校验"
            },
            comparisonStatus: "consensus" as const,
            finalStatus: "correct" as FinalAnswerStatus,
            finalAnswer: layoutBlank?.extractedAnswer || "",
            finalConfidence: layoutBlank?.confidence || 1,
            decisionSource: "consensus_ab" as const
          },
          escalatedDurationMs: 0
        };
      }

      const imagePayload = [{
        mimeType: "image/webp",
        base64: crop.cropBase64
      }];

      let domainGuidanceB = "";
      if (crop.domain === "choice_letter") {
        domainGuidanceB = `\n【选择题阅卷善意推定与排除法原则】：
1. 物理阅卷考查学科理解而非书法比赛，对笔迹应秉持考场善意推定原则；
2. 中学生在快速书写选项大写字母时常有明显草写变形（例如字母 A 常有左竖右弧圈、手写体 a、α 式运笔，或单笔环连）；
3. 判定重点在于“排除实质错误”：重点排查考生是否明确选择了其他相冲突的选项（如明确写了 B、C、D），或存在严重涂改冲突；
4. 若卷面无涂改，且未观察到考生明确选择了其他相冲突选项的特征，整体笔势符合参考答案（${formatFinalAnswers(crop.finalAnswers)}），应认定为满足评分要求（status: correct），严禁因非标准印刷体字形苛求扣分；
5. 【涂改划掉排除与防拼接错觉】：考生写错后常在字符上打单竖线、斜线或横杠划掉作废。已被划掉作废的选项绝不应计入有效作答，且【严禁将划线与原字符机械拼接误读为新字母】（极其典型多模态错觉：在字母 C 上打竖线划掉，极易被机械识别误读为字母 D 或 d！严禁犯此错误！若考生写了 AB 并划掉了 C，有效作答为 AB，绝非 ABD；若考生写了 C 划掉改写 A，有效作答为 A）。`;
      } else if (crop.domain === "formula") {
        domainGuidanceB = `\n【字母公式题阅卷准则与代数等价放行原则】：
1. 代数恒等放行：凡在数学/物理上代数恒等的形式（包括乘除系数提取如 1/2*at^2 与 at^2/2、因式展开与合并如 mg(1-cosθ) 与 mg-mg*cosθ、分式与斜杠表达如 U/I 与 \\frac{U}{I}、加减乘项顺序交换等），只要使用的物理量符号符合要求，必须无条件判定为 correct；
2. 物理量已知量先验：结合高中物理常见符号，对书写形似字符采取善意对齐（例如：表达式中的重力加速度 g 尾部带勾不应误判为数字 9 或 q；长度 l 不应误判为 1；速度 v 不应误判为 u）；
3. 容差与排除法：若根号线、分数线略短但覆盖范围无歧义，或上下标略有下沉但无其他物理含义，应认定为正确；仅在表达式存在物理量缺失、错误运算、量纲不符或明显涂改冲突时，才判定为错误。`;
      } else if (crop.domain === "numeric") {
        domainGuidanceB = `\n【数值题阅卷准则】：
重点排查数值大小是否正确、有效数字位数是否满足评分要求、小数点位置是否明确。连笔造成的轻微笔迹粘连或拖尾（如末位0与8连笔略扁），只要能辨识出对应数字且符合有效数字要求，应倾向于认定正确。`;
      }

      const initialSummary = layoutBlank
        ? `\n【整卷全景初检（首评）识别结果参考】：
- 全景初检识别作答：${layoutBlank.extractedAnswer ? `"${layoutBlank.extractedAnswer}"` : "（未提取到有效作答字符）"}
- 全景初检判定状态：${layoutBlank.status}（置信度: ${layoutBlank.confidence ?? "未标明"}）
${layoutBlank.reason ? `- 全景初检判定依据：${layoutBlank.reason}\n` : ""}${layoutBlank.issues?.length ? `- 全景初检记录疑点：${layoutBlank.issues.join("; ")}\n` : ""}
【重要核验与切片防御要求】：
1. 若切片中看似空白或未见笔迹，但全景初检明确检测到手写作答（如提取为"${layoutBlank.extractedAnswer || ""}"）：极可能是切片算法定位偏移、坐标框偏或切到了空白区域！请在 issues 中明确指出“切片未见有效笔迹/疑似裁切偏离，与初检识别到'${layoutBlank.extractedAnswer}'不符”，并在 reason 中详细说明，切勿盲目直接判空！
2. 若切片中可见完整手写作答，请严格对照参考答案独立挑刺审查，验证初检结论是否成立。`
        : "";

      // 挑刺 B：对照参考答案与评分要求审验
      const promptSkeptic = `请依据高中物理阅卷标准审查该切片中学生手写作答与参考答案及评分要求。
对应小题：${crop.title}
参考答案（满足任一即为正确）：${formatFinalAnswers(crop.finalAnswers)}
${crop.criteriaGuidance ? `评分规则与特殊要求：${crop.criteriaGuidance}\n` : ""}${domainGuidanceB}${initialSummary}
要求：
1. 仔细核对学生作答是否符合参考答案与评分要求；
2. 排查实质性错误（如选错选项、物理符号实质错误、代数表达式不等价、有效数字位数错误、运算错误或涂改未清）；
3. 发现任何明确实质性瑕疵在 issues 中列出，若完全符合或笔势合理支持正确答案则判定为 correct；
4. 明确评估影响打分可靠性的风险点（riskPoints）：若切片视野完整、字迹清晰无任何风险，必须填 ["无"]；若存在影响判分可靠性的确凿问题，从枚举项中选取（"切片截断"、"严重涂改"、"符号歧义"、"字迹难辨"）。若无风险请标无，绝不无故复核。`;

      const blindReviewEnabled = config.smallQuestionBlindReviewEnabled !== false;

      // 若在设置中关闭了盲审，直接调用挑刺审查 B
      if (!blindReviewEnabled) {
        logProgress(operationId, "grading", "small_question_blank_targeted_review", `${crop.title}初检未达放行门禁(${validation?.reason || "存疑/错误"})，盲审已在设置中关闭，直接进入切片挑刺审查`, {
          subquestionId: crop.subquestionId,
          triggerReason: validation?.reason
        });

        const responseB = await callStructured(skepticRoute.config, {
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
        });
        throwIfOperationCancelled(operationId);

        const resB = smallQuestionSkepticAssessorSchema.parse(responseB.data);

        // 校验初审全图与切片审查 B 是否存在冲突或截断异常
        const discrepancy = detectInitialVsSkepticDiscrepancy(layoutBlank, resB);

        if (discrepancy.isDiscrepant) {
          logProgress(operationId, "grading", "small_question_discrepancy_detected", `${crop.title}初检全图(${layoutBlank?.status}: "${layoutBlank?.extractedAnswer}")与切片审查(${resB.status}: "${resB.extractedAnswer}")存在冲突，强制调起深度终审模型进行双重视角仲裁`, {
            subquestionId: crop.subquestionId,
            statusInit: layoutBlank?.status,
            extractedInit: layoutBlank?.extractedAnswer,
            statusB: resB.status,
            extractedB: resB.extractedAnswer,
            issuesB: resB.issues,
            triggerReason: discrepancy.reason
          }, "info");

          const domainGuardC = buildDomainGuardC(crop.domain, crop.finalAnswers);
          const comparisonDetails = [
            `- 整卷全景初检（全图视角）：识别为 "${layoutBlank?.extractedAnswer || ""}"（判定状态: ${layoutBlank?.status || "未知"}, 置信度: ${layoutBlank?.confidence ?? "未知"}, 说明: "${layoutBlank?.reason || ""}"）`,
            `- 切片挑刺审查（局部切片）：识别为 "${resB.extractedAnswer}"（判定状态: ${resB.status}, 置信度: ${resB.confidence}, 疑点: ${resB.issues.join("; ") || "无"}, 说明: "${resB.reason || ""}"）`
          ].join("\n");

          const promptC = buildEscalatedReviewPrompt({
            title: crop.title,
            finalAnswers: crop.finalAnswers,
            criteriaGuidance: crop.criteriaGuidance,
            domainGuardC,
            comparisonDetails,
            triggerReason: discrepancy.reason
          });

          const dualImagesPayload = [...imagePayload, ...preparedStudentAnswer.modelImages];
          const cStart = performance.now();
          const responseC = await callStructured(reviewRoute.config, {
            model: reviewRoute.model,
            routeKey: reviewRoute.routeKey,
            system: getBuiltInSystemPrompt(reviewRoute.routeKey),
            prompt: promptC,
            images: dualImagesPayload,
            schemaName: "small_question_escalated_review",
            schema: smallQuestionEscalatedReviewJsonSchema,
            validate: (val) => smallQuestionEscalatedReviewSchema.parse(val),
            reasoningEffort: "high",
            operationId
          });
          throwIfOperationCancelled(operationId);
          const cDuration = Math.round(performance.now() - cStart);

          const resC = smallQuestionEscalatedReviewSchema.parse(responseC.data);
          const finalConfirmedStatus: FinalAnswerStatus = resC.status;
          const presence: AnswerPresence = finalConfirmedStatus === "missing" ? "no_effective_answer" : "confirmed_answer";

          return {
            finalJudgement: {
              subquestionId: crop.subquestionId,
              status: finalConfirmedStatus,
              answerPresence: presence,
              evidenceLineIds: [],
              studentAnswer: resC.finalExtractedAnswer,
              referenceAnswer: formatFinalAnswers(crop.finalAnswers),
              reason: `初审与挑刺冲突触发终审裁决: ${resC.resolutionReason}`,
              confidence: resC.confidence,
              decisionSource: "visual_local_review" as const
            },
            recognitionAudit: {
              subquestionId: crop.subquestionId,
              blindTranscriber: {
                extractedAnswer: "",
                confidence: 0,
                rawText: `盲审已关闭(初审全图"${layoutBlank?.extractedAnswer}"与切片审查"${resB.extractedAnswer}"冲突触发双重视角终审)`
              },
              skepticAssessor: {
                extractedAnswer: resB.extractedAnswer,
                status: resB.status,
                confidence: resB.confidence,
                issues: resB.issues,
                reason: resB.reason,
                riskPoints: resB.riskPoints
              },
              comparisonStatus: "discrepancy" as const,
              escalatedReview: {
                finalExtractedAnswer: resC.finalExtractedAnswer,
                status: resC.status,
                confidence: resC.confidence,
                visualAnalysis: resC.visualAnalysis,
                resolutionReason: resC.resolutionReason,
                riskPoints: resC.riskPoints
              },
              finalStatus: finalConfirmedStatus,
              finalAnswer: resC.finalExtractedAnswer,
              finalConfidence: resC.confidence,
              finalRiskPoints: resC.riskPoints,
              decisionSource: "escalated_review_c" as const
            },
            escalatedDurationMs: cDuration
          };
        }

        const finalStatus: FinalAnswerStatus = resB.status;
        const presence: AnswerPresence = finalStatus === "missing" ? "no_effective_answer" : "confirmed_answer";

        logProgress(operationId, "grading", "small_question_blank_skeptic_direct", `${crop.title}盲审已关闭且初审与挑刺无冲突，直接采信挑刺审查结论 (${resB.status}: ${resB.extractedAnswer})`, {
          subquestionId: crop.subquestionId,
          status: resB.status,
          extractedAnswer: resB.extractedAnswer,
          confidence: resB.confidence,
          issues: resB.issues
        });

        return {
          finalJudgement: {
            subquestionId: crop.subquestionId,
            status: finalStatus,
            answerPresence: presence,
            evidenceLineIds: [],
            studentAnswer: resB.extractedAnswer,
            referenceAnswer: formatFinalAnswers(crop.finalAnswers),
            reason: `挑刺审查直接采信(盲审已关闭): ${resB.reason || resB.extractedAnswer || ""}`,
            confidence: resB.confidence,
            decisionSource: "teacher_model" as const
          },
          recognitionAudit: {
            subquestionId: crop.subquestionId,
            blindTranscriber: { extractedAnswer: "", confidence: 0, rawText: "盲审已关闭" },
            skepticAssessor: {
              extractedAnswer: resB.extractedAnswer,
              status: resB.status,
              confidence: resB.confidence,
              issues: resB.issues,
              reason: resB.reason,
              riskPoints: resB.riskPoints
            },
            comparisonStatus: "consensus" as const,
            finalStatus,
            finalAnswer: resB.extractedAnswer,
            finalConfidence: resB.confidence,
            finalRiskPoints: resB.riskPoints,
            decisionSource: "skeptic_direct" as const
          },
          escalatedDurationMs: 0
        };
      }

      logProgress(operationId, "grading", "small_question_blank_targeted_review", `${crop.title}初检未达放行门禁(${validation?.reason || "存疑/错误"})，正在进入切片盲审与挑刺规范流程`, {
        subquestionId: crop.subquestionId,
        triggerReason: validation?.reason
      });

      let domainHintA = "";
      if (crop.domain === "choice_letter") {
        domainHintA = `\n【题型与字符域提示】：本空为选择题，考生的合法作答预期为单字母选项（如 A、B、C、D 等）。
请仔细观察手写笔迹，重点辨别考生的单字母书写意图。注意区分中学生快速答题时的常见草写习惯（如左竖右弧圈、单笔开环或手写体a形态），严禁脱离单选题背景将单字母潦草笔迹误读为多位数字。`;
      } else if (crop.domain === "formula") {
        domainHintA = `\n【题型与字符域提示】：本空为物理量/字母代数式公式填空，作答预期为物理字母、公式表达式（包含分式、根式、上下标、希腊字母等）。
请输出标准 LaTeX 表达式。仔细区分物理常用字母与相近数字（例如：重力加速度 g 与数字 9/字母 q、长度 l 与数字 1/大写 I、时间 t 与加号 +、速度 v 与 u/ν）；即使上下标位置略有平移（如 v0、t2），亦请客观按物理公式逻辑识别规范上下标。`;
      } else if (crop.domain === "numeric") {
        domainHintA = `\n【题型与字符域提示】：本空为数值计算或读数填空，作答预期为纯数字（包含小数点、负号或有效数字尾数0）。
请客观照实记录数字与有效数字位数，注意区分笔画闭合。`;
      } else if (crop.domain === "chinese_text") {
        domainHintA = `\n【题型与字符域提示】：本空为文字/物理术语填空，作答预期为汉字词语。请照实识别汉字笔迹。`;
      }

      // 盲审 A：严禁给出参考答案
      const promptBlind = `请客观像素级识别该切片中学生实际写出的答案。
对应小题：${crop.title}${domainHintA}

要求：
1. 仔细观察手写笔迹，严格照实输出字符、数字或公式；
2. 严禁主观猜测，严禁根据外部经验纠正或补写学生笔迹；
3. 给出识别出的完整手写作答与置信度。`;

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
      // 本地比对与一致性校验：首评、A、B 三者识别到的内容均一致才达成共识结案，否则调起 C
      // ----------------------------------------------------
      const consensus = checkThreeWayConsensus({
        layoutBlank,
        resA,
        resB,
        finalAnswers: crop.finalAnswers
      });
      const isConsistent = consensus.isConsistent;
      const localComparisonReason = consensus.reason;

      // 分歧处理与深度终审 C（仅在 A 与 B 意见不一致时触发）
      if (!isConsistent) {
        const initialDiscrepancy = detectInitialVsSkepticDiscrepancy(layoutBlank, resB);
        const effectiveTriggerReason = initialDiscrepancy.isDiscrepant
          ? `${localComparisonReason}；${initialDiscrepancy.reason}`
          : localComparisonReason;

        logProgress(operationId, "grading", "small_question_discrepancy_detected", `${crop.title}初检出现分歧或疑点，正在调起思考预算拉满的深度终审模型(同时传入切片与全景)`, {
          subquestionId: crop.subquestionId,
          extractedA: resA.extractedAnswer,
          extractedB: resB.extractedAnswer,
          statusB: resB.status,
          issuesB: resB.issues,
          triggerReason: effectiveTriggerReason
        }, "info");

        const domainGuardC = buildDomainGuardC(crop.domain, crop.finalAnswers);
        const comparisonDetails = [
          `- 盲审转录（不知参考答案）识别为: "${resA.extractedAnswer}" (置信度: ${resA.confidence})`,
          `- 挑刺审查（已知参考答案）识别为: "${resB.extractedAnswer}" (判定: ${resB.status}, 置信度: ${resB.confidence}, 疑点: ${resB.issues.join("; ") || "无"})`,
          layoutBlank ? `- 整卷全景初检识别为: "${layoutBlank.extractedAnswer}" (判定: ${layoutBlank.status}, 置信度: ${layoutBlank.confidence})` : ""
        ].filter(Boolean).join("\n");

        const promptC = buildEscalatedReviewPrompt({
          title: crop.title,
          finalAnswers: crop.finalAnswers,
          criteriaGuidance: crop.criteriaGuidance,
          domainGuardC,
          comparisonDetails,
          triggerReason: effectiveTriggerReason
        });

        const dualImagesPayload = [...imagePayload, ...preparedStudentAnswer.modelImages];
        const cStart = performance.now();
        const responseC = await callStructured(reviewRoute.config, {
          model: reviewRoute.model,
          routeKey: reviewRoute.routeKey,
          system: getBuiltInSystemPrompt(reviewRoute.routeKey),
          prompt: promptC,
          images: dualImagesPayload,
          schemaName: "small_question_escalated_review",
          schema: smallQuestionEscalatedReviewJsonSchema,
          validate: (val) => smallQuestionEscalatedReviewSchema.parse(val),
          reasoningEffort: "high",
          operationId
        });
        throwIfOperationCancelled(operationId);
        const cDuration = Math.round(performance.now() - cStart);

        const resC = smallQuestionEscalatedReviewSchema.parse(responseC.data);
        const finalConfirmedStatus: FinalAnswerStatus = resC.status;
        const presence: AnswerPresence = finalConfirmedStatus === "missing" ? "no_effective_answer" : "confirmed_answer";

        return {
          finalJudgement: {
            subquestionId: crop.subquestionId,
            status: finalConfirmedStatus,
            answerPresence: presence,
            evidenceLineIds: [],
            studentAnswer: resC.finalExtractedAnswer,
            referenceAnswer: formatFinalAnswers(crop.finalAnswers),
            reason: `终审裁决(${resC.resolutionReason})`,
            confidence: resC.confidence,
            decisionSource: "visual_local_review" as const
          },
          recognitionAudit: {
            subquestionId: crop.subquestionId,
            blindTranscriber: { extractedAnswer: resA.extractedAnswer, confidence: resA.confidence },
            skepticAssessor: {
              extractedAnswer: resB.extractedAnswer,
              status: resB.status,
              confidence: resB.confidence,
              issues: resB.issues,
              reason: resB.reason,
              riskPoints: resB.riskPoints
            },
            comparisonStatus: "discrepancy" as const,
            escalatedReview: {
              finalExtractedAnswer: resC.finalExtractedAnswer,
              status: resC.status,
              confidence: resC.confidence,
              visualAnalysis: resC.visualAnalysis,
              resolutionReason: resC.resolutionReason,
              riskPoints: resC.riskPoints
            },
            finalStatus: finalConfirmedStatus,
            finalAnswer: resC.finalExtractedAnswer,
            finalConfidence: resC.confidence,
            finalRiskPoints: resC.riskPoints,
            decisionSource: "escalated_review_c" as const
          },
          escalatedDurationMs: cDuration
        };
      } else {
        // 双路完全一致放行（AB意见一致，绝不调用 C；无论判定为正确、错误还是未作答）
        const finalStatus: FinalAnswerStatus = resB.status;
        const presence: AnswerPresence = finalStatus === "missing" ? "no_effective_answer" : "confirmed_answer";
        const statusText = finalStatus === "correct" ? "正确" : finalStatus === "missing" ? "未作答" : "错误";
        return {
          finalJudgement: {
            subquestionId: crop.subquestionId,
            status: finalStatus,
            answerPresence: presence,
            evidenceLineIds: [],
            studentAnswer: resB.extractedAnswer,
            referenceAnswer: formatFinalAnswers(crop.finalAnswers),
            reason: `正交双路一致采信: 盲审与挑刺均认定为${statusText}作答(${resB.extractedAnswer})`,
            confidence: Math.max(resA.confidence, resB.confidence),
            decisionSource: "teacher_model" as const
          },
          recognitionAudit: {
            subquestionId: crop.subquestionId,
            blindTranscriber: { extractedAnswer: resA.extractedAnswer, confidence: resA.confidence },
            skepticAssessor: {
              extractedAnswer: resB.extractedAnswer,
              status: resB.status,
              confidence: resB.confidence,
              issues: resB.issues,
              reason: resB.reason,
              riskPoints: resB.riskPoints
            },
            comparisonStatus: "consensus" as const,
            finalStatus,
            finalAnswer: resB.extractedAnswer,
            finalConfidence: Math.max(resA.confidence, resB.confidence),
            finalRiskPoints: resB.riskPoints,
            decisionSource: "consensus_ab" as const
          },
          escalatedDurationMs: 0
        };
      }
    })
  );

  const finalJudgements = cropResults.map((r) => r.finalJudgement);
  const recognitionAudits = cropResults.map((r) => r.recognitionAudit);
  for (const r of cropResults) {
    escalatedReviewTotalDurationMs += r.escalatedDurationMs;
  }

  const dualRecognitionDurationMs = Math.round(performance.now() - dualStart);

  // ----------------------------------------------------
  // ----------------------------------------------------
  // 阶段 5：本地权威计分与高风险防御性门禁
  // ----------------------------------------------------
  const allCollectedRiskReasons: string[] = [];

  // 为小题生成各小问决策列表（最终答案 correct 无条件满分，同时拦截物理视野/截断/低置信度高风险项）
  const decisions = input.rubric.subquestions.flatMap((sq: Rubric["subquestions"][number]) => {
    const judgement = finalJudgements.find((j) => j.subquestionId === sq.id);
    const recognitionAudit = recognitionAudits.find((a) => a.subquestionId === sq.id);
    const cropAudit = cropAudits.find((c) => c.subquestionId === sq.id);
    const isCorrect = judgement?.status === "correct";

    const risk = detectBlankHighRiskSignals({
      subquestionTitle: sq.title,
      judgement,
      recognitionAudit,
      cropAudit
    });

    if (risk.requiresReview) {
      allCollectedRiskReasons.push(...risk.riskReasons);
    }

    const requiresReview = Boolean(risk.requiresReview || judgement?.status === "uncertain");
    const reviewReason = risk.riskReasons.join("；") || (judgement?.status === "uncertain" ? `${sq.title}判定存疑，需人工复核` : undefined);

    return sq.scorePoints.map((point: Rubric["subquestions"][number]["scorePoints"][number]) => ({
      subquestionId: sq.id,
      pointId: point.id,
      status: isCorrect ? ("satisfied" as const) : ("not_satisfied" as const),
      evidenceLineIds: [],
      evidenceQuote: judgement?.studentAnswer ?? "",
      reason: judgement?.reason ?? "小题直接判定",
      confidence: judgement?.confidence ?? 1,
      requiresReview,
      reviewReason,
      decisionSource: requiresReview ? ("small_question_risk_guard" as const) : ("model" as const)
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
    regradeReason: input.regradeReason,
    initialReviewReasons: allCollectedRiskReasons
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

  // 双重保证所有风险原因被完整收集入 reviewReasons（去重）
  for (const reason of allCollectedRiskReasons) {
    if (!result.reviewReasons.includes(reason)) {
      result.reviewReasons.push(reason);
    }
  }

  for (const rec of recognitionAudits) {
    if (rec.escalatedReview && rec.finalStatus === "uncertain") {
      if (rec.escalatedReview.resolutionReason && !result.reviewReasons.includes(rec.escalatedReview.resolutionReason)) {
        result.reviewReasons.push(rec.escalatedReview.resolutionReason);
      }
    }
  }

  // 关键保证：若存在任何复核原因，status 必须同步为 needs_review
  if (result.reviewReasons.length > 0) {
    result.status = "needs_review";
    logProgress(operationId, "grading", "small_question_high_risk_flagged", `${input.studentId}触发高风险复核门禁(${result.reviewReasons.length}项疑点)，已标记为待复核卷(needs_review)`, {
      reviewReasons: result.reviewReasons
    }, "warning");
  }

  // 检查是否全对快速通道（仅在无任何复核原因时方可触发）
  const allCorrect = input.rubric.subquestions.length > 0 &&
    finalJudgements.length === input.rubric.subquestions.length &&
    finalJudgements.every((j) => j.status === "correct") &&
    result.reviewReasons.length === 0;

  if (allCorrect) {
    logProgress(operationId, "grading", "small_question_all_correct_fast_path", `全卷各空均判定正确且无高风险疑点，成功触发小题满分快速通道（${result.score}/${result.maxScore}分）`, {
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
