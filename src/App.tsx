import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertTriangle, Check, CheckCircle2, ChevronRight, CircleGauge,
  ClipboardCheck, CloudCog, Code2, FileCheck2, FileText, Gauge, ImagePlus,
  History, KeyRound, LoaderCircle, LockKeyhole, Maximize2, Play, RefreshCw, Save,
  ScrollText, ShieldCheck, Sparkles, Trash2, Upload, X, XCircle, ZoomIn, ZoomOut
} from "lucide-react";
import { DEFAULT_GRADING_MODE, DEFAULT_MODEL_TIMEOUT_MS, DEFAULT_TEACHER_REASONING_EFFORT, DEFAULT_UNREADABLE_REVIEW_THRESHOLD } from "../shared/types";
import type {
  GradingResult, GradingTemplateDetail, GradingTemplateSummary, ModelConfigInput,
  ModelCallLogDetails, PublicModelConfig, Rubric, SystemLogEntry, SystemLogSnapshot
} from "../shared/types";
import { api, uploadDocument } from "./api";
import { MathText } from "./Formula";
import { directionFromPopState, replaceRoute, runRouteTransition } from "./navigation";

type View = "workspace" | "history" | "logs" | "models";
type AppRoute = { view: View; templateId?: string; resultId?: string };
type StudentFile = { id: string; studentId: string; file: File; preview: string };
type MaterialImage = { id: string; file: File; preview: string; source: "paste" | "upload" };
type ActivityLog = { id: string; time: string; message: string; status: "done" | "active" | "error" };

