import { useState } from "react";
import { ACTIVE_MODEL_ROUTE_DEFINITIONS } from "../shared/modelRouting";
import { getBuiltInSystemPrompt, getBuiltInSystemPromptVariants } from "../shared/modelPrompts";
import {
  DEFAULT_RESPONSES_AGENT_MAX_OUTPUT_TOKENS,
  DEFAULT_RESPONSES_AGENT_MAX_REGIONS,
  DEFAULT_RESPONSES_AGENT_REASONING_EFFORT,
  DEFAULT_RESPONSES_AGENT_MAX_TOOL_ROUNDS,
  DEFAULT_RESPONSES_AGENT_TIMEOUT_MS,
  MAX_MODEL_SYSTEM_PROMPT_LENGTH,
  MODEL_SYSTEM_PROMPT_MODES,
  TEACHER_REASONING_EFFORTS
} from "../shared/types";
import type {
  ModelConfigInput,
  ModelRouteConfig,
  ModelRouteKey,
  ModelSystemPromptMode,
  ResponsesAgentConfigInput,
  TeacherReasoningEffort
} from "../shared/types";

type SettingsVariant = "web" | "desktop";
type UpdateModelConfig = <K extends keyof ModelConfigInput>(key: K, value: ModelConfigInput[K]) => void;
/**
 * The guardrail flag is optional here so this settings panel stays compatible
 * with configs written by older clients while the shared contract rolls out.
 * The server normalizes it to true when it is absent.
 */
type ResponsesAgentFormConfig = ResponsesAgentConfigInput & { backendGuardrailsEnabled?: boolean };

const reasoningLabels: Record<TeacherReasoningEffort, string> = {
  disabled: "不发送 reasoning_effort",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra"
};

const endpointLabels: Record<ModelRouteConfig["endpoint"], string> = {
  teacher: "教师 API",
  review: "审验 API"
};

const systemPromptModeLabels: Record<ModelSystemPromptMode, string> = {
  append: "追加到内置提示词（推荐）",
  replace: "替换内置提示词（高风险）"
};

const MODEL_ROUTE_GROUPS: ReadonlyArray<{
  key: string;
  label: string;
  description: string;
  routeKeys: readonly ModelRouteKey[];
}> = [
  {
    key: "rubric",
    label: "评分标准",
    description: "生成和完善当前题目的评分标准",
    routeKeys: ["rubric_structure_vision", "rubric_structure_text", "rubric_refinement"]
  },
  {
    key: "large-question",
    label: "大题批改（稳定分阶段）",
    description: "首轮判定后，按需进入视觉复核和评分点审验",
    routeKeys: ["large_question_answer_triage", "large_question_visual_review", "large_question_point_review"]
  },
  {
    key: "small-question",
    label: "小题批改",
    description: "先还原卷面作答，再按材料类型选择评分模型",
    routeKeys: ["small_question_reconstruction", "small_question_grading_vision", "small_question_grading_text"]
  }
];

const routeTriggerLabels: Partial<Record<ModelRouteKey, string>> = {
  rubric_structure_vision: "有题目或参考答案图片时",
  rubric_structure_text: "题目和参考答案均为文字时",
  rubric_refinement: "教师提交完善要求时",
  large_question_layout_detection: "选用模型原生定位时，第一阶段必经",
  large_question_answer_triage: "稳定大题批改首轮，必经",
  large_question_visual_review: "稳定链路首轮判错、判空或不确定时，按需",
  large_question_point_review: "稳定链路首轮判错、判空或不确定的小问，按需",
  small_question_reconstruction: "小题批改第一阶段",
  small_question_grading_vision: "题目或参考答案含图片时",
  small_question_grading_text: "题目和参考答案均为文字时"
};

function routeFallback(form: ModelConfigInput, key: ModelRouteKey): ModelRouteConfig {
  const definition = ACTIVE_MODEL_ROUTE_DEFINITIONS.find((item) => item.key === key);
  if (!definition) return { endpoint: "teacher", model: "" };
  const legacyModel = form[definition.modelField];
  return {
    endpoint: definition.endpoint,
    model: typeof legacyModel === "string" ? legacyModel : ""
  };
}

function routeValue(form: ModelConfigInput, key: ModelRouteKey): ModelRouteConfig {
  return form.modelRoutes?.[key] ?? routeFallback(form, key);
}

