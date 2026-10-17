import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, Check, CheckCircle2, ChevronRight, CircleGauge,
  ClipboardCheck, CloudCog, Code2, Download, Eye, FileCheck2, FileText, FolderOpen, Gauge, ImagePlus,
  History, KeyRound, LoaderCircle, Maximize2, Play, RefreshCw, RotateCcw, Save,
  ScrollText, ShieldCheck, Sparkles, Square, Trash2, Upload, X, XCircle, ZoomIn, ZoomOut
} from "lucide-react";
import { DEFAULT_MODEL_TIMEOUT_MS, DEFAULT_RESPONSES_AGENT_MAX_OUTPUT_TOKENS, DEFAULT_RESPONSES_AGENT_MAX_REGIONS, DEFAULT_RESPONSES_AGENT_MAX_TOOL_ROUNDS, DEFAULT_RESPONSES_AGENT_TIMEOUT_MS, DEFAULT_REVIEW_REASONING_EFFORT, DEFAULT_TEACHER_REASONING_EFFORT, DEFAULT_UNREADABLE_REVIEW_THRESHOLD } from "../shared/types";
import type {
  GradingArtifact, GradingResult, GradingTemplateDetail, GradingTemplateSummary, ModelCallHistoryEntry,
  ModelConfigInput, ModelCallLogDetails, PublicModelConfig, Rubric, SystemLogEntry, SystemLogSnapshot
} from "../shared/types";
import { api, uploadDocument } from "./api";
import { LOW_CONFIDENCE_THRESHOLD, detectHighRiskDeductions, summarizeGradingReliability } from "../shared/reviewSignals";
import { systemLogScopeLabels } from "../shared/uiConstants";
import {
  IMAGE_VIEWER_MAX_SCALE, calculateImageFitScale, clampImageOffset, clampImageScale,
  imageOffsetAfterZoom, type ViewerPoint, type ViewerSize
} from "./answerImageViewer";
import { MathText } from "./Formula";
import { formulaWithUnit } from "./math";
import { directionFromPopState, replaceRoute, runRouteTransition } from "./navigation";
import { ScorePointGuidance } from "./ScorePointGuidance";
import { ModelRoutingSettings } from "./ModelRoutingSettings";
import { LogDetailsSummary, ModelCallDetails, ModelCallHistory, logStatusLabel } from "./logPresentation";
export { LogDetailsSummary, ModelCallDetails, ModelCallHistory } from "./logPresentation";

type View = "workspace" | "history" | "logs" | "models";
type AppRoute = { view: View; templateId?: string; resultId?: string };
type StudentFile = { id: string; studentId: string; file: File; preview: string };
type MaterialImage = { id: string; file: File; preview: string; source: "paste" | "upload" };
type ActivityLog = { id: string; time: string; message: string; status: "done" | "active" | "error" };
type ResponsesAgentFormConfig = NonNullable<ModelConfigInput["responsesAgent"]> & { backendGuardrailsEnabled?: boolean };

const defaultResponsesAgentConfig: ResponsesAgentFormConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
  reasoningEffort: "disabled",
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

function normalizeResponsesAgentFormConfig(value: NonNullable<ModelConfigInput["responsesAgent"]>): ResponsesAgentFormConfig {
  const config = value as ResponsesAgentFormConfig;
  return {
    ...config,
    backendGuardrailsEnabled: config.backendGuardrailsEnabled !== false,
    apiKey: "",
    verifierApiKey: ""
  };
}

const defaultConfig: ModelConfigInput = {
  name: "默认 OpenAI 兼容服务",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  visionModel: "",
  textModel: "",
  reviewBaseUrl: "",
  reviewApiKey: "",
  reviewModel: "",
  timeoutMs: DEFAULT_MODEL_TIMEOUT_MS,
  maxRetries: 1,
  maxConcurrency: 2,
  maxOutputTokens: 4096,
  unreadableReviewThreshold: DEFAULT_UNREADABLE_REVIEW_THRESHOLD,
  largeQuestionWorkflow: "staged",
  responsesAgent: defaultResponsesAgentConfig,
  teacherReasoningEffort: DEFAULT_TEACHER_REASONING_EFFORT,
  reviewReasoningEffort: DEFAULT_REVIEW_REASONING_EFFORT,
  supportsJsonSchema: true,
  supportsJsonObject: false,
  supportsBase64Images: true,
  enabled: true
};

const steps = ["材料", "评分标准", "学生作答", "批改结果"];

function decodeRouteSegment(value: string) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

export function parseRoute(pathname: string): AppRoute {
  const segments = pathname.split("/").filter(Boolean).map(decodeRouteSegment);
  if (segments.length === 0) return { view: "workspace" };
  if (segments[0] === "models") return { view: "models" };
  if (segments[0] === "history") return { view: "history" };
  if (segments[0] === "logs") return { view: "logs" };
  if (segments[0] === "grading") {
    if (segments[1] === "templates" && segments[2]) {
      if (segments[3] === "results" && segments[4]) {
        return { view: "workspace", templateId: segments[2], resultId: segments[4] };
      }
      return { view: "workspace", templateId: segments[2] };
    }
    return { view: "workspace" };
  }
  return { view: "workspace" };
}

export function routePath(route: AppRoute): string {
  if (route.view === "models") return "/models";
  if (route.view === "history") return "/history";
  if (route.view === "logs") return "/logs";
  if (route.templateId && route.resultId) {
    return `/grading/templates/${encodeURIComponent(route.templateId)}/results/${encodeURIComponent(route.resultId)}`;
  }
  if (route.templateId) return `/grading/templates/${encodeURIComponent(route.templateId)}`;
  return "/grading";
}

function isModifiedNavigation(event: React.MouseEvent<HTMLAnchorElement>) {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function scoreLabel(score: number, maximumPossibleScore?: number) {
  return typeof maximumPossibleScore === "number" && maximumPossibleScore > score
    ? `${score}-${maximumPossibleScore}`
    : String(score);
}

function confidenceClass(value: number) {
  if (value < LOW_CONFIDENCE_THRESHOLD) return "low-confidence";
  if (value < 0.85) return "medium-confidence";
  return "high-confidence";
}

function statusLabel(status: GradingResult["status"]) {
  if (status === "completed") return "已完成";
  if (status === "needs_review") return "待复核";
  return "失败";
}

function currentResultVersions(results: GradingResult[]) {
  const supersededIds = new Set(results.flatMap((result) => result.previousResultId ? [result.previousResultId] : []));
  return results.filter((result) => !supersededIds.has(result.id));
}

function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname));
  const [config, setConfig] = useState<PublicModelConfig | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [taskActivity, setTaskActivity] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const view = route.view;

  const refreshConfig = async () => {
    try { setConfig(await api<PublicModelConfig | null>("/api/model-config")); }
    catch { setConfig(null); }
  };
  const handleTemplateSaved = useCallback(() => setHistoryRevision((value) => value + 1), []);

  const navigate = useCallback((next: AppRoute, replace = false) => {
    const nextPath = routePath(next);
    if (window.location.pathname === nextPath) return;
    const direction = nextPath.split("/").filter(Boolean).length < window.location.pathname.split("/").filter(Boolean).length
      ? "back"
      : "forward";
    runRouteTransition(() => {
      if (replace) replaceRoute(nextPath);
      else window.history.pushState({ prismDirection: direction }, "", nextPath);
      setRoute(next);
    }, direction);
  }, []);

  const navigateFromLink = useCallback((event: React.MouseEvent<HTMLAnchorElement>, next: AppRoute) => {
    if (isModifiedNavigation(event)) return;
    event.preventDefault();
    navigate(next);
  }, [navigate]);

  useEffect(() => {
    void refreshConfig();
    const onPopState = (event: PopStateEvent) => {
      runRouteTransition(() => setRoute(parseRoute(window.location.pathname)), directionFromPopState(event));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const canonicalPath = routePath(route);
    if (window.location.pathname !== canonicalPath) {
      replaceRoute(canonicalPath);
    }
  }, [route]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark"><ShieldCheck size={20} /><span>衡准</span></div>
        <nav aria-label="主导航">
          <a className={view === "workspace" ? "nav-item active" : "nav-item"} href="/grading" aria-current={view === "workspace" ? "page" : undefined} onClick={(event) => navigateFromLink(event, { view: "workspace" })}>
            {taskActivity ? <LoaderCircle className="spin" size={18} /> : <ClipboardCheck size={18} />}<span>批改任务</span>
          </a>
          <a className={view === "models" ? "nav-item active" : "nav-item"} href="/models" aria-current={view === "models" ? "page" : undefined} onClick={(event) => navigateFromLink(event, { view: "models" })}>
            <CloudCog size={18} /><span>系统设置</span>
          </a>
          <a className={view === "history" ? "nav-item active" : "nav-item"} href="/history" aria-current={view === "history" ? "page" : undefined} onClick={(event) => navigateFromLink(event, { view: "history" })}>
            <History size={18} /><span>历史记录</span>
          </a>
          <a className={view === "logs" ? "nav-item active" : "nav-item"} href="/logs" aria-current={view === "logs" ? "page" : undefined} onClick={(event) => navigateFromLink(event, { view: "logs" })}>
            <ScrollText size={18} /><span>运行日志</span>
          </a>
        </nav>
        {taskActivity && <div className="sidebar-activity"><LoaderCircle className="spin" size={14} /><span>{taskActivity}</span></div>}
        <div className="sidebar-status">
          <span className={config?.enabled && config.hasApiKey ? "status-dot online" : "status-dot"} />
          <div><strong>{config?.enabled && config.hasApiKey ? "模型已配置" : "模型未配置"}</strong><small>{config?.visionModel || "等待接入"}</small></div>
        </div>
      </aside>

      <main className="main-content">
        {notice && <div className="global-notice"><CheckCircle2 size={16} />{notice}<button title="关闭提示" onClick={() => setNotice("")}><XCircle size={16} /></button></div>}
        <div className="route-stage">
          <div hidden={view !== "workspace"}>
            <GradingWorkspace
              configReady={Boolean(config?.enabled && config.hasApiKey)}
              onOpenModels={() => navigate({ view: "models" })}
              onActivityChange={setTaskActivity}
              openTemplateId={route.templateId ?? null}
              openResultId={route.resultId ?? null}
              onResultSelected={(templateId, resultId) => navigate({ view: "workspace", templateId, resultId })}
              onTemplateSaved={handleTemplateSaved}
            />
          </div>
          <div hidden={view !== "history"}>
            <HistoryPage revision={historyRevision} onOpen={(id) => navigate({ view: "workspace", templateId: id })} />
          </div>
          <div hidden={view !== "logs"}>
            <LogsPage active={view === "logs"} />
          </div>
          <div hidden={view !== "models"}>
            <ModelSettings current={config} onSaved={async () => {
              await refreshConfig();
              setNotice("系统配置已安全保存");
            }} />
          </div>
        </div>
      </main>
    </div>
  );
}