const defaultConfig: ModelConfigInput = {
  name: "默认 OpenAI 兼容服务",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  visionModel: "",
  textModel: "",
  timeoutMs: DEFAULT_MODEL_TIMEOUT_MS,
  maxRetries: 1,
  maxConcurrency: 2,
  maxOutputTokens: 4096,
  unreadableReviewThreshold: DEFAULT_UNREADABLE_REVIEW_THRESHOLD,
  gradingMode: DEFAULT_GRADING_MODE,
  teacherReasoningEffort: DEFAULT_TEACHER_REASONING_EFFORT,
  supportsJsonSchema: true,
  supportsJsonObject: true,
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
  if (value < 0.6) return "low-confidence";
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
  const [testing, setTesting] = useState<"text" | "vision" | null>(null);
  const [testResult, setTestResult] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!current) return;
    setForm({
      ...current,
      apiKey: ""
    });
  }, [current]);

  const update = <K extends keyof ModelConfigInput>(key: K, value: ModelConfigInput[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const applyCurrentConfig = async () => {
    await api<PublicModelConfig>("/api/model-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });
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

  const test = async (mode: "text" | "vision") => {
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
          <label><span>多模态模型</span><input value={form.visionModel} onChange={(event) => update("visionModel", event.target.value)} placeholder="vision-model-name" /></label>
          <label><span>文本模型</span><input value={form.textModel} onChange={(event) => update("textModel", event.target.value)} placeholder="text-model-name" /></label>
          <label><span>超时时间（毫秒）</span><input type="number" value={form.timeoutMs} onChange={(event) => update("timeoutMs", Number(event.target.value))} /></label>
          <label><span>最大输出 Token</span><input type="number" value={form.maxOutputTokens} onChange={(event) => update("maxOutputTokens", Number(event.target.value))} /></label>
          <label><span>失败重试</span><input type="number" value={form.maxRetries} onChange={(event) => update("maxRetries", Number(event.target.value))} /></label>
          <label><span>最大并发</span><input type="number" value={form.maxConcurrency} onChange={(event) => update("maxConcurrency", Number(event.target.value))} /></label>
          <label className="span-2"><span>学生答卷批改方式</span><select value={form.gradingMode ?? DEFAULT_GRADING_MODE} onChange={(event) => update("gradingMode", event.target.value as ModelConfigInput["gradingMode"])}><option value="vision_direct">视觉直批（推荐）</option><option value="evidence_pipeline">先提取卷面证据，再分步评分（兼容模式）</option></select><small>视觉直批会把题目、评分标准和学生答卷原图直接交给教师模型；兼容模式保留旧的分步提取流程。</small></label>
          <label className="span-2"><span>教师模型推理强度</span><select value={form.teacherReasoningEffort ?? DEFAULT_TEACHER_REASONING_EFFORT} onChange={(event) => update("teacherReasoningEffort", event.target.value as ModelConfigInput["teacherReasoningEffort"])}><option value="disabled">默认，不额外传递推理强度</option><option value="low">低，优先响应速度</option><option value="medium">中，适合常规阅卷</option><option value="high">高，适合复杂等价判断</option></select><small>仅用于最终答案判断和逐点评分审验。仅在服务支持 OpenAI 兼容的 <code>reasoning_effort</code> 参数时启用；不支持时请保持默认。</small></label>
        </div>
        <div className="toggle-row">
          <Toggle label="JSON Schema" checked={form.supportsJsonSchema} onChange={(value) => update("supportsJsonSchema", value)} />
          <Toggle label="JSON Object" checked={form.supportsJsonObject} onChange={(value) => update("supportsJsonObject", value)} />
          <Toggle label="Base64 图片" checked={form.supportsBase64Images} onChange={(value) => update("supportsBase64Images", value)} />
          <Toggle label="启用配置" checked={form.enabled} onChange={(value) => update("enabled", value)} />
        </div>
      </section>

      {testResult && <div className={`test-result ${testResult.type}`}>
        {testResult.type === "ok" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<span>{testResult.text}</span>
      </div>}

      <div className="action-bar">
        <div><strong>连接测试会产生一次最小模型调用</strong><small>测试前会先保存并全局应用当前页面中的连接信息、模型和调用参数。</small></div>
        <button className="button secondary" disabled={!canTest || saving || Boolean(testing)} onClick={() => void test("text")}>{testing === "text" ? <LoaderCircle className="spin" size={16} /> : <Code2 size={16} />}测试文本</button>
        <button className="button secondary" disabled={!canTest || saving || Boolean(testing)} onClick={() => void test("vision")}>{testing === "vision" ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}测试多模态</button>
        <button className="button primary" disabled={saving || Boolean(testing)} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存并全局应用</button>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="toggle-track" /><span>{label}</span></label>;
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
  const [answerImageUrls, setAnswerImageUrls] = useState<Record<string, string>>({});
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"document" | "structure" | "grade" | "regrade" | "demo" | "save" | "history" | null>(null);
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
    else if (busy === "regrade") onActivityChange("正在重新判定历史答卷");
    else if (busy === "save") onActivityChange("正在保存锁定模板");
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

  const extract = async (file: File, target: "question" | "reference") => {
    setBusy("document"); setError("");
    try {
      const result = await uploadDocument(file);
      if (target === "question") setQuestionText(result.text); else setReferenceText(result.text);
      setRubric(null); setResults([]); setAnswerImageUrls({}); setTemplateId(null);
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
      setRubric(next); setRubricJson(JSON.stringify(next, null, 2)); setResults([]); setAnswerImageUrls({}); setTemplateId(null);
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
      setRubricJson(JSON.stringify(demo.rubric, null, 2)); setResults(demo.results); setAnswerImageUrls({}); setSelectedResultId(demo.results[0]?.id ?? null); setTemplateId(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "演示数据加载失败"); }
    finally { setBusy(null); }
  };

  const applyJson = () => {
    try {
      const next = JSON.parse(rubricJson) as Rubric;
      next.status = "draft";
      setRubric(next); setEditingJson(false); setError(""); setTemplateId(null);
    } catch { setError("JSON 格式无效，请检查后重试"); }
  };

  const lockAndSaveRubric = async () => {
    if (!rubric || templateId) return;
    setBusy("save"); setError("");
    try {
      const locked: Rubric = { ...rubric, status: "locked" };
      const form = new FormData();
      form.append("questionText", questionText);
      form.append("referenceText", referenceText);
      form.append("rubric", JSON.stringify(locked));
      questionImages.forEach((image) => form.append("questionImages", image.file, image.file.name));
      referenceImages.forEach((image) => form.append("referenceImages", image.file, image.file.name));
      const saved = await api<GradingTemplateSummary>("/api/templates", { method: "POST", body: form });
      setRubric(locked);
      setRubricJson(JSON.stringify(locked, null, 2));
      setTemplateId(saved.id);
      setStructureLogs((logs) => [...logs, {
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        message: `评分标准已锁定并自动保存为模板：${saved.title}`,
        status: "done"
      }]);
      onTemplateSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模板保存失败，评分标准尚未锁定");
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
    setStudents((previous) => [...previous, ...next]); setResults([]); setAnswerImageUrls({});
  };

  const grade = async () => {
    if (!rubric || rubric.status !== "locked" || !students.length) return;
    if (!configReady) { onOpenModels(); return; }
    const priorResults = results;
    setBusy("grade"); setProgress(0); setError("");
    const completed: GradingResult[] = [];
    try {
      for (let index = 0; index < students.length; index += 1) {
        const student = students[index];
        const form = new FormData();
        form.append("image", student.file); form.append("studentId", student.studentId); form.append("rubric", JSON.stringify(rubric));
        form.append("questionText", questionText); form.append("referenceText", referenceText);
        questionImages.forEach((image) => form.append("questionImages", image.file, image.file.name));
        referenceImages.forEach((image) => form.append("referenceImages", image.file, image.file.name));
        if (templateId) form.append("templateId", templateId);
        const completedResult = await api<GradingResult>("/api/grading/grade", { method: "POST", body: form });
        completed.push(completedResult);
        setAnswerImageUrls((previous) => ({ ...previous, [completedResult.id]: student.preview }));
        setResults([...completed, ...priorResults]); setProgress((index + 1) / students.length);
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
      setAnswerImageUrls((previous) => ({ ...previous, [next.id]: previous[resultId] ?? "" }));
      setResults((previous) => [next, ...previous]);
      setSelectedResultId(next.id);
      onResultSelected(templateId, next.id);
      onTemplateSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "历史答卷重新判定失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page-header workspace-header">
        <div><p className="eyebrow">物理计算题 · 首版测试台</p><h1>批改任务</h1><p>先锁定评分标准，再批量提取卷面证据并按规则计分。</p></div>
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

      {rubric && <RubricReview rubric={rubric} editingJson={editingJson} rubricJson={rubricJson} setRubricJson={setRubricJson} onEdit={() => setEditingJson(true)} onCancelEdit={() => setEditingJson(false)} onApplyJson={applyJson} onLock={() => void lockAndSaveRubric()} saving={busy === "save"} templateId={templateId} />}

      {rubric?.status === "locked" && <section className="workspace-section">
        <div className="section-title-row"><div><span className="section-index">03</span><h2>学生作答</h2></div><span className="section-meta">JPG、PNG、WEBP，单张不超过 15 MB</span></div>
        <div className="upload-strip" onClick={() => studentInput.current?.click()}><Upload size={22} /><div><strong>选择数张学生作答图片</strong><span>文件名仅作参考，可在上传后修改学生编号</span></div><button className="button secondary">选择图片</button></div>
        <input ref={studentInput} hidden type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => addStudents(event.target.files)} />
        {students.length > 0 && <div className="student-list">{students.map((student) => <div className="student-row" key={student.id}>
          <img src={student.preview} alt={`${student.studentId}作答缩略图`} />
          <input value={student.studentId} onChange={(event) => setStudents((items) => items.map((item) => item.id === student.id ? { ...item, studentId: event.target.value } : item))} />
          <span>{student.file.name}</span><small>{(student.file.size / 1024 / 1024).toFixed(2)} MB</small>
          <button className="icon-button" title="移除这份作答" onClick={() => setStudents((items) => items.filter((item) => item.id !== student.id))}><Trash2 size={16} /></button>
        </div>)}</div>}
        <div className="inline-action grading-action"><span>{students.length ? `已准备 ${students.length} 份作答，将按顺序处理。` : "尚未添加学生作答。"}</span><button className="button primary" disabled={!students.length || busy === "grade"} onClick={() => void grade()}>{busy === "grade" ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{busy === "grade" ? `正在批改 ${Math.round(progress * 100)}%` : "开始批改"}</button></div>
        {busy === "grade" && <div className="progress-track"><span style={{ width: `${progress * 100}%` }} /></div>}
      </section>}

      {results.length > 0 && metrics && <ResultsSection results={results} metrics={metrics} rubric={rubric ?? undefined} selected={selectedResult} answerImageUrl={selectedResult ? answerImageUrls[selectedResult.id] : undefined} onSelect={(id) => { setSelectedResultId(id); if (templateId) onResultSelected(templateId, id); }} templateId={templateId} regrading={busy === "regrade"} onRegrade={regrade} />}
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
  return <span className="final-answer-formula"><MathText value={expression} formulaByDefault />{unit && <MathText value={`\\mathrm{${unit}}`} formulaByDefault />}</span>;
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

function RubricReview({ rubric, editingJson, rubricJson, setRubricJson, onEdit, onCancelEdit, onApplyJson, onLock, saving, templateId }: { rubric: Rubric; editingJson: boolean; rubricJson: string; setRubricJson: (value: string) => void; onEdit: () => void; onCancelEdit: () => void; onApplyJson: () => void; onLock: () => void; saving: boolean; templateId: string | null }) {
  return <section className="workspace-section rubric-section">
    <div className="section-title-row"><div><span className="section-index">02</span><h2>确认评分标准</h2><span className={`pill ${rubric.status}`}>{rubric.status === "locked" ? <LockKeyhole size={13} /> : <Code2 size={13} />}{rubric.status === "locked" ? `已锁定 v${rubric.version}${templateId ? " · 已保存" : " · 尚未保存"}` : "结构化草稿"}</span></div><div className="header-actions"><button className="button secondary" onClick={onEdit}><Code2 size={16} />编辑 JSON</button>{(rubric.status !== "locked" || !templateId) && <button className="button primary" disabled={saving} onClick={onLock}>{saving ? <LoaderCircle className="spin" size={16} /> : <LockKeyhole size={16} />}{saving ? "保存模板中" : rubric.status === "locked" ? "保存当前模板" : "确认、锁定并保存"}</button>}</div></div>
    {rubric.warnings.length > 0 && <div className="warning-list"><AlertTriangle size={17} /><div><strong>结构校验提示</strong>{rubric.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></div>}
    {editingJson ? <div className="json-editor"><textarea value={rubricJson} onChange={(event) => setRubricJson(event.target.value)} spellCheck={false} /><div><button className="button secondary" onClick={onCancelEdit}>取消</button><button className="button dark" onClick={onApplyJson}><Check size={16} />应用修改</button></div></div> : <div className="rubric-content">
      <div className="rubric-summary"><div><span>题目</span><strong>{rubric.title}</strong></div><div><span>总分</span><strong>{rubric.totalScore} 分</strong></div><div><span>小问</span><strong>{rubric.subquestions.length}</strong></div><div><span>评分点</span><strong>{rubric.subquestions.reduce((sum, item) => sum + item.scorePoints.length, 0)}</strong></div></div>
      <div className="recognized-question"><div className="recognized-question-header"><FileText size={16} /><strong>识别到的题目原文</strong><span>锁定前请核对公式、单位和小问编号</span></div>{rubric.recognizedQuestionText ? <MathText value={rubric.recognizedQuestionText} formulaByDefault /> : <p className="empty-recognition">模型未返回题目原文，请编辑 JSON 补充或重新生成。</p>}</div>
      {rubric.subquestions.map((subquestion) => <div className="subquestion" key={subquestion.id}><div className="subquestion-header"><div><strong>{subquestion.title}</strong><span>{subquestion.id}</span></div><b>{subquestion.maxScore} 分</b></div><div className="answer-rule"><span>最终答案</span><div className="formula-list">{subquestion.finalAnswers.length ? subquestion.finalAnswers.map((item, index) => <span className="formula-option" key={`${item.expression}-${index}`}><FinalAnswerFormula expression={item.expression} unit={item.unit} />{index < subquestion.finalAnswers.length - 1 && <i>/</i>}</span>) : <span>未配置</span>}</div><small>教师模型判定正确时直接满分；过程审验仅作审计</small></div><div className="rubric-table"><div className="rubric-table-head"><span>评分点</span><span>判定依据</span><span>分值</span></div>{subquestion.scorePoints.map((point) => <div className="rubric-table-row" key={point.id}><span><b>{point.id}</b>{point.title}</span><span>{point.description}<MathText value={point.expected} formulaByDefault /></span><strong>{point.score}</strong></div>)}</div></div>)}
    </div>}
  </section>;
}

function ResultsSection({ results, metrics, rubric, selected, answerImageUrl, onSelect, templateId, regrading, onRegrade }: { results: GradingResult[]; metrics: { coverage: number; traceability: number; automatic: number; review: number }; rubric?: Rubric; selected?: GradingResult; answerImageUrl?: string; onSelect: (id: string) => void; templateId: string | null; regrading: boolean; onRegrade: (id: string) => Promise<void> }) {
  const currentResultCount = currentResultVersions(results).length;
  return <section className="workspace-section results-section">
    <div className="section-title-row"><div><span className="section-index">04</span><h2>批改结果与执行数据</h2></div><span className="section-meta">共 {currentResultCount} 份答卷{results.length > currentResultCount ? ` · ${results.length} 个结果版本` : ""}</span></div>
    <div className="metric-grid">
      <Metric icon={<CircleGauge size={18} />} label="规则执行覆盖率" value={percent(metrics.coverage)} detail="已完成判定的评分点" tone="green" />
      <Metric icon={<ShieldCheck size={18} />} label="证据可追溯率" value={percent(metrics.traceability)} detail="判定可定位到卷面" tone="blue" />
      <Metric icon={<Gauge size={18} />} label="自动判定率" value={percent(metrics.automatic)} detail="无须人工介入" tone="ink" />
      <Metric icon={<AlertTriangle size={18} />} label="答卷复核率" value={percent(metrics.review)} detail="包含至少一项风险" tone="amber" />
    </div>
    <div className="result-table"><div className="result-head"><span>学生</span><span>文件</span><span>得分</span><span>处理状态</span><span>耗时</span><span /></div>{results.map((result) => <button className={selected?.id === result.id ? "result-row selected" : "result-row"} key={result.id} onClick={() => onSelect(result.id)}><span><strong>{result.studentId}</strong></span><span>{result.fileName}</span><span><b>{scoreLabel(result.score, result.maximumPossibleScore)}</b> / {result.maxScore}</span><span><i className={`status-chip ${result.status}`}>{result.status === "completed" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{statusLabel(result.status)}</i></span><span>{(result.metrics.durationMs / 1000).toFixed(1)} s</span><ChevronRight size={16} /></button>)}</div>
    {selected && <ResultDetail result={selected} rubric={rubric ?? undefined} answerImageUrl={answerImageUrl} canRegrade={Boolean(templateId)} regrading={regrading} onRegrade={onRegrade} />}
  </section>;
}

function Metric({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: string }) {
  return <div className={`metric-card ${tone}`}><div>{icon}<span>{label}</span></div><strong>{value}</strong><small>{detail}</small></div>;
}

function finalAnswerLabel(status: GradingResult["subquestions"][number]["finalAnswerStatus"], teacherDecision: boolean) {
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
  if (disposition === "awarded") return "按评分标准计入得分";
  return "按历史规则记录";
}

function decisionScoreLabel(decision: GradingResult["subquestions"][number]["decisions"][number]) {
  return decision.status === "insufficient_evidence" && (decision.uncertainScore ?? 0) > 0
    ? `?/${decision.maxScore}`
    : `${decision.awardedScore}/${decision.maxScore}`;
}

export function ResultDetail({ result, rubric, answerImageUrl, canRegrade, regrading, onRegrade, scoreViewTransitionName }: { result: GradingResult; rubric?: Rubric; answerImageUrl?: string; canRegrade: boolean; regrading: boolean; onRegrade: (id: string) => Promise<void>; scoreViewTransitionName?: string }) {
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  useEffect(() => setActiveLineId(null), [result.id]);
  const activeRegion = result.evidence.lines.find((line) => line.id === activeLineId)?.region;
  return <div className="result-detail">
    <div className="detail-header">
      <div>
        <p className="eyebrow">逐点评分报告</p>
        <h3>{result.studentId}</h3>
        <span>{result.fileName} · 评分标准 v{result.rubricVersion} · {result.modelName}</span>
        {(result.gradingEngineVersion || result.teacherJudgementVersion) && <span className="engine-version">计分引擎 {result.gradingEngineVersion ?? "旧版"} · 教师判定 {result.teacherJudgementVersion ?? "旧版"}</span>}
        {result.gradingMode && <span className="engine-version">批改方式：{result.gradingMode === "vision_direct" ? "视觉直批" : "提取式兼容流程"}</span>}
        {result.reviewPolicy && <span className="engine-version">无法辨认影响 {result.reviewPolicy.unreadableAffectedScore} 分 · 人工复核阈值 {result.reviewPolicy.unreadableScoreThreshold} 分</span>}
        {result.regradedAt && <span className="engine-version">历史重判于 {new Date(result.regradedAt).toLocaleString("zh-CN", { hour12: false })}</span>}
      </div>
      <div className="detail-summary-actions">
        {canRegrade && <button className="button secondary" disabled={regrading} onClick={() => void onRegrade(result.id)}>{regrading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{regrading ? "判定中" : "重新判定"}</button>}
        <div className="score-block prism-score-emphasis" key={result.id}><strong style={scoreViewTransitionName ? { viewTransitionName: scoreViewTransitionName } as CSSProperties : undefined}>{scoreLabel(result.score, result.maximumPossibleScore)}</strong><span>/ {result.maxScore} 分{result.maximumPossibleScore !== undefined && result.maximumPossibleScore > result.score ? "（含待复核分值）" : ""}</span></div>
      </div>
    </div>
    {result.reviewReasons.length > 0 && <div className="review-banner"><AlertTriangle size={17} /><div><strong>需要人工复核</strong>{result.reviewReasons.map((reason) => <p key={reason}>{reason}</p>)}</div></div>}
    {result.teacherCommentary && <div className={`teacher-commentary ${result.teacherCommentary.status}`}>
      <div className="teacher-commentary-heading"><div><ScrollText size={16} /><strong>教师模型评语</strong><span>{result.teacherCommentary.status === "completed" ? `模型生成 · ${result.teacherCommentary.modelName ?? result.modelName}` : "结构化降级评语"}</span></div><small>{result.teacherCommentary.version}</small></div>
      <p className="teacher-commentary-overall"><MathText value={result.teacherCommentary.overallComment} formulaByDefault /></p>
      {result.teacherCommentary.strengths.length > 0 && <div className="teacher-commentary-group"><strong>表现较好</strong>{result.teacherCommentary.strengths.map((item) => <p key={item}><MathText value={item} formulaByDefault /></p>)}</div>}
      {result.teacherCommentary.lostPoints.length > 0 && <div className="teacher-commentary-group loss"><strong>明确失分点</strong>{result.teacherCommentary.lostPoints.map((item) => <p key={`${item.subquestionId}-${item.pointId}`}><b>{item.pointId}</b>：失 {item.scoreLost} 分，<MathText value={item.reason} formulaByDefault /></p>)}</div>}
      {result.teacherCommentary.auditConcerns.length > 0 && <div className="teacher-commentary-group concern"><strong>过程审验提醒</strong>{result.teacherCommentary.auditConcerns.map((item, index) => <p key={`${item.subquestionId}-${item.pointId ?? index}`}><b>{item.pointId ?? item.subquestionId}</b>：<MathText value={item.reason} formulaByDefault />{result.subquestions.find((subquestion) => subquestion.id === item.subquestionId)?.decisions.every((decision) => decision.scoringDisposition === "not_deducted_by_final_answer") ? "（最终答案触发满分，本提醒不影响得分）" : ""}</p>)}</div>}
    </div>}
    <div className="detail-columns">
      <div className="grading-report">{result.subquestions.map((subquestion) => {
        const teacherDecision = Boolean(subquestion.finalAnswerDecisionSource);
        const grantsFullCredit = subquestion.decisions.length > 0 && subquestion.decisions.every((decision) => decision.scoringDisposition === "not_deducted_by_final_answer");
        const rubricSubquestion = rubric?.subquestions.find((candidate) => candidate.id === subquestion.id);
        return <div className="report-question" key={subquestion.id}>
          <div className="report-question-title"><strong>{subquestion.title}</strong><span>{scoreLabel(subquestion.score, subquestion.maximumPossibleScore)}/{subquestion.maxScore} 分</span></div>
          <div className={`final-verdict ${subquestion.finalAnswerStatus}`}>
            <div className="final-verdict-title">
              {subquestion.finalAnswerStatus === "correct" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              <strong>{finalAnswerLabel(subquestion.finalAnswerStatus, teacherDecision)}</strong>
              <span>{subquestion.finalAnswerDecisionSource === "teacher_model" ? `教师模型 · ${percent(subquestion.finalAnswerConfidence ?? 0)}` : subquestion.finalAnswerDecisionSource === "missing_teacher_judgement" ? "教师判定缺失" : "旧版结果"}</span>
            </div>
            {subquestion.finalAnswerReason && <div className="final-verdict-reason"><MathText value={subquestion.finalAnswerReason} formulaByDefault /></div>}
            {(subquestion.studentFinalAnswer || subquestion.referenceFinalAnswer) && <div className="answer-comparison">
              <div><span className="answer-label">学生答案</span><MathText value={subquestion.studentFinalAnswer || "未写出"} formulaByDefault /></div>
              <div><span className="answer-label">参考答案</span><MathText value={subquestion.referenceFinalAnswer || "未配置"} formulaByDefault /></div>
            </div>}
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
        <div className="transcript-subtitle"><FileText size={15} /><strong>卷面转录</strong><span>{result.evidence.lines.length} 行</span></div>
        {result.evidence.lines.map((line) => {
        const latex = line.latex?.trim();
        const originalText = line.text?.trim() ?? "";
        const showOriginal = Boolean(latex && originalText && latex !== originalText);
        const locatable = Boolean(line.region);
        return <button type="button" className={`transcript-line ${line.status} ${line.confidence < 0.6 ? "low-confidence" : ""} ${locatable ? "locatable" : ""} ${activeLineId === line.id ? "active" : ""}`} key={line.id} onClick={() => locatable && setActiveLineId((current) => current === line.id ? null : line.id)}>
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

function AnswerImageViewer({ imageUrl, fileName, region }: {
  imageUrl?: string;
  fileName: string;
  region?: [number, number, number, number];
}) {
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setExpanded(false);
    setZoom(1);
    setNaturalSize({ width: 0, height: 0 });
    setLoadFailed(false);
  }, [imageUrl]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded]);

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

  return <div className="answer-image-viewer">
    <div className="answer-image-toolbar"><strong>原始图像</strong>{imageUrl && !loadFailed && <button type="button" className="icon-button" title="放大查看原始答卷" onClick={() => setExpanded(true)}><Maximize2 size={15} /></button>}</div>
    {!imageUrl || loadFailed ? <div className="answer-image-empty"><ImagePlus size={24} /><span>{loadFailed ? "原始答卷图像加载失败" : "该结果没有可用的原始答卷图像"}</span></div> : <div className="answer-image-scroll">
      <button type="button" className="answer-image-canvas" title="点击放大查看" onClick={() => setExpanded(true)}>
        <img src={imageUrl} alt={`${fileName} 原始答卷`} onLoad={handleLoad} onError={() => setLoadFailed(true)} />
        {regionStyle && <span className="answer-region-highlight" style={regionStyle} />}
      </button>
    </div>}
    {expanded && imageUrl && !loadFailed && <div className="answer-image-modal" role="dialog" aria-modal="true" aria-label={`${fileName} 原始答卷大图`} onClick={(event) => event.target === event.currentTarget && setExpanded(false)}>
      <div className="answer-image-modal-toolbar">
        <strong>{fileName}</strong>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" className="icon-button" title="缩小" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}><ZoomOut size={18} /></button>
        <button type="button" className="icon-button" title="放大" disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + 0.25))}><ZoomIn size={18} /></button>
        <button type="button" className="icon-button" title="恢复适应窗口" onClick={() => setZoom(1)}><RefreshCw size={17} /></button>
        <button type="button" className="icon-button" title="关闭" onClick={() => setExpanded(false)}><X size={19} /></button>
      </div>
      <div className="answer-image-modal-scroll">
        <div className="answer-image-modal-canvas" style={{ width: `${zoom * 100}%` }}>
          <img src={imageUrl} alt={`${fileName} 原始答卷大图`} onLoad={handleLoad} />
          {regionStyle && <span className="answer-region-highlight" style={regionStyle} />}
        </div>
      </div>
    </div>}
  </div>;
}

function HistoryPage({ revision, onOpen }: { revision: number; onOpen: (id: string) => void }) {
  const [templates, setTemplates] = useState<GradingTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setTemplates(await api<GradingTemplateSummary[]>("/api/templates")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "历史记录读取失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, revision]);

  return <div className="page history-page">
    <header className="page-header"><div><p className="eyebrow">本机持久化记录</p><h1>历史记录</h1><p>重新打开已锁定模板，查看过往结果或继续批改新答卷。</p></div><button className="button secondary" disabled={loading} onClick={() => void refresh()}>{loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}刷新</button></header>
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
      {!loading && templates.length === 0 && <div className="empty-state"><History size={28} /><strong>还没有历史模板</strong><p>确认并锁定评分标准后会自动出现在这里。</p></div>}
    </section>
  </div>;
}

const scopeLabels: Record<string, string> = {
  rubric: "评分标准",
  grading: "答卷批改",
  equivalence: "答案判定审计",
  scoring: "规则计分",
  storage: "数据保存",
  model: "模型调用",
  system: "系统"
};

function LogsPage({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<SystemLogSnapshot>({ activeOperations: [], entries: [], serverTime: "" });
  const [scope, setScope] = useState("all");
  const [error, setError] = useState("");

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

  return <div className="page logs-page">
    <header className="page-header"><div><p className="eyebrow">可审计运行轨迹</p><h1>运行日志</h1><p>查看模型调用、答案等价检查、规则计分和数据保存停在哪一步。</p></div><div className="header-actions"><button className="button secondary" onClick={() => void refresh()}><RefreshCw size={16} />立即刷新</button><button className="icon-button bordered" title="清空已完成日志" onClick={() => void clear()}><Trash2 size={16} /></button></div></header>
    {error && <div className="error-banner"><AlertTriangle size={17} /><span>{error}</span></div>}
    <section className="operations-section">
      <div className="logs-section-heading"><div><LoaderCircle className={snapshot.activeOperations.length ? "spin" : ""} size={17} /><h2>当前运行状态</h2></div><span>{snapshot.activeOperations.length ? `${snapshot.activeOperations.length} 个操作进行中` : "系统空闲"}</span></div>
      {snapshot.activeOperations.length > 0 ? <div className="active-operation-grid">{snapshot.activeOperations.map((operation) => <div className="active-operation" key={operation.id}><div><span>{scopeLabels[operation.scope]}</span><time>已运行 {Math.max(0, Math.floor((Date.now() - new Date(operation.startedAt).getTime()) / 1000))}s</time></div><strong>{operation.label}</strong><p>当前步骤：{operation.step}</p><small>操作 ID：{operation.id}</small></div>)}</div> : <div className="idle-state"><CheckCircle2 size={18} /><span>当前没有阻塞或等待中的后台操作</span></div>}
    </section>
    <section className="logs-section">
      <div className="logs-toolbar"><div><ScrollText size={16} /><h2>最近事件</h2><span>{entries.length} 条</span></div><label><span>范围</span><select value={scope} onChange={(event) => setScope(event.target.value)}><option value="all">全部</option>{Object.entries(scopeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
      <div className="log-table"><div className="log-head"><span>时间</span><span>状态</span><span>范围 / 步骤</span><span>事件</span></div>{entries.map((entry) => <div className={`log-row ${entry.level}`} key={entry.id}><time>{new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}</time><span><i className={`log-status ${entry.status}`}>{entry.status}</i></span><span><strong>{scopeLabels[entry.scope]}</strong><small>{entry.step}</small></span><div><p>{entry.message}</p>{isModelCallLog(entry) ? <ModelCallDetails details={entry.details as unknown as ModelCallLogDetails} /> : entry.details && <details><summary>查看事件详情</summary><pre>{JSON.stringify(entry.details, null, 2)}</pre></details>}<small className="operation-id">{entry.operationId}</small></div></div>)}</div>
      {entries.length === 0 && <div className="empty-state"><ScrollText size={28} /><strong>还没有运行日志</strong><p>生成评分规则或批改答卷后会记录完整步骤。</p></div>}
    </section>
  </div>;
}

function isModelCallLog(entry: SystemLogEntry): boolean {
  return entry.scope === "model" && entry.details?.kind === "model_call";
}

function ModelCallDetails({ details }: { details: ModelCallLogDetails }) {
  const response = details.response;
  return <details className="model-call-details">
    <summary>展开 Prompt 与模型原始返回</summary>
    <div className="model-call-meta">
      <span>模型：<b>{details.model}</b></span>
      {details.configuration && <span>配置：<b>{details.configuration.name}</b></span>}
      {details.configuration && <span>API：<b>{details.configuration.baseUrl}</b></span>}
      <span>结构：<b>{details.schemaName}</b></span>
      <span>模式：<b>{details.outputMode}</b></span>
      {details.request.reasoningEffort && <span>推理：<b>{details.request.reasoningEffort}</b></span>}
      <span>尝试：<b>{details.attempt}/{details.maxAttempts}</b></span>
      {details.durationMs !== undefined && <span>耗时：<b>{details.durationMs} ms</b></span>}
      {response && <span>HTTP：<b>{response.status}</b></span>}
    </div>
    {details.error && <div className="model-call-error"><AlertTriangle size={14} />{details.error}</div>}
    <div className="model-call-payload-grid">
      <div className="model-call-payload"><strong>System Prompt</strong><pre>{details.request.systemPrompt}</pre></div>
      <div className="model-call-payload"><strong>User Prompt</strong><pre>{details.request.userPrompt}</pre></div>
    </div>
    {details.request.responseFormat && <div className="model-call-payload"><strong>Response Format / JSON Schema</strong><pre>{JSON.stringify(details.request.responseFormat, null, 2)}</pre></div>}
    {details.request.images.length > 0 && <div className="model-call-images"><strong>图像输入（正文已省略）</strong>{details.request.images.map((image, index) => <div key={`${image.sha256}-${index}`}><span>{image.label || `图片 ${index + 1}`}</span><small>{image.mimeType} · {image.bytes.toLocaleString("zh-CN")} bytes · SHA-256 {image.sha256}</small></div>)}</div>}
    <div className="model-call-payload"><strong>模型原始 HTTP 返回</strong><pre>{response?.raw || "请求未收到 HTTP 响应。"}</pre></div>
    {response?.content && <div className="model-call-payload"><strong>提取出的 message.content</strong><pre>{response.content}</pre></div>}
  </details>;
}

export default App;