function defaultReasoning(form: ModelConfigInput, endpoint: ModelRouteConfig["endpoint"]): TeacherReasoningEffort {
  const configured = endpoint === "review" ? form.reviewReasoningEffort : form.teacherReasoningEffort;
  return configured ?? (endpoint === "review" ? "low" : "disabled");
}

function modelPlaceholder(modelField: "visionModel" | "textModel" | "reviewModel"): string {
  if (modelField === "reviewModel") return "留空继承默认审验模型";
  if (modelField === "textModel") return "留空继承默认文本模型";
  return "留空继承默认视觉模型";
}

function createAgentDefaults(form: ModelConfigInput): ResponsesAgentFormConfig {
  return {
    baseUrl: form.baseUrl || "https://api.openai.com/v1",
    apiKey: "",
    model: form.visionModel || "",
    reasoningEffort: DEFAULT_RESPONSES_AGENT_REASONING_EFFORT,
    timeoutMs: DEFAULT_RESPONSES_AGENT_TIMEOUT_MS,
    maxOutputTokens: DEFAULT_RESPONSES_AGENT_MAX_OUTPUT_TOKENS,
    maxToolRounds: DEFAULT_RESPONSES_AGENT_MAX_TOOL_ROUNDS,
    maxRegions: DEFAULT_RESPONSES_AGENT_MAX_REGIONS,
    backendGuardrailsEnabled: true,
    independentVerifierEnabled: false,
    verifierBaseUrl: "",
    verifierApiKey: "",
    verifierModel: "",
    verifierReasoningEffort: "low"
  };
}

function agentValue(form: ModelConfigInput): ResponsesAgentFormConfig {
  return { ...createAgentDefaults(form), ...(form.responsesAgent ?? {}) };
}

function StaticAgentContract({ variant }: { variant: SettingsVariant }) {
  return <div className={`responses-agent-contract ${variant === "desktop" ? "desktop-responses-agent-contract" : ""}`}>
    <div className="responses-agent-contract-heading"><strong>本链路固定安全边界</strong><span>不可由页面关闭</span></div>
    <div className="responses-agent-contract-list">
      <span><b>Responses API</b> 强制传输，失败不会回退到 Chat Completions</span>
      <span><b>store:false</b>，完整回放记录只保存在本机</span>
      <span><b>严格 JSON Schema</b>，模型只能请求只读局部图工具</span>
      <span><b>无 PaddleOCR</b>，整页视觉判断后按需局部放大</span>
      <span><b>所有模型输入图片 WebP q90</b>，原图仍保留用于审计</span>
    </div>
  </div>;
}