function ModelSettings({ current, onSaved }: { current: PublicModelConfig | null; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<ModelConfigInput>(defaultConfig);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<"text" | "vision" | "review" | "agent" | null>(null);
  const [testResult, setTestResult] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!current) return;
    setForm({
      ...current,
      apiKey: "",
      reviewApiKey: "",
      responsesAgent: current.responsesAgent ? normalizeResponsesAgentFormConfig(current.responsesAgent) : undefined
    });
  }, [current]);

  const update = <K extends keyof ModelConfigInput>(key: K, value: ModelConfigInput[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const applyCurrentConfig = async () => {
    await api<PublicModelConfig>("/api/model-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, supportsJsonSchema: true, supportsJsonObject: false })
    });
    setForm((value) => ({ ...value, apiKey: "", reviewApiKey: "", responsesAgent: value.responsesAgent ? { ...value.responsesAgent, apiKey: "", verifierApiKey: "" } : undefined }));
    await onSaved();
  };

  const save = async () => {
    setSaving(true); setTestResult(null);
    try {
      await applyCurrentConfig();
    } catch (error) {
      setTestResult({ type: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally { setSaving(false); }
  };

  const test = async (mode: "text" | "vision" | "review" | "agent") => {
    setTesting(mode); setTestResult(null);
    let applied = false;
    try {
      await applyCurrentConfig();
      applied = true;
      const result = await api<{ message: string; durationMs: number; model: string }>("/api/model-config/test", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode })
      });
      setTestResult({ type: "ok", text: `${result.model}：${result.message}，${result.durationMs} ms` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接失败";
      setTestResult({ type: "error", text: applied ? `配置已全局应用，但连接测试失败：${message}` : `配置保存失败：${message}` });
    } finally { setTesting(null); }
  };

  const canTest = Boolean(
    form.baseUrl.trim()
    && form.visionModel.trim()
    && form.textModel.trim()
    && (form.apiKey?.trim() || current?.hasApiKey)
  );
  const canTestReview = Boolean(
    form.reviewModel?.trim()
    && (form.reviewApiKey?.trim() || current?.hasReviewApiKey)
  );
  const canTestAgent = Boolean(
    form.largeQuestionWorkflow === "responses_agent"
    && form.responsesAgent?.baseUrl?.trim()
    && form.responsesAgent.model?.trim()
    && (form.responsesAgent.apiKey?.trim() || current?.responsesAgent?.hasApiKey)
  );

  return (
    <div className="page narrow-page">
      <header className="page-header">
        <div><p className="eyebrow">系统设置</p><h1>模型与批改策略</h1><p>配置 OpenAI 兼容模型服务和人工复核边界。</p></div>
        <div className={current?.hasApiKey ? "connection-badge connected" : "connection-badge"}>
          <span className="status-dot online" />{current?.hasApiKey ? "配置已保存" : "尚未配置"}
        </div>
      </header>

      <section className="settings-section">
        <div className="section-heading"><KeyRound size={18} /><div><h2>连接信息</h2><p>密钥仅发送到后端，并以 AES-256-GCM 加密保存。</p></div></div>
        <div className="form-grid">
          <label><span>配置名称</span><input value={form.name} onChange={(event) => update("name", event.target.value)} /></label>
          <label className="span-2"><span>API Base URL</span><input value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" /></label>
          <label className="span-2"><span>API Key</span><input type="password" value={form.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={current?.apiKeyMasked || "输入 API Key"} /><small>{current?.hasApiKey ? "留空将保留已保存的密钥" : "密钥不会返回到浏览器"}</small></label>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-heading"><Gauge size={18} /><div><h2>人工复核策略</h2><p>按整张试卷中因卷面无法辨认而未获得的分值累计。</p></div></div>
        <div className="form-grid">
          <label>
            <span>无法辨认复核阈值（分）</span>
            <input
              type="number"
              min="0.5"
              max="100"
              step="0.5"
              value={form.unreadableReviewThreshold}
              onChange={(event) => update("unreadableReviewThreshold", Number(event.target.value))}
            />
            <small>累计影响分值达到或超过该值时，整卷进入人工复核；低于该值仍按 0 分计并保留审验标记。</small>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-heading"><Sparkles size={18} /><div><h2>模型与调用</h2><p>文字结构化与视觉批改可使用不同模型。</p></div></div>
        <div className="form-grid">
          <label><span>默认视觉模型</span><input value={form.visionModel} onChange={(event) => update("visionModel", event.target.value)} placeholder="vision-model-name" /><small>链路未单独指定模型时使用；具体链路可在下方覆盖。</small></label>
          <label><span>默认局部审验模型</span><input value={form.reviewModel ?? ""} onChange={(event) => update("reviewModel", event.target.value)} placeholder="留空则保留复核标记" /><small>填写支持图像输入的模型。它只独立读取局部证据；缺失时不会阻断批改，只会保留人工复核标记。</small></label>
          <label className="span-2"><span>审验 API Base URL</span><input value={form.reviewBaseUrl ?? ""} onChange={(event) => update("reviewBaseUrl", event.target.value)} placeholder="留空则复用教师 API Base URL" /><small>只复用服务地址，不复用教师 API Key。</small></label>
          <label className="span-2"><span>审验 API Key</span><input type="password" value={form.reviewApiKey ?? ""} onChange={(event) => update("reviewApiKey", event.target.value)} placeholder={current?.reviewApiKeyMasked || "输入独立审验 API Key"} /><small>{current?.hasReviewApiKey ? "留空将保留已保存的审验密钥" : "启用审验模型时必须单独填写，不会使用教师密钥代替"}</small></label>
          <label><span>默认文本模型</span><input value={form.textModel} onChange={(event) => update("textModel", event.target.value)} placeholder="text-model-name" /><small>链路未单独指定模型时使用。</small></label>
          <label><span>超时时间（毫秒）</span><input type="number" value={form.timeoutMs} onChange={(event) => update("timeoutMs", Number(event.target.value))} /></label>
          <label><span>最大输出 Token</span><input type="number" value={form.maxOutputTokens} onChange={(event) => update("maxOutputTokens", Number(event.target.value))} /></label>
          <label><span>全局失败重试</span><input type="number" value={form.maxRetries} onChange={(event) => update("maxRetries", Number(event.target.value))} /></label>
          <label><span>最大并发</span><input type="number" value={form.maxConcurrency} onChange={(event) => update("maxConcurrency", Number(event.target.value))} /></label>
          <label className="span-2"><span>教师模型推理强度</span><select value={form.teacherReasoningEffort ?? DEFAULT_TEACHER_REASONING_EFFORT} onChange={(event) => update("teacherReasoningEffort", event.target.value as ModelConfigInput["teacherReasoningEffort"])}><option value="disabled">默认，不额外传递推理强度</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option><option value="ultra">ultra</option></select><small>提供六档可选强度；具体模型和兼容服务必须支持所选 <code>reasoning_effort</code>，否则调用会由服务端报错。</small></label>
          <label className="span-2"><span>审验模型推理强度</span><select value={form.reviewReasoningEffort ?? DEFAULT_REVIEW_REASONING_EFFORT} onChange={(event) => update("reviewReasoningEffort", event.target.value as ModelConfigInput["reviewReasoningEffort"])}><option value="disabled">默认，不额外传递推理强度</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option><option value="ultra">ultra</option></select><small>快速小模型建议使用 low；只有复杂、潦草局部答案才需要提高强度。</small></label>
        </div>
        <div className="toggle-row">
          <Toggle label="JSON Schema（强制）" checked={true} disabled onChange={() => undefined} />
          <Toggle label="JSON Object（已禁用）" checked={false} disabled onChange={() => undefined} />
          <Toggle label="Base64 图片" checked={form.supportsBase64Images} onChange={(value) => update("supportsBase64Images", value)} />
          <Toggle label="启用配置" checked={form.enabled} onChange={(value) => update("enabled", value)} />
        </div>
      </section>

      <ModelRoutingSettings form={form} update={update} variant="web" />

      {testResult && <div className={`test-result ${testResult.type}`}>
        {testResult.type === "ok" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<span>{testResult.text}</span>
      </div>}

      <div className="action-bar">
        <div><strong>连接测试会产生模型调用</strong><small>测试前会先保存并全局应用当前配置；Responses Agent 测试会依次验证文本、视觉、工具调用和无状态续接，因此会产生多次最小调用。</small></div>
        <button className="button secondary" disabled={!canTest || saving || Boolean(testing)} onClick={() => void test("text")}>{testing === "text" ? <LoaderCircle className="spin" size={16} /> : <Code2 size={16} />}测试文本</button>
        <button className="button secondary" disabled={!canTest || saving || Boolean(testing)} onClick={() => void test("vision")}>{testing === "vision" ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}测试多模态</button>
        <button className="button secondary" disabled={!canTestReview || saving || Boolean(testing)} onClick={() => void test("review")}>{testing === "review" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}测试审验模型</button>
        {form.largeQuestionWorkflow === "responses_agent" && <button className="button secondary responses-agent-test-button" disabled={!canTestAgent || saving || Boolean(testing)} onClick={() => void test("agent")}>{testing === "agent" ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}测试 Responses Agent</button>}
        <button className="button primary" disabled={saving || Boolean(testing)} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存并全局应用</button>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span className="toggle-track" /><span>{label}</span></label>;
}

function GradingWorkspace({ configReady, onOpenModels, onActivityChange, openTemplateId, openResultId, onResultSelected, onTemplateSaved }: {
  configReady: boolean;
  onOpenModels: () => void;
  onActivityChange: (activity: string | null) => void;
  openTemplateId: string | null;
  openResultId: string | null;
  onResultSelected: (templateId: string, resultId: string) => void;
  onTemplateSaved: () => void;
}) {
  const [questionText, setQuestionText] = useState("");
  const [referenceText, setReferenceText] = useState("");
  const [questionImages, setQuestionImages] = useState<MaterialImage[]>([]);
  const [referenceImages, setReferenceImages] = useState<MaterialImage[]>([]);
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [rubricJson, setRubricJson] = useState("");
  const [editingJson, setEditingJson] = useState(false);
  const [students, setStudents] = useState<StudentFile[]>([]);
  const [results, setResults] = useState<GradingResult[]>([]);
  /** 已成功批改的学生 id 集合：批改中断后重试只处理剩余学生，避免重复批改与重复历史记录。 */
  const [gradedStudentIds, setGradedStudentIds] = useState<Set<string>>(new Set());
  const [answerImageUrls, setAnswerImageUrls] = useState<Record<string, string>>({});
  const [modelCallsByResultId, setModelCallsByResultId] = useState<Record<string, ModelCallHistoryEntry[]>>({});
  const [artifactsByResultId, setArtifactsByResultId] = useState<Record<string, GradingArtifact[]>>({});
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"document" | "structure" | "refine" | "grade" | "regrade" | "demo" | "save" | "history" | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [structureLogs, setStructureLogs] = useState<ActivityLog[]>([]);
  const [structureStartedAt, setStructureStartedAt] = useState<number | null>(null);
  const [structureElapsed, setStructureElapsed] = useState(0);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [defaultFixtureId, setDefaultFixtureId] = useState<string | null>(null);
  const questionInput = useRef<HTMLInputElement>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  const studentInput = useRef<HTMLInputElement>(null);

  const activeStep = results.length ? 3 : students.length ? 2 : rubric ? 1 : 0;
  const selectedResult = results.find((item) => item.id === selectedResultId) ?? results[0];

  const metrics = useMemo(() => {
    if (!results.length) return null;
    const currentResults = currentResultVersions(results);
    const average = (key: keyof GradingResult["metrics"]) => currentResults.reduce((sum, item) => sum + Number(item.metrics[key]), 0) / currentResults.length;
    return {
      coverage: average("ruleCoverage"), traceability: average("evidenceTraceability"),
      automatic: average("autoDecisionRate"), review: currentResults.filter((item) => item.status === "needs_review").length / currentResults.length
    };
  }, [results]);

  useEffect(() => {
    if (busy !== "structure" || structureStartedAt === null) return;
    const updateElapsed = () => setStructureElapsed(Math.floor((Date.now() - structureStartedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [busy, structureStartedAt]);

  useEffect(() => {
    if (busy === "structure") onActivityChange(`正在生成规则 · ${structureElapsed}s`);
    else if (busy === "grade") onActivityChange(`正在批改 · ${Math.round(progress * 100)}%`);
    else if (busy === "regrade") onActivityChange("正在重新批改历史答卷");
    else if (busy === "save") onActivityChange("正在保存评分标准");
    else if (busy === "refine") onActivityChange("教师模型正在完善评分标准");
    else if (busy === "history") onActivityChange("正在恢复历史场景");
    else onActivityChange(null);
  }, [busy, onActivityChange, progress, structureElapsed]);

  useEffect(() => {
    if (openTemplateId || !window.location.search.includes("electron=1")) return;
    let cancelled = false;
    void api<{ templateId: string }>("/api/pipeline/fixture")
      .then((fixture) => {
        if (!cancelled) setDefaultFixtureId(fixture.templateId);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "内置测试模板加载失败");
      });
    return () => { cancelled = true; };
  }, [openTemplateId]);

  useEffect(() => {
    const templateToRestore = openTemplateId ?? defaultFixtureId;
    if (!templateToRestore) return;
    let cancelled = false;
    const restore = async () => {
      setBusy("history"); setError(""); setWarning("");
      try {
        const detail = await api<GradingTemplateDetail>(`/api/templates/${templateToRestore}`);
        const toMaterial = async (asset: GradingTemplateDetail["questionImages"][number]): Promise<MaterialImage> => {
          const response = await fetch(asset.url);
          if (!response.ok) throw new Error(`无法读取历史图片：${asset.fileName}`);
          const blob = await response.blob();
          const file = new File([blob], asset.fileName, { type: asset.mimeType });
          return { id: asset.id, file, preview: URL.createObjectURL(blob), source: "upload" };
        };
        const restoreAssets = async (assets: GradingTemplateDetail["questionImages"]) => {
          const settled = await Promise.allSettled(assets.map(toMaterial));
          return {
            images: settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []),
            failures: settled.flatMap((item, index) => item.status === "rejected" ? [assets[index].fileName] : [])
          };
        };
        const [restoredQuestions, restoredReferences] = await Promise.all([
          restoreAssets(detail.questionImages),
          restoreAssets(detail.referenceImages)
        ]);
        if (cancelled) return;
        setQuestionText(detail.questionText);
        setReferenceText(detail.referenceText);
        setQuestionImages(restoredQuestions.images);
        setReferenceImages(restoredReferences.images);
        setRubric(detail.rubric);
        setRubricJson(JSON.stringify(detail.rubric, null, 2));
        setTemplateId(detail.id);
        const restoredResults = detail.records.map((record) => record.result);
        setResults(restoredResults);
        setAnswerImageUrls(Object.fromEntries(detail.records.map((record) => [record.result.id, record.answerImage.url])));
        setModelCallsByResultId(Object.fromEntries(detail.records.flatMap((record) => record.modelCalls ? [[record.result.id, record.modelCalls]] : [])));
        setArtifactsByResultId(Object.fromEntries(detail.records.flatMap((record) => record.artifacts ? [[record.result.id, record.artifacts]] : [])));
        setSelectedResultId(restoredResults[0]?.id ?? null);
        setStudents([]);
        setStructureLogs([]);
        const missingAssets = [...restoredQuestions.failures, ...restoredReferences.failures];
        if (missingAssets.length) {
          setWarning(`历史场景已恢复，但 ${missingAssets.length} 张素材图片暂时无法读取：${missingAssets.join("、")}`);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "历史场景恢复失败");
      } finally {
        if (!cancelled) setBusy(null);
      }
    };
    void restore();
    return () => { cancelled = true; };
  }, [defaultFixtureId, openTemplateId]);

  useEffect(() => {
    if (!openResultId) return;
    const matched = results.find((result) => result.id === openResultId);
    if (matched) setSelectedResultId(matched.id);
  }, [openResultId, results]);

  useEffect(() => {
    if (!templateId || !selectedResultId || modelCallsByResultId[selectedResultId]) return;
    let cancelled = false;
    void api<ModelCallHistoryEntry[]>(`/api/history-records/${encodeURIComponent(selectedResultId)}/model-calls`)
      .then((calls) => {
        if (!cancelled) setModelCallsByResultId((current) => ({ ...current, [selectedResultId]: calls }));
      })
      .catch(() => {
        if (!cancelled) setModelCallsByResultId((current) => ({ ...current, [selectedResultId]: [] }));
      });
    return () => { cancelled = true; };
  }, [modelCallsByResultId, selectedResultId, templateId]);

  const extract = async (file: File, target: "question" | "reference") => {
    setBusy("document"); setError("");
    try {
      const result = await uploadDocument(file);
      if (target === "question") setQuestionText(result.text); else setReferenceText(result.text);
      setRubric(null); setResults([]); setAnswerImageUrls({}); setArtifactsByResultId({}); setTemplateId(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "文档读取失败"); }
    finally { setBusy(null); }
  };

  const structure = async () => {
    if (!configReady) { onOpenModels(); return; }
    const startedAt = Date.now();
    const now = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setStructureStartedAt(startedAt); setStructureElapsed(0);
    setStructureLogs([
      { id: crypto.randomUUID(), time: now(), message: `材料校验完成：题目图 ${questionImages.length} 张，评分标准图 ${referenceImages.length} 张`, status: "done" },
      { id: crypto.randomUUID(), time: now(), message: "正在上传材料并等待多模态模型生成结构化评分规则", status: "active" }
    ]);
    setBusy("structure"); setError("");
    try {
      const form = new FormData();
      form.append("questionText", questionText.trim() || "题目文字见题目图片");
      form.append("referenceText", referenceText.trim() || "参考答案内容见参考答案图片");
      questionImages.forEach((image) => form.append("questionImages", image.file, image.file.name));
      referenceImages.forEach((image) => form.append("referenceImages", image.file, image.file.name));
      const next = await api<Rubric>("/api/rubrics/structure", { method: "POST", body: form });
      setStructureLogs((logs) => [
        ...logs.map((log) => log.status === "active" ? { ...log, status: "done" as const } : log),
        { id: crypto.randomUUID(), time: now(), message: "模型响应已接收，结构与分值校验通过", status: "done" },
        { id: crypto.randomUUID(), time: now(), message: `评分规则草稿生成完成，用时 ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))} 秒`, status: "done" }
      ]);
      setRubric(next); setRubricJson(JSON.stringify(next, null, 2)); setResults([]); setAnswerImageUrls({}); setArtifactsByResultId({}); setTemplateId(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "结构化失败";
      setError(message);
      setStructureLogs((logs) => [
        ...logs.map((log) => log.status === "active" ? { ...log, status: "error" as const } : log),
        { id: crypto.randomUUID(), time: now(), message: `生成失败：${message}`, status: "error" }
      ]);
    }
    finally { setBusy(null); }
  };

  const loadDemo = async () => {
    setBusy("demo"); setError("");
    try {
      const demo = await api<{ questionText: string; referenceText: string; rubric: Rubric; results: GradingResult[] }>("/api/demo");
      setQuestionText(demo.questionText); setReferenceText(demo.referenceText); setRubric(demo.rubric);
      setQuestionImages([]); setReferenceImages([]);
      setRubricJson(JSON.stringify(demo.rubric, null, 2)); setResults(demo.results); setAnswerImageUrls({}); setArtifactsByResultId({}); setSelectedResultId(demo.results[0]?.id ?? null); setTemplateId(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "演示数据加载失败"); }
    finally { setBusy(null); }
  };

  const applyJson = () => {
    try {
      const next = JSON.parse(rubricJson) as Rubric;
      next.status = "draft";
      setRubric(next); setEditingJson(false); setError("");
    } catch { setError("JSON 格式无效，请检查后重试"); }
  };

  const refineRubricDraft = async (instruction: string) => {
    if (!rubric) return;
    setBusy("refine"); setError("");
    try {
      const next = await api<Rubric>("/api/rubrics/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rubric, instruction })
      });
      setRubric(next); setRubricJson(JSON.stringify(next, null, 2)); setEditingJson(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "评分细节补充失败"); throw cause; }
    finally { setBusy(null); }
  };

  const lockAndSaveRubric = async () => {
    if (!rubric) return;
    setBusy("save"); setError("");
    try {
      const savedRubric: Rubric = { ...rubric, status: "saved" };
      if (templateId) {
        const detail = await api<GradingTemplateDetail>(`/api/templates/${encodeURIComponent(templateId)}/rubric`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rubric: savedRubric })
        });
        setRubric(detail.rubric);
        setRubricJson(JSON.stringify(detail.rubric, null, 2));
        onTemplateSaved();
        return;
      }
      const form = new FormData();
      form.append("questionText", questionText);
      form.append("referenceText", referenceText);
      form.append("rubric", JSON.stringify(savedRubric));
      questionImages.forEach((image) => form.append("questionImages", image.file, image.file.name));
      referenceImages.forEach((image) => form.append("referenceImages", image.file, image.file.name));
      const saved = await api<GradingTemplateSummary>("/api/templates", { method: "POST", body: form });
      setRubric(savedRubric);
      setRubricJson(JSON.stringify(savedRubric, null, 2));
      setTemplateId(saved.id);
      setStructureLogs((logs) => [...logs, {
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        message: `评分标准已保存为可继续修改的模板：${saved.title}`,
        status: "done"
      }]);
      onTemplateSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "评分标准保存失败");
    } finally {
      setBusy(null);
    }
  };

  const addStudents = (files: FileList | null) => {
    if (!files) return;
    const next = Array.from(files).map((file, index) => ({
      id: crypto.randomUUID(), studentId: `学生 ${String(students.length + index + 1).padStart(2, "0")}`,
      file, preview: URL.createObjectURL(file)
    }));
    setStudents((previous) => [...previous, ...next]); setResults([]); setAnswerImageUrls({}); setArtifactsByResultId({}); setGradedStudentIds(new Set());
  };

  const grade = async () => {
    if (!rubric || rubric.status === "draft" || !students.length) return;
    if (!configReady) { onOpenModels(); return; }
    const priorResults = results;
    const pending = students.filter((student) => !gradedStudentIds.has(student.id));
    if (!pending.length) {
      setError("当前学生作答均已批改完成；如需重新批改请先移除或重新添加答卷。");
      return;
    }
    setBusy("grade"); setProgress(0); setError("");
    const completed: GradingResult[] = [];
    const nextGradedIds = new Set(gradedStudentIds);
    try {
      for (let index = 0; index < pending.length; index += 1) {
        const student = pending[index];
        const form = new FormData();
        form.append("image", student.file); form.append("studentId", student.studentId); form.append("rubric", JSON.stringify(rubric));
        form.append("questionText", questionText); form.append("referenceText", referenceText);
        questionImages.forEach((image) => form.append("questionImages", image.file, image.file.name));
        referenceImages.forEach((image) => form.append("referenceImages", image.file, image.file.name));
        if (templateId) form.append("templateId", templateId);
        const completedResult = await api<GradingResult>("/api/grading/grade", { method: "POST", body: form });
        if (templateId) {
          try {
            const artifacts = await api<GradingArtifact[]>(`/api/history-records/${encodeURIComponent(completedResult.id)}/artifacts`);
            setArtifactsByResultId((previous) => ({ ...previous, [completedResult.id]: artifacts }));
          } catch {
            // 产物链接不应让已完成的批改结果回滚；历史详情仍会在下次打开时重读。
          }
        }
        completed.push(completedResult);
        nextGradedIds.add(student.id);
        setGradedStudentIds(new Set(nextGradedIds));
        setAnswerImageUrls((previous) => ({ ...previous, [completedResult.id]: student.preview }));
        setResults([...completed, ...priorResults]); setProgress((index + 1) / pending.length);
      }
      setSelectedResultId(completed[0]?.id ?? null);
      if (templateId && completed[0]) onResultSelected(templateId, completed[0].id);
      if (templateId) onTemplateSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "批改执行失败"); }
    finally { setBusy(null); }
  };

  const regrade = async (resultId: string) => {
    if (!templateId || !configReady) {
      if (!configReady) onOpenModels();
      return;
    }
    setBusy("regrade"); setError("");
    try {
      const next = await api<GradingResult>(`/api/templates/${templateId}/regrade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId, reason: "采用教师模型最终答案权威判定重新批改" })
      });
      try {
        const artifacts = await api<GradingArtifact[]>(`/api/history-records/${encodeURIComponent(next.id)}/artifacts`);
        setArtifactsByResultId((previous) => ({ ...previous, [next.id]: artifacts }));
      } catch {
        // 历史详情重读时会再次获取产物清单。
      }
      setAnswerImageUrls((previous) => ({ ...previous, [next.id]: previous[resultId] ?? "" }));
      setResults((previous) => [next, ...previous]);
      setSelectedResultId(next.id);
      onResultSelected(templateId, next.id);
      onTemplateSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "历史答卷重新批改失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page-header workspace-header">
        <div><p className="eyebrow">物理计算题 · 首版测试台</p><h1>批改任务</h1><p>先确认并保存评分标准，再批量提取卷面证据并按当前版本计分。</p></div>
        <button className="button secondary" disabled={busy === "demo"} onClick={() => void loadDemo()}>{busy === "demo" ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}载入演示批次</button>
      </header>

      <div className="stepper" aria-label="任务进度">
        {steps.map((step, index) => <div className={index <= activeStep ? "step active" : "step"} key={step}><span>{index < activeStep ? <Check size={14} /> : index + 1}</span><strong>{step}</strong>{index < steps.length - 1 && <i />}</div>)}
      </div>

      {!configReady && <div className="setup-banner"><CloudCog size={20} /><div><strong>开始真实批改前需要配置模型服务</strong><p>演示批次可直接查看完整结果，不会调用外部模型。</p></div><button className="button dark" onClick={onOpenModels}>打开模型设置<ChevronRight size={16} /></button></div>}
      {warning && <div className="warning-banner"><AlertTriangle size={17} /><span>{warning}</span><button title="关闭警告" onClick={() => setWarning("")}><XCircle size={16} /></button></div>}
      {error && <div className="error-banner"><AlertTriangle size={17} /><span>{error}</span><button title="关闭错误" onClick={() => setError("")}><XCircle size={16} /></button></div>}

      <section className="workspace-section">
        <div className="section-title-row"><div><span className="section-index">01</span><h2>题目与评分标准</h2></div><span className="section-meta">支持 TXT、MD、DOCX、文本型 PDF</span></div>
        <div className="material-grid">
          <DocumentBox title="题目原文" icon={<FileText size={19} />} text={questionText} images={questionImages} onText={setQuestionText} onImages={setQuestionImages} onUpload={() => questionInput.current?.click()} placeholder="粘贴题目文字；有题图时可直接按 Ctrl+V 粘贴截图……" />
          <DocumentBox title="参考答案与评分标准" icon={<FileCheck2 size={19} />} text={referenceText} images={referenceImages} onText={setReferenceText} onImages={setReferenceImages} onUpload={() => referenceInput.current?.click()} placeholder="粘贴按点给分的参考答案；支持同时粘贴图片……" />
        </div>
        <input ref={questionInput} hidden type="file" accept=".txt,.md,.docx,.pdf" onChange={(event) => event.target.files?.[0] && void extract(event.target.files[0], "question")} />
        <input ref={referenceInput} hidden type="file" accept=".txt,.md,.docx,.pdf" onChange={(event) => event.target.files?.[0] && void extract(event.target.files[0], "reference")} />
        <div className="inline-action"><span>{busy === "document" ? "正在提取文档文字…" : `已附加 ${questionImages.length + referenceImages.length} 张图片；模型只生成结构化草稿。`}</span><button className="button primary" disabled={(!questionText.trim() && !questionImages.length) || (!referenceText.trim() && !referenceImages.length) || Boolean(busy)} onClick={() => void structure()}>{busy === "structure" ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{busy === "structure" ? `生成中 ${structureElapsed}s` : "生成评分规则"}</button></div>
        {structureLogs.length > 0 && <ActivityConsole logs={structureLogs} elapsed={structureElapsed} running={busy === "structure"} />}
      </section>

      {rubric && <RubricReview rubric={rubric} editingJson={editingJson} rubricJson={rubricJson} setRubricJson={setRubricJson} onEdit={() => setEditingJson(true)} onCancelEdit={() => setEditingJson(false)} onApplyJson={applyJson} onRefine={refineRubricDraft} refining={busy === "refine"} onSave={() => void lockAndSaveRubric()} saving={busy === "save"} templateId={templateId} />}

      {rubric && <section className="workspace-section">
        <div className="section-title-row"><div><span className="section-index">03</span><h2>学生作答</h2></div><span className="section-meta">JPG、PNG、WEBP，单张不超过 15 MB</span></div>
        <div className="upload-strip" onClick={() => studentInput.current?.click()}><Upload size={22} /><div><strong>选择数张学生作答图片</strong><span>文件名仅作参考，可在上传后修改学生编号</span></div><button className="button secondary">选择图片</button></div>
        <input ref={studentInput} hidden type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => addStudents(event.target.files)} />
        {students.length > 0 && <div className="student-list">{students.map((student) => <div className="student-row" key={student.id}>
          <img src={student.preview} alt={`${student.studentId}作答缩略图`} />
          <input value={student.studentId} onChange={(event) => setStudents((items) => items.map((item) => item.id === student.id ? { ...item, studentId: event.target.value } : item))} />
          <span>{student.file.name}</span><small>{(student.file.size / 1024 / 1024).toFixed(2)} MB</small>
          <button className="icon-button" title="移除这份作答" onClick={() => setStudents((items) => items.filter((item) => item.id !== student.id))}><Trash2 size={16} /></button>
        </div>)}</div>}
        <div className="inline-action grading-action"><span>{rubric.status === "draft" ? "请先保存当前评分标准版本，再开始批改。" : students.length ? `已准备 ${students.length} 份作答，将按顺序处理。` : "尚未添加学生作答。"}</span><button className="button primary" disabled={!students.length || rubric.status === "draft" || busy === "grade"} onClick={() => void grade()}>{busy === "grade" ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{busy === "grade" ? `正在批改 ${Math.round(progress * 100)}%` : "开始批改"}</button></div>
        {busy === "grade" && <div className="progress-track"><span style={{ width: `${progress * 100}%` }} /></div>}
      </section>}

      {results.length > 0 && metrics && <ResultsSection results={results} metrics={metrics} rubric={rubric ?? undefined} selected={selectedResult} answerImageUrl={selectedResult ? answerImageUrls[selectedResult.id] : undefined} artifacts={selectedResult ? artifactsByResultId[selectedResult.id] : undefined} modelCalls={selectedResult ? modelCallsByResultId[selectedResult.id] : undefined} onSelect={(id) => { setSelectedResultId(id); if (templateId) onResultSelected(templateId, id); }} templateId={templateId} regrading={busy === "regrade"} onRegrade={regrade} />}
    </div>
  );
}

function ActivityConsole({ logs, elapsed, running }: { logs: ActivityLog[]; elapsed: number; running: boolean }) {
  return <div className="activity-console" aria-live="polite">
    <div className="activity-console-header"><div><CircleGauge size={16} /><strong>生成状态日志</strong></div><span className={running ? "running" : ""}>{running ? `运行中 · ${elapsed}s` : "本次任务已结束"}</span></div>
    <div className="activity-log-list">{logs.map((log) => <div className={`activity-log ${log.status}`} key={log.id}>
      <span className="activity-log-icon">{log.status === "active" ? <LoaderCircle className="spin" size={14} /> : log.status === "error" ? <AlertTriangle size={14} /> : <Check size={14} />}</span>
      <time>{log.time}</time><p>{log.message}</p>
    </div>)}</div>
    {running && <p className="activity-note">可以切换到模型设置或其他页面，当前生成任务会继续运行。</p>}
  </div>;
}

function FinalAnswerFormula({ expression, unit }: { expression: string; unit?: string }) {
  return <span className="final-answer-formula"><MathText value={formulaWithUnit(expression, unit)} formulaByDefault /></span>;
}

function DocumentBox({ title, icon, text, images, onText, onImages, onUpload, placeholder }: { title: string; icon: React.ReactNode; text: string; images: MaterialImage[]; onText: (value: string) => void; onImages: (value: MaterialImage[]) => void; onUpload: () => void; placeholder: string }) {
  const imageInput = useRef<HTMLInputElement>(null);

  const appendImages = (files: File[], source: MaterialImage["source"]) => {
    const next = files.filter((file) => file.type.startsWith("image/")).map((file, index) => {
      const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      const namedFile = source === "paste" && (!file.name || file.name === "image.png")
        ? new File([file], `clipboard-${Date.now()}-${index + 1}.${extension}`, { type: file.type })
        : file;
      return { id: crypto.randomUUID(), file: namedFile, preview: URL.createObjectURL(namedFile), source };
    });
    if (next.length) onImages([...images, ...next]);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const pastedImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!pastedImages.length) return;
    event.preventDefault();
    appendImages(pastedImages, "paste");
  };

  const removeImage = (id: string) => {
    const target = images.find((image) => image.id === id);
    if (target) URL.revokeObjectURL(target.preview);
    onImages(images.filter((image) => image.id !== id));
  };

  return <div className="document-box" onPaste={handlePaste}>
    <div className="document-box-header"><div>{icon}<strong>{title}</strong></div><div className="document-actions"><button className="text-button" onClick={() => imageInput.current?.click()}><ImagePlus size={14} />添加图片</button><button className="text-button" onClick={onUpload}><Upload size={14} />上传文档</button></div></div>
    <textarea value={text} onChange={(event) => onText(event.target.value)} placeholder={placeholder} />
    <input ref={imageInput} hidden type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => appendImages(Array.from(event.target.files ?? []), "upload")} />
    {images.length > 0 && <div className="material-image-grid">{images.map((image) => <div className="material-image" key={image.id}><img src={image.preview} alt={`${title}附图`} /><div><strong>{image.file.name}</strong><span>{image.source === "paste" ? "剪贴板粘贴" : "本地上传"}</span></div><button className="icon-button" title="删除这张图片" onClick={() => removeImage(image.id)}><Trash2 size={15} /></button></div>)}</div>}
    <div className="document-footer"><span>{text.length ? `${text.length} 个字符` : "等待输入"}</span><span className="paste-hint"><ImagePlus size={12} />在输入框按 Ctrl+V 粘贴截图</span></div>
  </div>;
}

function RubricReview({ rubric, editingJson, rubricJson, setRubricJson, onEdit, onCancelEdit, onApplyJson, onRefine, refining, onSave, saving, templateId }: { rubric: Rubric; editingJson: boolean; rubricJson: string; setRubricJson: (value: string) => void; onEdit: () => void; onCancelEdit: () => void; onApplyJson: () => void; onRefine: (instruction: string) => Promise<void>; refining: boolean; onSave: () => void; saving: boolean; templateId: string | null }) {
  const [instruction, setInstruction] = useState("");
  return <section className="workspace-section rubric-section">
    <div className="section-title-row"><div><span className="section-index">02</span><h2>确认评分标准</h2><span className={`pill ${rubric.status}`}><Code2 size={13} />{templateId ? `已保存 v${rubric.version} · 可修改` : "结构化草稿"}</span></div><div className="header-actions"><button className="button secondary" onClick={onEdit}><Code2 size={16} />编辑 JSON</button><button className="button primary" disabled={saving || Boolean(templateId && rubric.status !== "draft")} onClick={onSave}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saving ? "保存模板中" : templateId ? rubric.status === "draft" ? "保存新版本" : "已保存" : "保存评分标准"}</button></div></div>
    <div className="rubric-refinement"><label htmlFor="rubric-refinement-prompt">补充评分细节</label><p>当前完整 JSON 会交给教师模型修改，分值结构保持不变。</p><textarea id="rubric-refinement-prompt" value={instruction} maxLength={4000} disabled={refining} onChange={(event) => setInstruction(event.target.value)} placeholder="输入需要补充的评分细节、替代解法或等价情况" /><div><span>{instruction.length} / 4000</span><button className="button dark" disabled={!instruction.trim() || refining} onClick={() => void onRefine(instruction.trim()).then(() => setInstruction("")).catch(() => undefined)}>{refining ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{refining ? "正在修改" : "交给教师模型完善"}</button></div></div>
    {rubric.warnings.length > 0 && <div className="warning-list"><AlertTriangle size={17} /><div><strong>结构校验提示</strong>{rubric.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></div>}
    {editingJson ? <div className="json-editor"><textarea value={rubricJson} onChange={(event) => setRubricJson(event.target.value)} spellCheck={false} /><div><button className="button secondary" onClick={onCancelEdit}>取消</button><button className="button dark" onClick={onApplyJson}><Check size={16} />应用修改</button></div></div> : <div className="rubric-content">
      <div className="rubric-summary"><div><span>题目</span><strong>{rubric.title}</strong></div><div><span>总分</span><strong>{rubric.totalScore} 分</strong></div><div><span>小问</span><strong>{rubric.subquestions.length}</strong></div><div><span>评分点</span><strong>{rubric.subquestions.reduce((sum, item) => sum + item.scorePoints.length, 0)}</strong></div></div>
      <div className="recognized-question"><div className="recognized-question-header"><FileText size={16} /><strong>识别到的题目原文</strong><span>保存前请核对公式、单位和小问编号</span></div>{rubric.recognizedQuestionText ? <MathText value={rubric.recognizedQuestionText} formulaByDefault /> : <p className="empty-recognition">模型未返回题目原文，请编辑 JSON 补充或重新生成。</p>}</div>
      {rubric.subquestions.map((subquestion) => <div className="subquestion" key={subquestion.id}><div className="subquestion-header"><div><strong>{subquestion.title}</strong><span>{subquestion.id}</span></div><b>{subquestion.maxScore} 分</b></div><div className="answer-rule"><span>最终答案</span><div className="formula-list">{subquestion.finalAnswers.length ? subquestion.finalAnswers.map((item, index) => <span className="formula-option" key={`${item.expression}-${index}`}><FinalAnswerFormula expression={item.expression} unit={item.unit} />{index < subquestion.finalAnswers.length - 1 && <i>/</i>}</span>) : <span>未配置</span>}</div><small>教师模型判定正确时直接满分；过程审验仅作审计</small></div><div className="rubric-table"><div className="rubric-table-head"><span>评分点</span><span>判定依据</span><span>分值</span></div>{subquestion.scorePoints.map((point) => <div className="rubric-table-row" key={point.id}><span><b>{point.id}</b>{point.title}</span><span>{point.description}<MathText value={point.expected} formulaByDefault /><ScorePointGuidance point={point} defaultOpen /></span><strong>{point.score}</strong></div>)}</div></div>)}
    </div>}
  </section>;
}

function ResultsSection({ results, metrics, rubric, selected, answerImageUrl, artifacts, modelCalls, onSelect, templateId, regrading, onRegrade }: { results: GradingResult[]; metrics: { coverage: number; traceability: number; automatic: number; review: number }; rubric?: Rubric; selected?: GradingResult; answerImageUrl?: string; artifacts?: GradingArtifact[]; modelCalls?: ModelCallHistoryEntry[]; onSelect: (id: string) => void; templateId: string | null; regrading: boolean; onRegrade: (id: string) => Promise<void> }) {
  const [artifactPreview, setArtifactPreview] = useState<GradingArtifact | null>(null);
  const currentResultCount = currentResultVersions(results).length;
  const openArtifactPreview = useCallback((artifact: GradingArtifact) => setArtifactPreview(artifact), []);
  useEffect(() => { setArtifactPreview(null); }, [selected?.id]);
  return <section className="workspace-section results-section">
    <div className="section-title-row"><div><span className="section-index">04</span><h2>批改结果与执行数据</h2></div><span className="section-meta">共 {currentResultCount} 份答卷{results.length > currentResultCount ? ` · ${results.length} 个结果版本` : ""}</span></div>
    <div className="metric-grid">
      <Metric icon={<CircleGauge size={18} />} label="规则执行覆盖率" value={percent(metrics.coverage)} detail="已完成判定的评分点" tone="green" />
      <Metric icon={<ShieldCheck size={18} />} label="证据可追溯率" value={percent(metrics.traceability)} detail="判定可定位到卷面" tone="blue" />
      <Metric icon={<Gauge size={18} />} label="自动判定率" value={percent(metrics.automatic)} detail="无须人工介入" tone="ink" />
      <Metric icon={<AlertTriangle size={18} />} label="答卷复核率" value={percent(metrics.review)} detail="包含至少一项风险" tone="amber" />
    </div>
    <div className="result-table"><div className="result-head"><span>学生</span><span>文件</span><span>得分</span><span>处理状态</span><span>耗时</span><span /></div>{results.map((result) => <button className={selected?.id === result.id ? "result-row selected" : "result-row"} key={result.id} onClick={() => onSelect(result.id)}><span><strong>{result.studentId}</strong></span><span>{result.fileName}</span><span><b>{scoreLabel(result.score, result.maximumPossibleScore)}</b> / {result.maxScore}</span><span><i className={`status-chip ${result.status}`}>{result.status === "completed" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{statusLabel(result.status)}</i></span><span>{(result.metrics.durationMs / 1000).toFixed(1)} s</span><ChevronRight size={16} /></button>)}</div>
    {selected && <>
      <ResultDetail result={selected} rubric={rubric ?? undefined} answerImageUrl={answerImageUrl} artifacts={artifacts} canRegrade={Boolean(templateId)} regrading={regrading} onRegrade={onRegrade} onPreviewArtifact={openArtifactPreview} />
      {modelCalls && <ModelCallHistory calls={modelCalls} />}
      {artifacts !== undefined && <GradingArtifactList resultId={selected.id} artifacts={artifacts} onPreview={openArtifactPreview} />}
      {artifactPreview && <GradingArtifactPreview artifact={artifactPreview} onClose={() => setArtifactPreview(null)} />}
    </>}
  </section>;
}

function Metric({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: string }) {
  return <div className={`metric-card ${tone}`}><div>{icon}<span>{label}</span></div><strong>{value}</strong><small>{detail}</small></div>;
}

function finalAnswerLabel(status: GradingResult["subquestions"][number]["finalAnswerStatus"], teacherDecision: boolean, answerPresence?: GradingResult["subquestions"][number]["answerPresence"]) {
  if (status === "missing" && answerPresence === "no_effective_answer") return "未发现有效作答";
  if (status === "uncertain" && answerPresence === "image_unreliable") return "答案区域图像不可用";
  if (!teacherDecision) return { correct: "旧版规则判定为正确", incorrect: "旧版规则判定为不等价", missing: "旧版规则未识别到答案", uncertain: "旧版规则判定不确定" }[status];
  return { correct: "教师模型判定正确", incorrect: "教师模型判定错误", missing: "教师模型判定无最终答案", uncertain: "教师模型无法确认" }[status];
}

function decisionAuditLabel(status: GradingResult["subquestions"][number]["decisions"][number]["status"]) {
  if (status === "satisfied") return "审验通过";
  if (status === "not_satisfied") return "审验未满足";
  if (status === "not_present") return "未提供有效作答";
  if (status === "unreadable") return "卷面无法辨认";
  if (status === "insufficient_evidence") return "旧版证据不足";
  return "历史结果未审验";
}

function scoringDispositionLabel(
  disposition?: GradingResult["subquestions"][number]["decisions"][number]["scoringDisposition"],
  requiresReview = false,
  status?: GradingResult["subquestions"][number]["decisions"][number]["status"]
) {
  if (disposition === "not_deducted_by_final_answer") return "最终答案正确，本项不扣分";
  if (disposition === "uncertain_no_deduction") return "旧版结果：证据不确定，待复核";
  if (disposition === "not_awarded") {
    if (status === "unreadable" || status === "insufficient_evidence") {
      return requiresReview ? "卷面无法辨认，已达到整卷人工复核阈值" : "卷面无法辨认，当前按 0 分计";
    }
    return requiresReview ? "当前不计分，需人工复核" : "未满足评分点，当前不得分";
  }
  if (disposition === "awarded_by_visual_review") return "局部视觉复核确认，计入得分";
  if (disposition === "not_awarded_by_visual_review") return requiresReview ? "局部视觉复核未确认，待人工复核" : "局部视觉复核确认，当前不得分";
  if (disposition === "partially_awarded") return "按评分标准计入部分分值";
  if (disposition === "awarded") return "按评分标准计入得分";
  return "按历史规则记录";
}

function decisionScoreLabel(decision: GradingResult["subquestions"][number]["decisions"][number]) {
  return decision.status === "insufficient_evidence" && (decision.uncertainScore ?? 0) > 0
    ? `?/${decision.maxScore}`
    : `${decision.awardedScore}/${decision.maxScore}`;
}

function gradingFlowLabel(result: GradingResult) {
  if (result.gradingPipeline === "large_question_responses_agent") return "大题 Responses Agent（无 PaddleOCR）";
  if (result.gradingPipeline === "large_question") return "大题分阶段批改";
  if (result.gradingPipeline === "small_question_ocr") return "小题 OCR 独立批改";
  if (result.gradingPipeline === "small_question_staged") return "小题视觉切片分阶段批改";
  return result.gradingMode === "vision_direct" ? "历史视觉直批" : "历史提取式兼容流程";
}

function finalAnswerSourceLabel(source: GradingResult["subquestions"][number]["finalAnswerDecisionSource"]) {
  if (source === "teacher_model") return "教师模型首判";
  if (source === "visual_local_review" || source === "unreadable_local_review") return "局部视觉复核";
  if (source === "local_numeric_review") return "数值审验";
  if (source === "missing_teacher_judgement") return "教师判定缺失";
  return "历史判定";
}

function finalAnswerReasonForDisplay(subquestion: GradingResult["subquestions"][number]): string {
  const reason = subquestion.finalAnswerReason?.trim() ?? "";
  const studentAnswer = subquestion.studentFinalAnswer?.trim() ?? "";
  if (
    subquestion.finalAnswerDecisionSource === "visual_local_review" &&
    subquestion.finalAnswerStatus !== "uncertain" &&
    studentAnswer &&
    !reason.includes(`局部视觉复核确认最终答案为“${studentAnswer}”`)
  ) {
    return `局部视觉复核确认最终答案为“${studentAnswer}”。`;
  }
  return reason;
}

function compactFinalAnswerLabel(status: GradingResult["subquestions"][number]["finalAnswerStatus"]) {
  return { correct: "答案正确", incorrect: "答案错误", missing: "未见答案", uncertain: "无法确认" }[status];
}

function subquestionAuditSummary(result: GradingResult, subquestion: GradingResult["subquestions"][number]) {
  const parts: string[] = [];
  const fullCreditByFinalAnswer = subquestion.finalAnswerStatus === "correct"
    && subquestion.decisions.length > 0
    && subquestion.decisions.every((decision) => (
      decision.decisionSource === "final_answer_authority"
      || decision.scoringDisposition === "not_deducted_by_final_answer"
    ));
  if (fullCreditByFinalAnswer) parts.push("最终答案确认正确，依规则直接满分");
  else if (subquestion.processAuditSummary) {
    const audit = subquestion.processAuditSummary;
    parts.push(`小分审验 ${audit.totalPoints} 项：通过 ${audit.satisfied}、未满足 ${audit.notSatisfied}${(audit.notPresent ?? 0) > 0 ? `、未作答 ${audit.notPresent}` : ""}${(audit.unreadable ?? audit.uncertain) > 0 ? `、无法辨认 ${audit.unreadable ?? audit.uncertain}` : ""}`);
  } else if (subquestion.decisions.length > 0) {
    parts.push(`评分点审验 ${subquestion.decisions.length} 项`);
  }

  const reviewItems = result.directVisualReviewAudit?.reviewItems.filter((item) => item.criterionId === `${subquestion.id}:final`) ?? [];
  if (reviewItems.length > 0) {
    const resultById = new Map((result.directVisualReviewAudit?.results ?? []).map((item) => [item.reviewId, item]));
    const resolved = reviewItems.filter((item) => resultById.get(item.reviewId)?.certainty === "clear").length;
    parts.push(`最终答案局部复核 ${resolved}/${reviewItems.length} 项明确`);
  } else if (result.gradingPipeline === "large_question" && subquestion.finalAnswerStatus === "correct") {
    parts.push("未触发独立局部复核");
  }
  return parts.join(" · ") || "历史记录未保存独立审验摘要";
}

function rubricReferenceAnswer(subquestion: GradingResult["subquestions"][number], rubric?: Rubric): string {
  const rubricSubquestion = rubric?.subquestions.find((candidate) => candidate.id === subquestion.id);
  if (!rubricSubquestion?.finalAnswers.length) return subquestion.referenceFinalAnswer ?? "";
  return rubricSubquestion.finalAnswers
    .map((answer) => formulaWithUnit(answer.expression, answer.unit))
    .join(" 或 ");
}

function GradingReliabilityPanel({ result, rubric, artifacts, onPreviewArtifact }: { result: GradingResult; rubric?: Rubric; artifacts?: GradingArtifact[]; onPreviewArtifact?: (artifact: GradingArtifact) => void }) {
  const summary = summarizeGradingReliability(result);
  const stateLabel = summary.level === "reliable" ? "可按当前分数使用" : summary.level === "caution" ? "建议快速核对" : "先人工复核";
  const cropBySubquestion = new Map<string, GradingArtifact>();
  for (const artifact of artifacts ?? []) {
    if (artifact.category !== "agent_region") continue;
    const stagedCrop = /^subquestion-(.+)-crop\.webp$/i.exec(artifact.fileName);
    const agentReviewCrop = /^responses-agent-local-review-(.+)\.webp$/i.exec(artifact.fileName);
    const smallBlankCrop = /^small-blank-(.+)-crop\.webp$/i.exec(artifact.fileName);
    const subquestionId = stagedCrop?.[1] ?? agentReviewCrop?.[1] ?? smallBlankCrop?.[1];
    if (subquestionId) cropBySubquestion.set(subquestionId.trim(), artifact);
  }
  return <section className={`grading-reliability-panel ${summary.level}`}>
    <header className="grading-reliability-heading">
      <span className="grading-reliability-icon">{summary.level === "reliable" ? <ShieldCheck size={20} /> : <AlertTriangle size={20} />}</span>
      <div><span>评分可信度</span><strong>{summary.headline}</strong><p>{summary.explanation}</p></div>
      <b>{stateLabel}</b>
    </header>
    <div className="grading-reliability-metrics">
      <div><span>最终答案依据</span><strong>{summary.finalAnswers.conclusive}/{summary.finalAnswers.total} 项明确</strong><small>{summary.finalAnswers.traceable} 项可定位到卷面</small></div>
      <div><span>过程 / 小分审验</span><strong>{summary.processAudit.points > 0 ? `${summary.processAudit.points} 个评分点` : "未触发"}</strong><small>{summary.pointReviewSubquestions > 0 ? `${summary.pointReviewSubquestions} 个小问进入小分审验` : `${summary.directFullCreditSubquestions} 个小问按答案直接判定`}</small></div>
      <div><span>局部视觉复核</span><strong>{summary.visualReview.triggered > 0 ? `${summary.visualReview.resolved}/${summary.visualReview.triggered} 项明确` : "未触发"}</strong><small>{summary.visualReview.unresolved > 0 ? `${summary.visualReview.unresolved} 项未闭环` : "没有未确认的局部复核"}</small></div>
      <div><span>风险信号</span><strong>{summary.pendingReviewItems} 项待复核</strong><small>{summary.lowConfidenceSignals} 个低置信信号</small></div>
    </div>
    <div className="grading-basis-list">
      <div className="grading-basis-list-heading"><div><strong>模型打分依据</strong><span>按小问汇总最终答案判定、卷面依据和审验去向</span></div><small>总分由本地计分引擎重算</small></div>
      {result.subquestions.map((subquestion) => {
        const crop = cropBySubquestion.get(subquestion.id) ?? cropBySubquestion.get(String(subquestion.id).trim());
        return <article className={`grading-basis-row ${subquestion.finalAnswerStatus}`} key={subquestion.id}>
          <div className="grading-basis-score"><strong>{scoreLabel(subquestion.score, subquestion.maximumPossibleScore)}</strong><span>/ {subquestion.maxScore}</span></div>
          <div className="grading-basis-content">
            <div className="grading-basis-title"><strong>{subquestion.id} · {subquestion.title}</strong><span className={`grading-basis-verdict ${subquestion.finalAnswerStatus}`}>{compactFinalAnswerLabel(subquestion.finalAnswerStatus)}</span><small>{finalAnswerSourceLabel(subquestion.finalAnswerDecisionSource)}{typeof subquestion.finalAnswerConfidence === "number" ? ` · ${percent(subquestion.finalAnswerConfidence)}` : ""}</small></div>
            {finalAnswerReasonForDisplay(subquestion) && <div className="grading-basis-reason"><MathText value={finalAnswerReasonForDisplay(subquestion)} formulaByDefault /></div>}
            <div className="grading-basis-facts">
              <span>学生：<MathText value={subquestion.studentFinalAnswer || "未写出"} formulaByDefault /></span>
              <span>参考：<MathText value={rubricReferenceAnswer(subquestion, rubric) || "未配置"} formulaByDefault /></span>
              <span>卷面依据：{subquestion.finalAnswerEvidenceLineIds?.length ? subquestion.finalAnswerEvidenceLineIds.join("、") : crop ? "小空高清切片定位" : subquestion.finalAnswerStatus === "missing" ? "模型确认未见答案" : "未记录定位"}</span>
            </div>
            <div className="grading-basis-crop">
              <span className="grading-basis-crop-label"><ImagePlus size={12} />答案区域截图</span>
              {(() => {
                if (!crop) return <small>未捕获有效答案区域</small>;
                const image = <img src={crop.url} alt={`${subquestion.id} 学生答案区域截图`} />;
                return onPreviewArtifact
                  ? <button type="button" title={`预览 ${crop.fileName}`} onClick={() => onPreviewArtifact(crop)}>{image}</button>
                  : image;
              })()}
            </div>
            <p className="grading-basis-audit"><ShieldCheck size={13} />{subquestionAuditSummary(result, subquestion)}</p>
          </div>
        </article>;
      })}
    </div>
    <div className="grading-attention-list">
      <strong>注意事项</strong>
      {summary.attentionItems.length > 0
        ? summary.attentionItems.map((item, index) => <p className={item.tone} key={`${item.tone}-${index}-${item.text}`}>
            {item.tone === "warning" ? <AlertTriangle size={13} /> : <FileCheck2 size={13} />}{item.text}
          </p>)
        : <p className="clear"><CheckCircle2 size={13} />未发现需要额外处理的风险项。</p>}
    </div>
  </section>;
}

export function ResultDetail({ result, rubric, answerImageUrl, artifacts, canRegrade, regrading, onRegrade, onPreviewArtifact, onCachedReplay, cachedReplaying = false, cachedReplayUnavailable = false, scoreViewTransitionName }: { result: GradingResult; rubric?: Rubric; answerImageUrl?: string; artifacts?: GradingArtifact[]; canRegrade: boolean; regrading: boolean; onRegrade: (id: string) => Promise<void>; onPreviewArtifact?: (artifact: GradingArtifact) => void; onCachedReplay?: (id: string) => Promise<void>; cachedReplaying?: boolean; cachedReplayUnavailable?: boolean; scoreViewTransitionName?: string }) {
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  useEffect(() => {
    setActiveLineId(null);
  }, [result.id]);
  const highRisk = detectHighRiskDeductions(result, rubric);
  const transcriptLines = result.ocrTranscription?.lines.length ? result.ocrTranscription.lines : result.evidence.lines;
  const activeRegion = transcriptLines.find((line) => line.id === activeLineId)?.region;
  return <div className="result-detail">
    <div className="detail-header">
      <div>
        <p className="eyebrow">逐点评分报告</p>
        <h3>{result.studentId}</h3>
        <span>{result.fileName} · 评分标准 v{result.rubricVersion} · {result.modelName}</span>
        {(result.gradingEngineVersion || result.teacherJudgementVersion) && <span className="engine-version">计分引擎 {result.gradingEngineVersion ?? "旧版"} · 教师判定 {result.teacherJudgementVersion ?? "旧版"}</span>}
        {(result.gradingPipeline || result.gradingMode) && <span className="engine-version">批改链路：{gradingFlowLabel(result)}</span>}
        {result.imagePreprocessAudit && <span className="engine-version">图像预处理：{result.imagePreprocessAudit.applied ? "本地轻度增强（后续仅使用结果图）" : "未增强/使用回退结果图"} · {result.imagePreprocessAudit.outputBytes.toLocaleString("zh-CN")} bytes</span>}
        {result.reviewPolicy && <span className="engine-version">无法辨认影响 {result.reviewPolicy.unreadableAffectedScore} 分 · 人工复核阈值 {result.reviewPolicy.unreadableScoreThreshold} 分</span>}
        {result.regradedAt && <span className="engine-version">历史重判于 {new Date(result.regradedAt).toLocaleString("zh-CN", { hour12: false })}</span>}
      </div>
      <div className="detail-summary-actions">
        {(canRegrade || onCachedReplay || cachedReplayUnavailable) && <details className="detail-reprocess-actions">
          <summary><RefreshCw size={14} />重新批改</summary>
          <div className="detail-reprocess-action-list">
            {canRegrade && <button type="button" className="button secondary" title="使用当前保存的评分标准和原始答卷重新执行完整批改流程；结果会保存为新记录" aria-label="完整重新批改当前答卷" disabled={regrading || cachedReplaying} onClick={() => void onRegrade(result.id)}>{regrading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{regrading ? "批改中" : "完整重新批改"}</button>}
            {onCachedReplay && result.gradingPipeline === "large_question" && <button type="button" className="button secondary" title="使用本条记录保存的 PaddleOCR 区块结果，跳过 OCR，重新执行教师模型与复核流程；结果会保存为新记录" aria-label="复用本答卷 OCR 重批" disabled={regrading || cachedReplaying} onClick={() => void onCachedReplay(result.id)}>{cachedReplaying ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{cachedReplaying ? "回放中" : "复用本答卷 OCR 重批"}</button>}
            {cachedReplayUnavailable && result.gradingPipeline === "large_question" && <p className="detail-reprocess-note">本条记录没有保存可复用的 OCR 审计，只能使用完整重新批改。</p>}
            {onCachedReplay && result.gradingPipeline === "large_question" && <p className="detail-reprocess-note">OCR 回放 = 复用本条记录的 OCR 原始区块与 bbox，跳过一次 OCR 请求；教师模型、复核和计分仍会重新执行。</p>}
            <p className="detail-reprocess-note">两种操作都会生成新的批改记录，当前记录和原始证据不会被覆盖。</p>
          </div>
        </details>}
        <div className="score-block prism-score-emphasis" key={result.id}><strong style={scoreViewTransitionName ? { viewTransitionName: scoreViewTransitionName } as CSSProperties : undefined}>{scoreLabel(result.score, result.maximumPossibleScore)}</strong><span>/ {result.maxScore} 分{result.maximumPossibleScore !== undefined && result.maximumPossibleScore > result.score ? "（含待复核分值）" : ""}</span></div>
      </div>
    </div>
    {highRisk.isHighRisk && (
      <section className={`high-risk-alert-panel ${highRisk.hasExtractedMatchRisk ? "critical" : ""}`}>
        <div className="high-risk-alert-header">
          <span className="high-risk-alert-icon">
            <AlertTriangle size={18} />
          </span>
          <div>
            <strong>
              {highRisk.hasExtractedMatchRisk
                ? "【高风险复核预警】本卷已自动提交，但存在【提取答案命中参考答案、因存疑判 0 分】的小问！"
                : "【存疑扣分预警】本卷已自动提交，但存在因机器无法确认作答而扣除分数的小问！"}
            </strong>
            <div className="high-risk-alert-body">
              {highRisk.items.map((item) => (
                <p key={item.subquestionId}>
                  • 第 {item.subquestionTitle} 问：学生提取为“{item.studentAnswer || "未写出"}”，参考答案为“{item.referenceAnswer || "未配置"}”，因卷面存疑被判 0/{item.lostScore} 分（原因：{item.reason}）。
                </p>
              ))}
              <p className="high-risk-alert-action">
                {highRisk.hasExtractedMatchRisk
                  ? "若卷面实际有效书写符合参考答案（如涂黑前面重写 A），请及时在阅卷平台手动补回相应得分！"
                  : "请仔细核对学生原始答卷，确认是否属于机器识别过于苛刻导致的误扣。"}
              </p>
            </div>
          </div>
        </div>
      </section>
    )}
    {result.responsesAgentAudit && <ResponsesAgentAuditPanel audit={result.responsesAgentAudit} artifacts={artifacts} onPreview={onPreviewArtifact ?? (() => undefined)} />}
    <GradingReliabilityPanel result={result} rubric={rubric} artifacts={artifacts} onPreviewArtifact={onPreviewArtifact} />
    <div className="detail-columns">
      <div className="grading-report">{result.subquestions.map((subquestion) => {
        const teacherDecision = Boolean(subquestion.finalAnswerDecisionSource);
        const grantsFullCredit = subquestion.decisions.length > 0 && subquestion.decisions.every((decision) => decision.scoringDisposition === "not_deducted_by_final_answer");
        const rubricSubquestion = rubric?.subquestions.find((candidate) => candidate.id === subquestion.id);
        const highRiskItem = highRisk.items.find((item) => item.subquestionId === subquestion.id);
        return <div className="report-question" key={subquestion.id}>
          <div className="report-question-title"><strong>{subquestion.title}</strong><span>{scoreLabel(subquestion.score, subquestion.maximumPossibleScore)}/{subquestion.maxScore} 分</span></div>
          <div className={`final-verdict ${subquestion.finalAnswerStatus}`}>
            <div className="final-verdict-title">
            {subquestion.finalAnswerStatus === "correct" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
            <strong>{finalAnswerLabel(subquestion.finalAnswerStatus, teacherDecision, subquestion.answerPresence)}</strong>
              <span>{subquestion.finalAnswerDecisionSource === "teacher_model" ? `教师模型 · ${percent(subquestion.finalAnswerConfidence ?? 0)}` : subquestion.finalAnswerDecisionSource === "visual_local_review" ? `局部视觉复查 · ${percent(subquestion.finalAnswerConfidence ?? 0)}` : subquestion.finalAnswerDecisionSource === "unreadable_local_review" ? `局部视觉复查 · ${percent(subquestion.finalAnswerConfidence ?? 0)}` : subquestion.finalAnswerDecisionSource === "local_numeric_review" ? "审验模型冲突" : subquestion.finalAnswerDecisionSource === "missing_teacher_judgement" ? "教师判定缺失" : "旧版结果"}</span>
            </div>
            {finalAnswerReasonForDisplay(subquestion) && <div className="final-verdict-reason"><MathText value={finalAnswerReasonForDisplay(subquestion)} formulaByDefault /></div>}
            {(subquestion.studentFinalAnswer || subquestion.referenceFinalAnswer) && <div className="answer-comparison">
              <div><span className="answer-label">学生答案</span><MathText value={subquestion.studentFinalAnswer || "未写出"} formulaByDefault /></div>
              <div><span className="answer-label">参考答案</span><MathText value={rubricReferenceAnswer(subquestion, rubric) || "未配置"} formulaByDefault /></div>
            </div>}
            {highRiskItem && (
              <div className={`subquestion-high-risk-callout ${highRiskItem.isExtractedMatch ? "critical" : ""}`}>
                <AlertTriangle size={14} />
                <span>
                  {highRiskItem.isExtractedMatch
                    ? `⚠️ 高风险提示：提取答案与参考答案一致（${highRiskItem.studentAnswer}），但因卷面涂改或字迹存疑被判 0 分已提交！`
                    : `⚠️ 存疑扣分提示：该小问因机器存疑被扣除 ${highRiskItem.lostScore} 分已提交！`}
                </span>
              </div>
            )}
            {grantsFullCredit && teacherDecision && <p className="full-credit-note">最终答案正确且评分标准允许省略过程，该小问保持满分；过程审验问题仅供查看。</p>}
          </div>
          {subquestion.processAuditSummary && <div className="process-audit-summary"><span>过程审验 {subquestion.processAuditSummary.totalPoints} 项</span><b className="audit-passed">{subquestion.processAuditSummary.satisfied} 项通过</b><b className="audit-failed">{subquestion.processAuditSummary.notSatisfied} 项错误</b>{(subquestion.processAuditSummary.notPresent ?? 0) > 0 && <b className="audit-missing">{subquestion.processAuditSummary.notPresent} 项未作答</b>}{(subquestion.processAuditSummary.unreadable ?? subquestion.processAuditSummary.uncertain) > 0 && <b className="audit-unreadable">{subquestion.processAuditSummary.unreadable ?? subquestion.processAuditSummary.uncertain} 项无法辨认</b>}{subquestion.processAuditSummary.reviewRequired > 0 && <strong>{subquestion.processAuditSummary.reviewRequired} 项待复核</strong>}</div>}
          {subquestion.decisions.map((decision) => {
            const scorePoint = rubricSubquestion?.scorePoints.find((candidate) => candidate.id === decision.pointId);
            return <div className="decision-row" key={decision.pointId}>
              <span className={`decision-icon ${decision.status}`}>{decision.status === "satisfied" ? <Check size={14} /> : decision.status === "not_satisfied" || decision.status === "not_present" ? <XCircle size={14} /> : <AlertTriangle size={14} />}</span>
              <div>
                <div className="decision-heading"><strong>{decision.pointId}</strong><span className={`decision-audit-status ${decision.status}`}>{decisionAuditLabel(decision.status)}</span><small className={confidenceClass(decision.confidence)}>置信度 {percent(decision.confidence)}</small></div>
                <p className="decision-reason"><MathText value={decision.reason} formulaByDefault /></p>
                <div className="decision-reference-grid">
                  <div className="decision-reference-card evidence">
                    <span className="decision-reference-label">卷面证据</span>
                    {decision.evidenceQuote ? <MathText value={decision.evidenceQuote} formulaByDefault /> : <p>未找到可引用的卷面证据</p>}
                  </div>
                  {scorePoint && <div className="decision-reference-card standard">
                    <span className="decision-reference-label">评分标准 · {scorePoint.score} 分</span>
                    <strong>{scorePoint.title}</strong>
                    {scorePoint.description && <MathText value={scorePoint.description} formulaByDefault />}
                    {scorePoint.expected && <div className="decision-standard-expected"><span>判分依据</span><MathText value={scorePoint.expected} formulaByDefault /></div>}
                    <ScorePointGuidance point={scorePoint} />
                  </div>}
                </div>
                <small className={`decision-scoring ${decision.scoringDisposition ?? "legacy"}`}>{scoringDispositionLabel(decision.scoringDisposition, decision.requiresReview, decision.status)}{decision.status === "insufficient_evidence" && decision.uncertainScore ? `；旧版待复核 ${decision.uncertainScore} 分` : ""}</small>
              </div>
              <b>{decisionScoreLabel(decision)}</b>
            </div>;
          })}
          {subquestion.auditDeductions && subquestion.auditDeductions.length > 0 && <div className="audit-deduction-list"><strong>扣分点审验</strong>{subquestion.auditDeductions.map((deduction) => <p key={deduction.ruleId}><b>{deduction.ruleId}</b>：<MathText value={deduction.reason} formulaByDefault />；{deduction.scoringDisposition === "not_deducted_by_final_answer" ? "最终答案正确，本次不扣分" : deduction.scoringDisposition === "not_deducted_by_score_floor" ? "当前已无可扣分值，本次不扣分" : `扣 ${deduction.deductedScore} 分`}；置信度 {percent(deduction.confidence)}</p>)}</div>}
        </div>;
      })}</div>
      <aside className="transcript-panel">
        <div className="transcript-title answer-sheet-title"><ImagePlus size={16} /><strong>学生答卷</strong><span>{result.fileName}</span></div>
        <AnswerImageViewer imageUrl={answerImageUrl} fileName={result.fileName} region={activeRegion} />
        <div className="transcript-subtitle"><FileText size={15} /><strong>卷面转录</strong><span>{transcriptLines.length} 行{result.ocrTranscription ? ` · OCR ${result.ocrTranscription.blockCount} 块 · 教师核验 ${result.ocrTranscription.verifiedBlockCount} 块` : ""}</span></div>
        {result.ocrTranscription && result.ocrTranscription.missingBlockIds.length > 0 && <div className="transcript-audit-note">仍有 {result.ocrTranscription.missingBlockIds.length} 个 OCR 区块未返回教师核验，未作为评分依据。</div>}
        {transcriptLines.map((line) => {
        const latex = line.latex?.trim();
        const originalText = line.text?.trim() ?? "";
        const showOriginal = Boolean(latex && originalText && latex !== originalText);
        const locatable = Boolean(line.region);
        const blockMetadata = "blockId" in line && "blockLabel" in line
          ? { blockId: String(line.blockId), blockLabel: String(line.blockLabel) }
          : undefined;
        return <button type="button" title={blockMetadata ? `OCR ${blockMetadata.blockId} · ${blockMetadata.blockLabel}` : undefined} className={`transcript-line ${line.status} ${line.confidence < LOW_CONFIDENCE_THRESHOLD ? "low-confidence" : ""} ${locatable ? "locatable" : ""} ${activeLineId === line.id ? "active" : ""}`} key={line.id} onClick={() => locatable && setActiveLineId((current) => current === line.id ? null : line.id)}>
          <span>{line.id}</span>
          <div className="transcript-line-content">
            {showOriginal && <strong className="transcript-original">{line.text}</strong>}
            <MathText value={latex || line.text || "[空白]"} formulaByDefault className="transcript-formula" />
          </div>
          <small className={confidenceClass(line.confidence)}>{percent(line.confidence)}</small>
        </button>;
      })}</aside>
    </div>
  </div>;
}

const gradingArtifactCategoryLabels: Record<GradingArtifact["category"], string> = {
  preprocessed_answer: "预处理答卷图",
  material: "题目/参考图片",
  ocr: "PaddleOCR",
  model: "模型调用",
  result: "批改结果",
  agent_region: "Agent 局部图"
};

function isImageArtifact(artifact: GradingArtifact) {
  return artifact.mimeType.toLowerCase().startsWith("image/");
}

export function GradingArtifactList({ resultId, artifacts, onPreview }: { resultId: string; artifacts: GradingArtifact[]; onPreview: (artifact: GradingArtifact) => void }) {
  return <section className="grading-artifacts">
    <div className="grading-artifacts-heading">
      <div><FolderOpen size={16} /><strong>本次批改缓存文件</strong><span>{artifacts.length} 个，可预览或下载</span></div>
      <small>目录：grading-artifacts/{resultId}</small>
    </div>
    {artifacts.length > 0 ? <div className="grading-artifact-grid">{artifacts.map((artifact) => {
      const content = <><div><strong>{artifact.fileName}</strong><span>{gradingArtifactCategoryLabels[artifact.category]} · {artifact.bytes.toLocaleString("zh-CN")} bytes</span></div>{isImageArtifact(artifact) ? <Eye size={14} /> : <Download size={14} />}</>;
      return isImageArtifact(artifact)
        ? <button type="button" className="grading-artifact-link grading-artifact-button" key={artifact.id} title={`预览 ${artifact.fileName}`} onClick={() => onPreview(artifact)}>{content}</button>
        : <a className="grading-artifact-link" href={artifact.url} download={artifact.fileName} key={artifact.id} title={`下载 ${artifact.fileName}`}>{content}</a>;
    })}</div> : <p className="grading-artifacts-empty">该历史记录没有可访问的批改产物（旧记录可能未启用文件缓存）。</p>}
  </section>;
}

export function GradingArtifactPreview({ artifact, onClose }: { artifact: GradingArtifact; onClose: () => void }) {
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setLoadFailed(false);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [artifact.url, onClose]);

  return createPortal(<div className="grading-artifact-modal" role="dialog" aria-modal="true" aria-label={`${artifact.fileName} 批改产物预览`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="grading-artifact-modal-toolbar">
      <div><strong title={artifact.fileName}>{artifact.fileName}</strong><span>{gradingArtifactCategoryLabels[artifact.category]} · {artifact.bytes.toLocaleString("zh-CN")} bytes</span></div>
      <div className="grading-artifact-modal-actions">
        <a className="icon-button" href={artifact.url} download={artifact.fileName} title="下载缓存文件" aria-label="下载缓存文件"><Download size={17} /></a>
        <button type="button" className="icon-button grading-artifact-close-button" title="关闭预览 (Esc)" aria-label="关闭预览" onClick={onClose}><X size={19} /></button>
      </div>
    </div>
    <div className="grading-artifact-modal-viewport">
      {loadFailed ? <div className="grading-artifact-modal-error"><ImagePlus size={28} /><strong>缓存图片加载失败</strong><span>请确认批改产物仍保存在本机缓存目录。</span></div> : <img src={artifact.url} alt={`${artifact.fileName} 批改产物`} onError={() => setLoadFailed(true)} />}
    </div>
  </div>, document.body);
}

function ResponsesAgentAuditPanel({ audit, artifacts, onPreview }: { audit: NonNullable<GradingResult["responsesAgentAudit"]>; artifacts?: GradingArtifact[]; onPreview: (artifact: GradingArtifact) => void }) {
  const artifactByFileName = new Map((artifacts ?? []).map((artifact) => [artifact.fileName, artifact]));
  const artifactFor = (fileName?: string) => fileName ? artifactByFileName.get(fileName) : undefined;
  const finalBasis = audit.finalBasis ?? [];
  const reviewReasons = audit.reviewReasons ?? [];
  return <section className="responses-agent-audit-panel">
    <div className="responses-agent-audit-heading"><div><ShieldCheck size={16} /><strong>Responses Agent 运行审计</strong></div><span>{audit.rounds.length} 轮 · {audit.transcriptionLineCount} 行视觉转录 · {audit.durationMs} ms</span></div>
    <div className="responses-agent-audit-summary"><span>模型：<b>{audit.model}</b></span><span>工具额度：<b>{audit.maxToolRounds} 轮 / {audit.maxRegions} 个区域</b></span><span>云端保存：<b>{audit.store ? "开启" : "关闭（本地审计）"}</b></span>{reviewReasons.length > 0 && <span className="warning">风险：<b>{reviewReasons.length} 项</b></span>}</div>
    <details className="responses-agent-final-basis" open><summary>最终采用依据（{finalBasis.length} 条）</summary>{finalBasis.length > 0 ? <ol>{finalBasis.map((basis, index) => <li key={`${index}-${basis}`}>{basis}</li>)}</ol> : <p>未保存最终依据；请结合下方轮次和卷面证据人工核对。</p>}</details>
    {audit.inputImages.length > 0 && <details className="responses-agent-audit-section"><summary>输入图片、处理参数与哈希（{audit.inputImages.length} 张）</summary><div className="responses-agent-audit-image-list">{audit.inputImages.map((image, index) => { const artifact = artifactFor(image.artifactFileName); return <div className="responses-agent-audit-image" key={`${image.sha256}-${index}`}>{artifact ? <button type="button" className="responses-agent-image-button" title={`预览 ${artifact.fileName}`} onClick={() => onPreview(artifact)}><img src={artifact.url} alt={image.label ?? `Agent 输入图 ${index + 1}`} /></button> : <span className="responses-agent-audit-image-placeholder">产物未保存</span>}<div><strong>{image.label ?? `图片 ${index + 1}`}</strong><small>{image.role} · {image.mimeType} · {image.bytes.toLocaleString("zh-CN")} bytes · SHA-256 {image.sha256}</small>{image.audit && <small>处理：{image.audit.operations.join(" → ") || "无"} · 灰度 {image.audit.grayscale ? "是" : "否"} · WebP q{image.audit.quality}</small>}</div></div>; })}</div></details>}
    <div className="responses-agent-round-list">{audit.rounds.map((round) => <details className="responses-agent-round" key={`${round.round}-${round.responseId ?? "no-id"}`}><summary><span>第 {round.round} 轮</span><span>{round.status ?? "未知状态"}</span><span>{round.responseId ? `Response ${round.responseId}` : "无 response id"}</span><span>{round.outputItemTypes.join("、") || "无输出项"}</span><span>{round.durationMs} ms</span></summary>{round.toolCalls.length > 0 && <div className="responses-agent-tool-list">{round.toolCalls.map((tool) => <article className="responses-agent-tool" key={tool.callId}><div><strong>{tool.name === "unknown" ? `未知工具：${tool.requestedName ?? "未提供名称"}` : tool.name}</strong><span>call_id: {tool.callId}</span><span className={tool.status === "completed" || tool.status === "deduplicated" ? "success" : "warning"}>{tool.status}</span><span>{tool.durationMs} ms</span></div><small>参数：{JSON.stringify(tool.arguments)}{tool.requestedName ? ` · 模型请求名称：${tool.requestedName}` : ""}</small>{tool.regions.map((region) => { const artifact = artifactFor(region.artifactFileName); return <div className="responses-agent-region" key={`${tool.callId}-${region.regionId}`}>{artifact ? <button type="button" className="responses-agent-image-button" title={`预览 ${artifact.fileName}`} onClick={() => onPreview(artifact)}><img src={artifact.url} alt={`局部 ${region.regionId}`} /></button> : <span className="responses-agent-region-placeholder">局部图未找到</span>}<span>{region.regionId} · {region.kind} · normalized [{region.normalizedRegion.join(", ")}] · pixels [{region.pixelRegion.join(", ")}]</span><small>SHA-256 {region.imageSha256 || "未生成"} · 来源 {region.sourceToolCallIds.join(", ") || "无"}</small></div>; })}</article>)}</div>}{round.rawResponse && <details className="responses-agent-raw"><summary>展开本轮原始 JSON</summary><pre>{round.rawResponse}</pre></details>}</details>)}</div>
    {audit.independentVerifier && <details className="responses-agent-verifier" open={audit.independentVerifier.reviewRequired}><summary>独立高风险审验：{audit.independentVerifier.status} · {audit.independentVerifier.verdict ?? "未返回结论"} · {audit.independentVerifier.conflicts.length} 项冲突</summary><div className="responses-agent-verifier-body"><p>{audit.independentVerifier.summary ?? audit.independentVerifier.error ?? ""}</p>{audit.independentVerifier.conflicts.map((conflict, index) => <div key={`${conflict.subquestionId}-${conflict.pointId ?? ""}-${index}`}><strong>{conflict.subquestionId}{conflict.pointId ? `:${conflict.pointId}` : ""} · {conflict.kind}</strong><span>主教师：{conflict.primaryStatus}；独立审验：{conflict.verifierStatus}</span><p>{conflict.reason}</p><small>证据行：{conflict.evidenceLineIds.join("、") || "未引用"}</small></div>)}</div>{audit.independentVerifier.rawResponse && <details className="responses-agent-raw"><summary>展开独立审验原始 JSON</summary><pre>{audit.independentVerifier.rawResponse}</pre></details>}</details>}
    {reviewReasons.length > 0 && <details className="responses-agent-audit-section"><summary>展开风险原因</summary>{reviewReasons.map((reason, index) => <p key={`${index}-${reason}`}>{reason}</p>)}</details>}
  </section>;
}

function AnswerImageViewer({ imageUrl, fileName, region }: {
  imageUrl?: string;
  fileName: string;
  region?: [number, number, number, number];
}) {
  const [expanded, setExpanded] = useState(false);
  const [scale, setScale] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [offset, setOffset] = useState<ViewerPoint>({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState<ViewerSize>({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [loadFailed, setLoadFailed] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    start: ViewerPoint;
    origin: ViewerPoint;
  } | null>(null);

  const fitScale = useMemo(
    () => calculateImageFitScale(naturalSize, viewportSize),
    [naturalSize, viewportSize]
  );

  useEffect(() => {
    setExpanded(false);
    setScale(1);
    setFitMode(true);
    setOffset({ x: 0, y: 0 });
    setViewportSize({ width: 0, height: 0 });
    setNaturalSize({ width: 0, height: 0 });
    setLoadFailed(false);
  }, [imageUrl]);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded || !viewportRef.current) return;
    const viewport = viewportRef.current;
    const updateViewportSize = () => {
      const bounds = viewport.getBoundingClientRect();
      setViewportSize({ width: bounds.width, height: bounds.height });
    };
    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [expanded]);

  useEffect(() => {
    if (!expanded || !fitMode || viewportSize.width <= 0 || naturalSize.width <= 0) return;
    setScale(fitScale);
    setOffset({ x: 0, y: 0 });
  }, [expanded, fitMode, fitScale, naturalSize.width, viewportSize.width]);

  useEffect(() => {
    if (!expanded || fitMode) return;
    setOffset((current) => clampImageOffset(current, naturalSize, viewportSize, scale));
  }, [expanded, fitMode, naturalSize, scale, viewportSize]);

  const regionStyle = region && naturalSize.width > 0 && naturalSize.height > 0 ? {
    left: `${Math.max(0, region[0]) / naturalSize.width * 100}%`,
    top: `${Math.max(0, region[1]) / naturalSize.height * 100}%`,
    width: `${Math.max(0, region[2]) / naturalSize.width * 100}%`,
    height: `${Math.max(0, region[3]) / naturalSize.height * 100}%`
  } : undefined;
  const handleLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
    setLoadFailed(false);
  };

  const openExpanded = () => {
    setFitMode(true);
    setOffset({ x: 0, y: 0 });
    setExpanded(true);
  };

  const fitToWindow = useCallback(() => {
    setFitMode(true);
    setScale(fitScale);
    setOffset({ x: 0, y: 0 });
  }, [fitScale]);

  const changeScale = useCallback((requestedScale: number, anchor?: ViewerPoint) => {
    const nextScale = clampImageScale(requestedScale, fitScale);
    if (Math.abs(nextScale - scale) < 0.0001) return;
    const nextOffset = anchor
      ? imageOffsetAfterZoom(offset, scale, nextScale, anchor, viewportSize)
      : { x: offset.x * nextScale / scale, y: offset.y * nextScale / scale };
    setScale(nextScale);
    setFitMode(Math.abs(nextScale - fitScale) < 0.0001);
    setOffset(clampImageOffset(nextOffset, naturalSize, viewportSize, nextScale));
  }, [fitScale, naturalSize, offset, scale, viewportSize]);

  const showActualSize = useCallback(() => {
    changeScale(1);
  }, [changeScale]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        changeScale(scale * 1.2);
      } else if (event.key === "-") {
        event.preventDefault();
        changeScale(scale / 1.2);
      } else if (event.key === "0") {
        event.preventDefault();
        showActualSize();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        fitToWindow();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changeScale, expanded, fitToWindow, scale, showActualSize]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    changeScale(scale * Math.exp(-event.deltaY * 0.0015), anchor);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const canPan = naturalSize.width * scale > viewportSize.width
      || naturalSize.height * scale > viewportSize.height;
    if (!canPan) return;
    dragRef.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: offset
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset(clampImageOffset({
      x: drag.origin.x + event.clientX - drag.start.x,
      y: drag.origin.y + event.clientY - drag.start.y
    }, naturalSize, viewportSize, scale));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const toggleActualSize = () => {
    if (Math.abs(scale - fitScale) < 0.01) showActualSize();
    else fitToWindow();
  };

  const modal = expanded && imageUrl && !loadFailed ? <div
    ref={dialogRef}
    className="answer-image-modal"
    role="dialog"
    aria-modal="true"
    aria-label={`${fileName} 原始答卷大图`}
    tabIndex={-1}
  >
    <div className="answer-image-modal-toolbar">
      <strong title={fileName}>{fileName}</strong>
      <div className="answer-image-modal-actions">
        <button type="button" className="icon-button" title="缩小" disabled={scale <= Math.min(0.25, fitScale) + 0.001} onClick={() => changeScale(scale / 1.2)}><ZoomOut size={18} /></button>
        <output aria-label="当前缩放比例">{Math.round(scale * 100)}%</output>
        <button type="button" className="icon-button" title="放大" disabled={scale >= IMAGE_VIEWER_MAX_SCALE - 0.001} onClick={() => changeScale(scale * 1.2)}><ZoomIn size={18} /></button>
        <span className="answer-image-modal-divider" />
        <button type="button" className={`icon-button ${fitMode ? "active" : ""}`} title="适应窗口 (F)" onClick={fitToWindow}><Maximize2 size={17} /></button>
        <button type="button" className="answer-image-actual-button" title="按原始像素显示 (0)" onClick={showActualSize}>100%</button>
        <button type="button" className="icon-button answer-image-close-button" title="关闭 (Esc)" onClick={() => setExpanded(false)}><X size={19} /></button>
      </div>
    </div>
    <div
      ref={viewportRef}
      className={`answer-image-modal-viewport ${dragging ? "dragging" : ""}`}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={toggleActualSize}
    >
      <div
        className="answer-image-modal-canvas"
        style={{
          width: `${naturalSize.width * scale}px`,
          height: `${naturalSize.height * scale}px`,
          transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`
        }}
      >
        <img src={imageUrl} alt={`${fileName} 原始答卷大图`} onLoad={handleLoad} onError={() => setLoadFailed(true)} draggable={false} />
        {regionStyle && <span className="answer-region-highlight" style={regionStyle} />}
      </div>
    </div>
  </div> : null;

  return <div className="answer-image-viewer">
    <div className="answer-image-toolbar"><strong>原始图像</strong>{imageUrl && !loadFailed && <button type="button" className="icon-button" title="放大查看原始答卷" onClick={openExpanded}><Maximize2 size={15} /></button>}</div>
    {!imageUrl || loadFailed ? <div className="answer-image-empty"><ImagePlus size={24} /><span>{loadFailed ? "原始答卷图像加载失败" : "该结果没有可用的原始答卷图像"}</span></div> : <div className="answer-image-scroll">
      <button type="button" className="answer-image-canvas" title="点击放大查看" onClick={openExpanded}>
        <img src={imageUrl} alt={`${fileName} 原始答卷`} onLoad={handleLoad} onError={() => setLoadFailed(true)} />
        {regionStyle && <span className="answer-region-highlight" style={regionStyle} />}
      </button>
    </div>}
    {modal && createPortal(modal, document.body)}
  </div>;
}

function HistoryPage({ revision, onOpen }: { revision: number; onOpen: (id: string) => void }) {
  const [templates, setTemplates] = useState<GradingTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setTemplates(await api<GradingTemplateSummary[]>("/api/templates?includeBuiltIn=1")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "历史记录读取失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, revision]);

  return <div className="page history-page">
    <header className="page-header"><div><p className="eyebrow">本机持久化记录</p><h1>历史记录</h1><p>重新打开已保存评分标准，查看过往结果或继续批改新答卷。</p></div><button className="button secondary" disabled={loading} onClick={() => void refresh()}>{loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}刷新</button></header>
    {error && <div className="error-banner"><AlertTriangle size={17} /><span>{error}</span></div>}
    <section className="history-section">
      <div className="history-head"><span>题目模板</span><span>满分</span><span>题图</span><span>已批改</span><span>最近使用</span><span /></div>
      {templates.map((template) => <button className="history-row" key={template.id} onClick={() => onOpen(template.id)}>
        <span><strong>{template.title}</strong><small>创建于 {new Date(template.createdAt).toLocaleString("zh-CN", { hour12: false })}</small></span>
        <b>{template.totalScore} 分</b>
        <span>{template.questionImageCount + template.referenceImageCount} 张</span>
        <span>{template.gradingCount} 份</span>
        <time>{new Date(template.updatedAt).toLocaleString("zh-CN", { hour12: false })}</time>
        <ChevronRight size={17} />
      </button>)}
      {!loading && templates.length === 0 && <div className="empty-state"><History size={28} /><strong>还没有历史模板</strong><p>确认并保存评分标准后会自动出现在这里。</p></div>}
    </section>
  </div>;
}

const scopeLabels = systemLogScopeLabels;

function LogsPage({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<SystemLogSnapshot>({ activeOperations: [], entries: [], serverTime: "" });
  const [scope, setScope] = useState("all");
  const [error, setError] = useState("");
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setSnapshot(await api<SystemLogSnapshot>("/api/logs?limit=500")); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "日志读取失败"); }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const entries = scope === "all" ? snapshot.entries : snapshot.entries.filter((entry) => entry.scope === scope);

  const clear = async () => {
    await api("/api/logs", { method: "DELETE" });
    await refresh();
  };

  const forceStop = async (operationId: string, label: string) => {
    if (!window.confirm(`确定强制停止“${label}”吗？当前模型请求会立即中断。`)) return;
    setStoppingId(operationId);
    try {
      await api(`/api/operations/${encodeURIComponent(operationId)}/force-stop`, { method: "POST" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "强制停止失败");
    } finally {
      setStoppingId(null);
    }
  };

  return <div className="page logs-page">
    <header className="page-header"><div><p className="eyebrow">可审计运行轨迹</p><h1>运行日志</h1><p>查看模型调用、模型判分、分数汇总和数据保存停在哪一步。</p></div><div className="header-actions"><button className="button secondary" onClick={() => void refresh()}><RefreshCw size={16} />立即刷新</button><button className="icon-button bordered" title="清空已完成日志" onClick={() => void clear()}><Trash2 size={16} /></button></div></header>
    {error && <div className="error-banner"><AlertTriangle size={17} /><span>{error}</span></div>}
    <section className="operations-section">
      <div className="logs-section-heading"><div><LoaderCircle className={snapshot.activeOperations.length ? "spin" : ""} size={17} /><h2>当前运行状态</h2></div><span>{snapshot.activeOperations.length ? `${snapshot.activeOperations.length} 个操作进行中` : "系统空闲"}</span></div>
      {snapshot.activeOperations.length > 0 ? <div className="active-operation-grid">{snapshot.activeOperations.map((operation) => <div className="active-operation" key={operation.id}><div><span>{scopeLabels[operation.scope]}</span><time>已运行 {Math.max(0, Math.floor((Date.now() - new Date(operation.startedAt).getTime()) / 1000))}s</time></div><strong>{operation.label}</strong><p>当前步骤：{operation.step}</p><small>操作 ID：{operation.id}</small>{operation.cancellable && <button className="force-stop-operation" disabled={stoppingId !== null} onClick={() => void forceStop(operation.id, operation.label)}>{stoppingId === operation.id ? <LoaderCircle className="spin" size={13} /> : <Square size={12} />}{stoppingId === operation.id ? "正在停止" : "强制停止"}</button>}</div>)}</div> : <div className="idle-state"><CheckCircle2 size={18} /><span>当前没有阻塞或等待中的后台操作</span></div>}
    </section>
    <section className="logs-section">
      <div className="logs-toolbar"><div><ScrollText size={16} /><h2>最近事件</h2><span>{entries.length} 条</span></div><label><span>范围</span><select value={scope} onChange={(event) => setScope(event.target.value)}><option value="all">全部</option>{Object.entries(scopeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
      <div className="log-table"><div className="log-head"><span>时间</span><span>状态</span><span>范围 / 步骤</span><span>事件</span></div>{entries.map((entry) => <div className={`log-row ${entry.level}`} key={entry.id}><time>{new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}</time><span><i className={`log-status ${entry.status}`}>{logStatusLabel(entry.status)}</i></span><span><strong>{scopeLabels[entry.scope]}</strong><small>{entry.step}</small></span><div><p>{entry.message}</p>{isModelCallLog(entry) ? <ModelCallDetails details={entry.details as unknown as ModelCallLogDetails} compact /> : <LogDetailsSummary details={entry.details} />}</div></div>)}</div>
      {entries.length === 0 && <div className="empty-state"><ScrollText size={28} /><strong>还没有运行日志</strong><p>生成评分规则或批改答卷后会记录完整步骤。</p></div>}
    </section>
  </div>;
}

function isModelCallLog(entry: SystemLogEntry): boolean {
  return entry.scope === "model" && entry.details?.kind === "model_call";
}

export default App;
