import type {
  ModelConfigInput,
  ModelRouteConfig,
  ModelRouteEndpoint,
  ModelRouteKey
} from "./types.js";

export interface ModelRouteDefinition {
  key: ModelRouteKey;
  label: string;
  description: string;
  endpoint: ModelRouteEndpoint;
  modelField: "visionModel" | "textModel" | "reviewModel";
  modality: "vision" | "text";
  active: boolean;
}

/**
 * The list is shared by the UI and the server so a selectable route always
 * corresponds to a real call-site key. Legacy routes remain defined for
 * migration/audit, but are not shown in the normal settings page.
 */
export const MODEL_ROUTE_DEFINITIONS: readonly ModelRouteDefinition[] = [
  {
    key: "rubric_structure_vision",
    label: "评分标准结构化（含图片）",
    description: "读取题目图片和参考答案图片并生成评分标准",
    endpoint: "teacher",
    modelField: "visionModel",
    modality: "vision",
    active: true
  },
  {
    key: "rubric_structure_text",
    label: "评分标准结构化（纯文字）",
    description: "没有题目图片时使用题目和参考答案文字",
    endpoint: "teacher",
    modelField: "textModel",
    modality: "text",
    active: true
  },
  {
    key: "rubric_refinement",
    label: "评分标准完善",
    description: "根据教师补充要求修改评分标准草稿",
    endpoint: "teacher",
    modelField: "textModel",
    modality: "text",
    active: true
  },
  {
    key: "large_question_answer_triage",
    label: "大题首轮最终答案判定",
    description: "结合预处理答卷图和 OCR bbox，只确认每个小问最终答案",
    endpoint: "teacher",
    modelField: "visionModel",
    modality: "vision",
    active: true
  },
  {
    key: "large_question_layout_detection",
    label: "大题模型原生视觉分块",
    description: "免 PaddleOCR 时直接对答卷进行视觉版面分析、作答区域与边界框定位",
    endpoint: "teacher",
    modelField: "visionModel",
    modality: "vision",
    active: true
  },
  {
    key: "large_question_responses_agent",
    label: "大题 Responses Agent 主教师",
    description: "无 OCR 的整页视觉判定，按需调用只读局部放大工具并继续判断",
    endpoint: "teacher",
    modelField: "visionModel",
    modality: "vision",
    active: true
  },
  {
    key: "large_question_visual_review",
    label: "大题最终答案局部复核",
    description: "复核判错、判空或不确定的最终答案",
    endpoint: "review",
    modelField: "reviewModel",
    modality: "vision",
    active: true
  },
  {
    key: "large_question_point_review",
    label: "大题评分点审验",
    description: "复核指定小问的过程评分点和扣分规则",
    endpoint: "review",
    modelField: "reviewModel",
    modality: "vision",
    active: true
  },
  {
    key: "small_question_reconstruction",
    label: "小题卷面作答还原",
    description: "依据预处理答卷图和 OCR 还原学生实际写出的内容",
    endpoint: "teacher",
    modelField: "visionModel",
    modality: "vision",
    active: true
  },
  {
    key: "small_question_grading_vision",
    label: "小题评分（含题图）",
    description: "题目或参考答案包含图片时使用",
    endpoint: "teacher",
    modelField: "visionModel",
    modality: "vision",
    active: true
  },
  {
    key: "small_question_grading_text",
    label: "小题评分（纯文字）",
    description: "题目和参考答案均为文字时使用",
    endpoint: "teacher",
    modelField: "textModel",
    modality: "text",
    active: true
  },
  {
    key: "legacy_direct_visual_grading",
    label: "旧版整题视觉直批",
    description: "旧版兼容实现，不在新版设置页显示",
    endpoint: "teacher",
    modelField: "visionModel",
    modality: "vision",
    active: false
  },
  {
    key: "legacy_evidence_extraction",
    label: "旧版卷面证据提取",
    description: "旧版兼容实现，不在新版设置页显示",
    endpoint: "teacher",
    modelField: "visionModel",
    modality: "vision",
    active: false
  },
  {
    key: "legacy_final_answer",
    label: "旧版最终答案判定",
    description: "旧版兼容实现，不在新版设置页显示",
    endpoint: "teacher",
    modelField: "visionModel",
    modality: "vision",
    active: false
  },
  {
    key: "legacy_process_review",
    label: "旧版过程评分审验",
    description: "旧版兼容实现，不在新版设置页显示",
    endpoint: "teacher",
    modelField: "visionModel",
    modality: "vision",
    active: false
  },
  {
    key: "legacy_unreadable_review",
    label: "旧版无法辨认局部复核",
    description: "旧版兼容实现，不在新版设置页显示",
    endpoint: "review",
    modelField: "reviewModel",
    modality: "vision",
    active: false
  },
  {
    key: "legacy_numeric_review",
    label: "旧版数值答案复核",
    description: "旧版兼容实现，不在新版设置页显示",
    endpoint: "review",
    modelField: "reviewModel",
    modality: "vision",
    active: false
  }
] as const;

export const ACTIVE_MODEL_ROUTE_DEFINITIONS = MODEL_ROUTE_DEFINITIONS.filter((item) => item.active);

/**
 * Apply an optional per-route prompt adjustment while preserving the built-in
 * prompt by default. Appending is the safe default because it keeps the
 * workflow's role, evidence and output constraints intact.
 */
export function applyModelRouteSystemPrompt(
  defaultPrompt: string,
  route: Pick<ModelRouteConfig, "systemPrompt" | "systemPromptMode"> | undefined
): string {
  const customPrompt = route?.systemPrompt?.trim();
  if (!customPrompt) return defaultPrompt;
  if (route?.systemPromptMode === "replace") return customPrompt;
  return `${defaultPrompt}\n\n【教师模型设置·本步骤追加指令】\n${customPrompt}`;
}

export function createDefaultModelRoutes(input: Pick<ModelConfigInput, "visionModel" | "textModel" | "reviewModel" | "teacherReasoningEffort" | "reviewReasoningEffort">): Record<ModelRouteKey, ModelRouteConfig> {
  return Object.fromEntries(MODEL_ROUTE_DEFINITIONS.map((definition) => {
    const model = input[definition.modelField]?.trim() ?? "";
    return [definition.key, {
      endpoint: definition.endpoint,
      model
    } satisfies ModelRouteConfig];
  })) as Record<ModelRouteKey, ModelRouteConfig>;
}

export function mergeModelRoutes(
  input: Pick<ModelConfigInput, "visionModel" | "textModel" | "reviewModel" | "teacherReasoningEffort" | "reviewReasoningEffort"> & { modelRoutes?: Partial<Record<ModelRouteKey, ModelRouteConfig>> }
): Record<ModelRouteKey, ModelRouteConfig> {
  const defaults = createDefaultModelRoutes(input);
  for (const definition of MODEL_ROUTE_DEFINITIONS) {
    const configured = input.modelRoutes?.[definition.key];
    if (!configured) continue;
    defaults[definition.key] = {
      ...defaults[definition.key],
      ...configured,
      // An empty per-route field means "inherit the legacy/global default".
      // This also keeps a deliberately unconfigured review route serializable;
      // the resolver will mark it for review only if that route is needed.
      model: configured.model.trim() || defaults[definition.key].model
    };
  }
  return defaults;
}