function ResponsesAgentSettings({ form, update, variant }: { form: ModelConfigInput; update: UpdateModelConfig; variant: SettingsVariant }) {
  const agent = agentValue(form);
  const setAgent = (patch: Partial<ResponsesAgentFormConfig>) => {
    const nextAgent: ResponsesAgentFormConfig = { ...agent, ...patch };
    update("responsesAgent", nextAgent);
  };
  const backendGuardrailsEnabled = agent.backendGuardrailsEnabled !== false;
  const fieldClass = variant === "desktop" ? "desktop-form-grid" : "model-route-fields responses-agent-form-grid";
  return <div className={`responses-agent-settings ${variant === "desktop" ? "desktop-responses-agent-settings" : ""}`}>
    <div className="responses-agent-heading">
      <div><span>新链路专用配置</span><strong>Responses Agent · 单主教师模型</strong><small>大题首轮由同一个教师 Agent 看整页、按需读取局部图并继续判断；本轮不启用多子 Agent。</small></div>
      <span className="responses-agent-badge">实验链路</span>
    </div>
    <StaticAgentContract variant={variant} />
    <div className={fieldClass}>
      <label className="wide"><span>Responses API Base URL</span><input value={agent.baseUrl} onChange={(event) => setAgent({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label>
      <label className="wide"><span>独立 Responses API Key</span><input type="password" value={agent.apiKey ?? ""} onChange={(event) => setAgent({ apiKey: event.target.value })} placeholder="填写 Agent 专用密钥；留空保留已保存密钥" /></label>
      <label><span>Agent 模型</span><input value={agent.model} onChange={(event) => setAgent({ model: event.target.value })} placeholder="支持视觉和 Responses API 的模型" /></label>
      <label><span>推理强度</span><select value={agent.reasoningEffort ?? "disabled"} onChange={(event) => setAgent({ reasoningEffort: event.target.value as ResponsesAgentConfigInput["reasoningEffort"] })}>
        {TEACHER_REASONING_EFFORTS.map((effort) => <option value={effort} key={effort}>{effort === "disabled" ? "不发送 reasoning_effort" : effort}</option>)}
      </select></label>
      <label><span>单轮超时（毫秒）</span><input type="number" min={1000} max={300000} value={agent.timeoutMs} onChange={(event) => setAgent({ timeoutMs: Number(event.target.value) })} /></label>
      <label><span>最大输出 Token</span><input type="number" min={256} max={65536} value={agent.maxOutputTokens} onChange={(event) => setAgent({ maxOutputTokens: Number(event.target.value) })} /></label>
    </div>
    <div className="responses-agent-budget">
      <div className="responses-agent-budget-heading"><div><strong>自主局部复核额度</strong><small>模型可自主决定是否放大；达到上限后仍不清晰就返回 uncertain / needs_review。</small></div><span>后端同时强制校验</span></div>
      <div className={fieldClass}>
        <label><span>最多工具轮数</span><input type="number" min={0} max={3} value={agent.maxToolRounds} onChange={(event) => setAgent({ maxToolRounds: Number(event.target.value) })} /><small>允许 0–3，系统上限 3 轮</small></label>
        <label><span>最多局部区域</span><input type="number" min={0} max={6} value={agent.maxRegions} onChange={(event) => setAgent({ maxRegions: Number(event.target.value) })} /><small>允许 0–6，重复区域自动去重</small></label>
      </div>
    </div>
    <div className={`responses-agent-guardrails ${backendGuardrailsEnabled ? "enabled" : "disabled"}`}>
      <div className="responses-agent-guardrails-copy"><strong>后端高风险兜底</strong><small>{backendGuardrailsEnabled ? "已开启：模型先自主判断，后端再对语义高风险结果强制升级，并按设置触发独立审验。" : "已关闭：保留模型自主判断，不再对 incorrect / missing 等语义风险额外强制升级或触发独立审验。"}</small></div>
      <label className="responses-agent-guardrails-toggle"><input aria-label="启用后端高风险兜底" type="checkbox" checked={backendGuardrailsEnabled} onChange={(event) => setAgent({ backendGuardrailsEnabled: event.target.checked })} /><span>{backendGuardrailsEnabled ? "已启用" : "已关闭"}</span></label>
      <small className="responses-agent-guardrails-invariant">无论开关状态，来源与坐标证据、区域合法性、防串卷、后端重算计分，以及写分/提交安全校验都不可关闭。</small>
    </div>
    <div className="responses-agent-tools"><strong>只读工具（固定）</strong><span><code>inspect_page_tiles</code> 按网格查看局部</span><span><code>inspect_page_region</code> 按归一化矩形查看局部</span><small>工具不能修改分数、写网页或提交；每轮可批量请求，所有区域和结果进入审计。</small></div>
    <details className="responses-agent-verifier-settings" open={agent.independentVerifierEnabled}>
      <summary><span><strong>独立高风险审验模型（可选）</strong><small>{agent.independentVerifierEnabled ? (backendGuardrailsEnabled ? "已启用：后端识别到语义高风险时使用全新上下文独立复核" : "已配置但暂不触发：后端高风险兜底已关闭") : "未启用：冲突保留 needs_review，不追加模型调用"}</small></span><input aria-label="启用独立高风险审验模型" type="checkbox" checked={agent.independentVerifierEnabled} onChange={(event) => setAgent({ independentVerifierEnabled: event.target.checked })} /></summary>
      {agent.independentVerifierEnabled && <div className={fieldClass}>
        <label className="wide"><span>独立审验 Responses Base URL</span><input value={agent.verifierBaseUrl ?? ""} onChange={(event) => setAgent({ verifierBaseUrl: event.target.value })} placeholder="留空则使用 Agent Base URL" /></label>
        <label className="wide"><span>独立审验 API Key</span><input type="password" value={agent.verifierApiKey ?? ""} onChange={(event) => setAgent({ verifierApiKey: event.target.value })} placeholder="填写独立审验密钥；留空保留已保存密钥" /></label>
        <label><span>独立审验模型</span><input value={agent.verifierModel ?? ""} onChange={(event) => setAgent({ verifierModel: event.target.value })} placeholder="留空则使用 Agent 模型" /></label>
        <label><span>独立审验推理强度</span><select value={agent.verifierReasoningEffort ?? "low"} onChange={(event) => setAgent({ verifierReasoningEffort: event.target.value as ResponsesAgentConfigInput["verifierReasoningEffort"] })}>
          {TEACHER_REASONING_EFFORTS.map((effort) => <option value={effort} key={effort}>{effort === "disabled" ? "不发送 reasoning_effort" : effort}</option>)}
        </select></label>
        <small className="responses-agent-verifier-note">独立审验只能提出 agree / conflict / uncertain，不会直接改变教师模型分数；冲突仍由后端计分和人工复核规则处理。</small>
      </div>}
    </details>
  </div>;
}

function AgentRoutePromptSettings({ form, update }: { form: ModelConfigInput; update: UpdateModelConfig }) {
  const routeKey: ModelRouteKey = "large_question_responses_agent";
  const route = routeValue(form, routeKey);
  const promptVariants = getBuiltInSystemPromptVariants(routeKey);
  const [promptVariantKey, setPromptVariantKey] = useState(promptVariants[0]?.key ?? "default");
  const selectedPrompt = promptVariants.find((item) => item.key === promptVariantKey) ?? promptVariants[0] ?? { key: "default", label: "当前步骤", prompt: getBuiltInSystemPrompt(routeKey) };
  const isReplacingPrompt = route.systemPromptMode === "replace";
  const promptEditorValue = isReplacingPrompt ? route.systemPrompt ?? selectedPrompt.prompt : route.systemPrompt ?? "";
  const updateRoute = (patch: Partial<ModelRouteConfig>) => update("modelRoutes", { ...(form.modelRoutes ?? {}), [routeKey]: { ...route, ...patch } });
  return <article className="model-route-card responses-agent-prompt-card">
    <div className="model-route-card-heading"><div><span className="model-route-step-label">实际 Responses 步骤</span><strong>大题 Responses Agent 主教师</strong><small>这是新链路实际使用的 System Prompt；连接地址和模型由上方 Agent 专用配置负责。</small></div><div className="model-route-card-meta"><span>大题 Agent 首轮及工具续接</span><code>{routeKey}</code></div></div>
    <div className="responses-agent-prompt-baseline"><div><strong>内置 Prompt 基线</strong><span>{selectedPrompt.label} · 系统始终保留严格 JSON Schema、证据和安全约束</span></div><pre>{selectedPrompt.prompt}</pre></div>
    <details className="model-route-advanced" open><summary><span>调整本步骤 System Prompt</span><small>{route.systemPrompt?.trim() ? (isReplacingPrompt ? "已替换基线" : "已追加指令") : "使用内置基线"}</small></summary><div className="model-route-fields model-route-advanced-fields"><label><span>调整方式</span><select value={route.systemPromptMode ?? "append"} onChange={(event) => updateRoute({ systemPromptMode: event.target.value as ModelSystemPromptMode })}>{MODEL_SYSTEM_PROMPT_MODES.map((mode) => <option value={mode} key={mode}>{systemPromptModeLabels[mode]}</option>)}</select></label>{promptVariants.length > 1 && <label><span>内置版本</span><select value={selectedPrompt.key} onChange={(event) => setPromptVariantKey(event.target.value)}>{promptVariants.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label>}<label className="model-route-system-prompt-field"><div className="model-route-system-prompt-heading"><span>{isReplacingPrompt ? "替换后的完整 System Prompt" : "追加指令"}</span><button type="button" className="model-route-reset-prompt" disabled={!route.systemPrompt?.trim()} onClick={() => updateRoute({ systemPrompt: undefined, systemPromptMode: undefined })}>恢复内置基线</button></div><textarea value={promptEditorValue} maxLength={MAX_MODEL_SYSTEM_PROMPT_LENGTH} rows={7} onChange={(event) => updateRoute({ systemPrompt: event.target.value })} placeholder={isReplacingPrompt ? "内置基线会显示在这里，可直接修改" : "不追加时留空"} /><small>{isReplacingPrompt ? "高风险：保存的内容将替换完整内置 Prompt；系统仍会追加 LaTeX 安全协议。" : "推荐追加模式：只保存补充要求，实际调用会自动拼接在内置 Prompt 后。"}</small></label></div></details>
  </article>;
}

function StablePaddleOcrSettings({ form, update }: { form: ModelConfigInput; update: UpdateModelConfig }) {
  return <details className="model-ocr-settings">
    <summary className="model-ocr-settings-summary">
      <div><strong>卷面识别服务（PaddleOCR）</strong><small>{form.paddleOcr?.model?.trim() || "PaddleOCR-VL-1.6"} · 稳定大题/小题链路的整页分块和 bbox 定位</small></div>
      <span>稳定链路专用</span>
    </summary>
    <div className="model-ocr-settings-body">
      <small className="model-ocr-settings-note">Responses Agent 模式完全不读取这里的 PaddleOCR 配置；访问 Token 继续只由后端读取环境变量或 .data/paddleocr.token。</small>
      <div className="model-route-fields model-ocr-fields">
        <label className="model-route-model-field model-ocr-url-field"><span>任务 API 地址</span><input value={form.paddleOcr?.jobUrl ?? ""} onChange={(event) => update("paddleOcr", { ...(form.paddleOcr ?? {}), jobUrl: event.target.value })} placeholder="https://paddleocr.aistudio-app.com/api/v2/ocr/jobs" /></label>
        <label><span>OCR 模型</span><input value={form.paddleOcr?.model ?? ""} onChange={(event) => update("paddleOcr", { ...(form.paddleOcr ?? {}), model: event.target.value })} placeholder="PaddleOCR-VL-1.6" /></label>
        <label><span>轮询间隔（毫秒）</span><input type="number" min={0} max={60000} value={form.paddleOcr?.pollIntervalMs ?? ""} placeholder="5000" onChange={(event) => update("paddleOcr", { ...(form.paddleOcr ?? {}), pollIntervalMs: event.target.value.trim() === "" ? undefined : Number(event.target.value) })} /></label>
        <label><span>OCR 超时（毫秒）</span><input type="number" min={1000} max={1800000} value={form.paddleOcr?.timeoutMs ?? ""} placeholder="600000" onChange={(event) => update("paddleOcr", { ...(form.paddleOcr ?? {}), timeoutMs: event.target.value.trim() === "" ? undefined : Number(event.target.value) })} /></label>
      </div>
      <div className="model-ocr-toggles">
        <label><input type="checkbox" checked={form.paddleOcr?.useDocOrientationClassify === true} onChange={(event) => update("paddleOcr", { ...(form.paddleOcr ?? {}), useDocOrientationClassify: event.target.checked })} /><span>文档方向分类</span></label>
        <label><input type="checkbox" checked={form.paddleOcr?.useDocUnwarping === true} onChange={(event) => update("paddleOcr", { ...(form.paddleOcr ?? {}), useDocUnwarping: event.target.checked })} /><span>文档去畸变</span></label>
        <label><input type="checkbox" checked={form.paddleOcr?.useChartRecognition === true} onChange={(event) => update("paddleOcr", { ...(form.paddleOcr ?? {}), useChartRecognition: event.target.checked })} /><span>图表识别</span></label>
      </div>
    </div>
  </details>;
}

function StagedLayoutEngineSettings({ form, update }: { form: ModelConfigInput; update: UpdateModelConfig }) {
  const engine = form.stagedLayoutEngine ?? "paddleocr";
  const isModelNative = engine === "model_native";
  return <div className="staged-layout-engine-card">
    <div className="staged-layout-engine-header">
      <div className="staged-layout-engine-title">
        <strong>大题分块与作答定位引擎</strong>
        <small>选择大题第一阶段是调用 PaddleOCR 服务提取版面与文本，还是直接由多模态大模型视觉定位作答区域</small>
      </div>
    </div>
    <div className="staged-layout-engine-switcher" role="radiogroup" aria-label="大题分块定位引擎">
      <button
        type="button"
        role="radio"
        aria-checked={!isModelNative}
        className={!isModelNative ? "selected" : ""}
        onClick={() => update("stagedLayoutEngine", "paddleocr")}
      >
        <span className="workflow-option-kicker">成熟稳定</span>
        <strong>PaddleOCR 独立服务</strong>
        <small>调用 PaddleOCR 识别全页文字与 bbox，生成分块；需配置下方 PaddleOCR 服务与密钥</small>
        <em>{!isModelNative ? "当前选用" : "点击切换"}</em>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={isModelNative}
        className={isModelNative ? "selected native" : "native"}
        onClick={() => update("stagedLayoutEngine", "model_native")}
      >
        <span className="workflow-option-kicker">免外部服务</span>
        <strong>大模型原生定位（免 PaddleOCR）</strong>
        <small>由多模态大模型视觉分析版面与作答区域并定位 bbox；完全绕过 PaddleOCR 服务与 Token</small>
        <em>{isModelNative ? "当前选用" : "点击切换"}</em>
      </button>
    </div>
    {isModelNative ? (
      <div className="staged-layout-native-callout">
        <div className="staged-layout-native-copy">
          <strong>已选用模型原生视觉分块定位</strong>
          <span>大题第一阶段将直接由多模态大模型识别作答区域与边界框，并自动生成首轮定位索引图，完全绕过 PaddleOCR 服务与 Token。在下方“大题批改（稳定分阶段）”路由列表中，可为“大题模型原生视觉分块”单独指定使用的模型、推理强度及 System Prompt。</span>
        </div>
        <details className="staged-layout-paddleocr-fallback">
          <summary>小题仍需 PaddleOCR 时点此展开配置</summary>
          <div className="staged-layout-paddleocr-fallback-body">
            <StablePaddleOcrSettings form={form} update={update} />
          </div>
        </details>
      </div>
    ) : (
      <StablePaddleOcrSettings form={form} update={update} />
    )}
  </div>;
}

function StableRouteGroups({ form, update, includeLargeQuestion }: { form: ModelConfigInput; update: UpdateModelConfig; includeLargeQuestion: boolean }) {
  const [promptPreviewKeys, setPromptPreviewKeys] = useState<Partial<Record<ModelRouteKey, string>>>({});
  const updateRoute = (key: ModelRouteKey, patch: Partial<ModelRouteConfig>) => update("modelRoutes", { ...(form.modelRoutes ?? {}), [key]: { ...routeValue(form, key), ...patch } });
  const setNumber = (key: ModelRouteKey, field: "timeoutMs" | "maxRetries" | "maxOutputTokens", value: string) => updateRoute(key, { [field]: value.trim() === "" ? undefined : Number(value) });
  const isModelNative = form.stagedLayoutEngine === "model_native";
  const groups = MODEL_ROUTE_GROUPS.filter((group) => includeLargeQuestion || group.key !== "large-question").map((group) => {
    if (group.key !== "large-question") return group;
    const routeKeys: readonly ModelRouteKey[] = isModelNative
      ? ["large_question_layout_detection", "large_question_answer_triage", "large_question_visual_review", "large_question_point_review"]
      : ["large_question_answer_triage", "large_question_visual_review", "large_question_point_review"];
    return {
      ...group,
      routeKeys,
      description: isModelNative
        ? "模型原生分块后，进入首轮答案判定、按需视觉复核和评分点审验"
        : "首轮判定后，按需进入视觉复核和评分点审验"
    };
  });
  return <div className="model-route-groups">
    {groups.map((group) => {
      const definitions = group.routeKeys.map((key) => ACTIVE_MODEL_ROUTE_DEFINITIONS.find((definition) => definition.key === key)).filter((definition): definition is typeof ACTIVE_MODEL_ROUTE_DEFINITIONS[number] => Boolean(definition));
      return <div className="model-route-group" key={group.key}>
        <div className="model-route-group-heading"><div><span>{group.label}</span><strong>{group.description}</strong></div><small>{definitions.length} 条业务路由</small></div>
        <div className="model-route-list">
          {definitions.map((definition) => {
            const route = routeValue(form, definition.key);
            const inheritedReasoning = defaultReasoning(form, route.endpoint);
            const effectiveReasoning = route.reasoningEffort ?? inheritedReasoning;
            const promptVariants = getBuiltInSystemPromptVariants(definition.key);
            const selectedPromptVariant = promptVariants.find((item) => item.key === promptPreviewKeys[definition.key]) ?? promptVariants[0]!;
            const isReplacingPrompt = route.systemPromptMode === "replace";
            const promptEditorValue = isReplacingPrompt ? route.systemPrompt ?? selectedPromptVariant.prompt : route.systemPrompt ?? "";
            return <article className="model-route-card" key={definition.key}>
              <div className="model-route-card-heading"><div><span className="model-route-step-label">实际步骤</span><strong>{definition.label}</strong><small>{definition.description}</small></div><div className="model-route-card-meta"><span>{routeTriggerLabels[definition.key] ?? "按当前流程调用"}</span><code>{definition.key}</code></div></div>
              <div className="model-route-fields model-route-basic-fields"><label className="model-route-model-field"><span>本步骤使用模型</span><input value={route.model} onChange={(event) => updateRoute(definition.key, { model: event.target.value })} placeholder={modelPlaceholder(definition.modelField)} /></label><label><span>本步骤推理强度</span><select value={route.reasoningEffort ?? "inherit"} onChange={(event) => updateRoute(definition.key, { reasoningEffort: event.target.value === "inherit" ? undefined : event.target.value as ModelRouteConfig["reasoningEffort"] })}><option value="inherit">继承{endpointLabels[route.endpoint]}默认（当前：{reasoningLabels[inheritedReasoning]}）</option>{TEACHER_REASONING_EFFORTS.map((effort) => <option value={effort} key={effort}>{effort === "disabled" ? "本步骤不发送 reasoning_effort" : effort}</option>)}</select><small className="model-route-effective-note">当前生效：{reasoningLabels[effectiveReasoning]}</small></label></div>
              <details className="model-route-advanced"><summary><span>服务来源、System Prompt 与低频参数</span><small>{endpointLabels[route.endpoint]} · {route.systemPrompt?.trim() ? (route.systemPromptMode === "replace" ? "已替换提示词" : "已追加提示词") : "使用内置提示词"}</small></summary><div className="model-route-fields model-route-advanced-fields"><label><span>API 服务</span><select value={route.endpoint} onChange={(event) => updateRoute(definition.key, { endpoint: event.target.value as ModelRouteConfig["endpoint"] })}><option value="teacher">{endpointLabels.teacher}</option><option value="review">{endpointLabels.review}</option></select></label><label><span>超时（毫秒）</span><input type="number" min={1000} max={300000} value={route.timeoutMs ?? ""} placeholder="继承全局" onChange={(event) => setNumber(definition.key, "timeoutMs", event.target.value)} /></label><label><span>最大输出 Token</span><input type="number" min={256} max={65536} value={route.maxOutputTokens ?? ""} placeholder="继承全局" onChange={(event) => setNumber(definition.key, "maxOutputTokens", event.target.value)} /></label><label><span>本链路重试上限</span><input type="number" min={0} max={5} value={route.maxRetries ?? ""} placeholder="不超过全局" onChange={(event) => setNumber(definition.key, "maxRetries", event.target.value)} /></label><label><span>System Prompt 调整方式</span><select value={route.systemPromptMode ?? "append"} onChange={(event) => updateRoute(definition.key, { systemPromptMode: event.target.value as ModelSystemPromptMode })}>{MODEL_SYSTEM_PROMPT_MODES.map((mode) => <option value={mode} key={mode}>{systemPromptModeLabels[mode]}</option>)}</select></label>{promptVariants.length > 1 && <label className="model-route-prompt-variant-field"><span>替换模式内置版本</span><select value={selectedPromptVariant.key} onChange={(event) => setPromptPreviewKeys((current) => ({ ...current, [definition.key]: event.target.value }))}>{promptVariants.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label>}<label className="model-route-system-prompt-field"><div className="model-route-system-prompt-heading"><span>{isReplacingPrompt ? "本步骤完整 System Prompt（可直接编辑）" : "本步骤追加指令"}</span><button type="button" className="model-route-reset-prompt" disabled={!route.systemPrompt?.trim()} onClick={() => updateRoute(definition.key, { systemPrompt: undefined, systemPromptMode: undefined })}>恢复内置提示词</button></div><textarea value={promptEditorValue} maxLength={MAX_MODEL_SYSTEM_PROMPT_LENGTH} rows={6} onChange={(event) => updateRoute(definition.key, { systemPrompt: event.target.value })} placeholder={isReplacingPrompt ? "当前内置提示词会显示在这里，可直接修改" : "不追加时留空"} /><small>{isReplacingPrompt ? "替换模式下这里直接显示并保存完整提示词；恢复内置提示词会清除本步骤覆盖。" : "追加模式只保存你补充的内容；需要查看或编辑完整内置提示词时切换为替换模式。"} LaTeX 安全协议仍由系统追加。</small></label></div></details>
            </article>;
          })}
        </div>
      </div>;
    })}
  </div>;
}

export function ModelRoutingSettings({ form, update, variant }: { form: ModelConfigInput; update: UpdateModelConfig; variant: SettingsVariant }) {
  const workflow = form.largeQuestionWorkflow ?? "staged";
  const isAgent = workflow === "responses_agent";
  const sectionClass = variant === "desktop" ? "desktop-section model-routing-section desktop-model-routing-section" : "settings-section model-routing-section";
  const headingClass = variant === "desktop" ? "desktop-section-heading" : "section-heading";
  const chooseWorkflow = (next: "staged" | "responses_agent") => {
    if (next === workflow) return;
    if (next === "responses_agent" && !form.responsesAgent) update("responsesAgent", createAgentDefaults(form));
    update("largeQuestionWorkflow", next);
  };
  return <section className={`${sectionClass} ${isAgent ? "responses-agent-mode" : "stable-staged-mode"}`}>
    <div className={headingClass}><div>{variant === "desktop" ? <span>大题批改链路</span> : null}<h2>选择大题批改链路</h2><p>切换只改变大题执行路径；两套连接和运行参数分别保存，稳定分阶段链路仍是默认值。</p></div></div>
    <div className="large-question-workflow-switcher" role="radiogroup" aria-label="大题批改链路">
      <button type="button" role="radio" aria-checked={!isAgent} className={!isAgent ? "selected" : ""} onClick={() => chooseWorkflow("staged")}><span className="workflow-option-kicker">默认稳定</span><strong>稳定分阶段</strong><small>{form.stagedLayoutEngine === "model_native" ? "模型原生分块 → 教师首轮 → 按需复核 → 后端计分" : "PaddleOCR 分块 → 教师首轮 → 按需复核 → 后端计分"}</small><em>{!isAgent ? "当前启用" : "保留原配置"}</em></button>
      <button type="button" role="radio" aria-checked={isAgent} className={isAgent ? "selected agent" : "agent"} onClick={() => chooseWorkflow("responses_agent")}><span className="workflow-option-kicker">新链路 · Responses</span><strong>Responses Agent</strong><small>整页视觉 → 自主局部工具 → 后端计分；完全不调用 PaddleOCR</small><em>{isAgent ? "当前启用" : "手动启用"}</em></button>
    </div>
    {isAgent ? <><div className="model-route-policy responses-agent-policy"><strong>Responses Agent 已选中</strong><span>只有大题走新链路；小题、评分标准和稳定模式配置仍保留。PaddleOCR 在本链路完全禁用，连接测试必须使用下方专用 Agent 测试。</span></div><ResponsesAgentSettings form={form} update={update} variant={variant} /><div className="model-route-groups responses-agent-route-groups"><div className="model-route-group"><div className="model-route-group-heading"><div><span>Responses Agent 步骤提示词</span><strong>查看实际生效的内置基线，按需追加或替换</strong></div><small>1 条业务路由</small></div><div className="model-route-list"><AgentRoutePromptSettings form={form} update={update} /></div></div></div><StableRouteGroups form={form} update={update} includeLargeQuestion={false} /></> : <><div className="model-route-policy"><strong>稳定分阶段链路已选中</strong><span>大题按{form.stagedLayoutEngine === "model_native" ? "模型原生分块定位" : "PaddleOCR 分块定位"} → 教师首轮答案判定 → 按需局部视觉复核与评分点审验 → 本地计分；严格 JSON Schema、复核不阻断和后端重算均为系统约束。</span></div><StagedLayoutEngineSettings form={form} update={update} /><StableRouteGroups form={form} update={update} includeLargeQuestion /></>}
    <details className="model-route-compatibility"><summary>兼容说明</summary><small>旧版证据提取和旧版整题视觉直批仅保留历史代码兼容，不作为当前页面入口；Responses Agent 与稳定分阶段配置互不清空。</small></details>
  </section>;
}
