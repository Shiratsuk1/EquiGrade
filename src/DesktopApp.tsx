import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, BookOpenCheck, Bot,
  Camera, Check, ChevronDown, ChevronRight, CirclePause, CirclePlay, ClipboardCheck,
  Code2, FileCheck2, FileClock, FileText, Globe2, History, Home, ImageDown, ImagePlus, KeyRound,
  LayoutDashboard, Link2, ListChecks, LoaderCircle, Lock, Plug, Plus, RefreshCw,
  RotateCcw, Save, Search, Settings, ShieldCheck, SkipForward,
  Sparkles, Square, TerminalSquare, Trash2, Unplug, Upload, Wifi, WifiOff, X, XCircle
} from "lucide-react";
import type {
  BrowserAction, EmbeddedBrowserState, ElectronHostBridge, PipelineControl,
  ModelConnectionTestResult, ModelSetupStatus, PipelineDryRunResult,
  PipelineEvent, PipelineScoreAlignment, PluginDiagnosticAction, PluginDiagnosticResult,
  PluginAccent, PluginPhase, PluginPosition, PluginUiPreferences, TargetPageInspection,
  UiFontFamily, UiMonoFontFamily
} from "../shared/electron";
import type { MotionIntensity, WindowMaterial } from "../shared/electron";
import { EMPTY_PLUGIN_STATUS } from "../shared/electron";
import { buildPipelineScoreAlignment } from "../shared/pipelineSetup";
import { pluginFontStacks, pluginMonoFontStacks } from "../shared/uiConstants";
import {
  DEFAULT_GRADING_MODE, DEFAULT_MODEL_TIMEOUT_MS, DEFAULT_REVIEW_REASONING_EFFORT, DEFAULT_TEACHER_REASONING_EFFORT,
  DEFAULT_UNREADABLE_REVIEW_THRESHOLD
} from "../shared/types";
import type {
  GradingHistoryRecord, GradingResult, GradingTemplateDetail, GradingTemplateSummary, ModelConfigInput,
  ModelCallHistoryEntry, ModelCallLogDetails, PublicModelConfig, Rubric, SystemLogEntry, SystemLogSnapshot
} from "../shared/types";
import { api, uploadDocument } from "./api";
import { cleanPipelineError, pipelineEventLabel, pipelineEventTone } from "../shared/pipelineEvents";
import { ModelCallDetails, ModelCallHistory, ResultDetail } from "./App";
import { MathText } from "./Formula";
import { ScorePointGuidance } from "./ScorePointGuidance";
import { directionFromPopState, pushRoute, runRouteTransition } from "./navigation";
import { readStartUrl, START_URL_STORAGE_KEY } from "../shared/startUrl";

type DesktopRoute = {
  id: "dashboard" | "jobs" | "job" | "templates" | "template" | "history" | "record" | "logs" | "models" | "browser-debug" | "plugins-debug" | "settings";
  parameter?: string;
};

type TemplateContext = {
  templateId: string;
  title: string;
  ready: boolean;
  questionText: string;
  referenceText: string;
  rubric: Rubric;
};

type PipelineSummary = {
  processed: number;
  skipped: number;
  failures: number;
  lastScore?: number;
  lastMaxScore?: number;
  events: PipelineEvent[];
};

type TemplateMaterialImage = {
  id: string;
  file: File;
  preview: string;
  source: "paste" | "upload";
};

const desktopFontSizes = ["compact", "comfortable", "large"] as const;
type DesktopFontSize = typeof desktopFontSizes[number];
type DesktopDensity = "comfortable" | "compact";
const desktopFontWeights = [400, 500, 600, 700] as const;
type DesktopFontWeight = typeof desktopFontWeights[number];

const fontFamilyStacks = pluginFontStacks;
const monoFontStacks = pluginMonoFontStacks;
const typographyDefaultsVersionKey = "hengzhun.typographyDefaultsVersion";
const typographyDefaultsVersion = "noto-sans-sc-110-v1";

type DesktopPreferences = PluginUiPreferences & {
  fontSize: DesktopFontSize;
  density: DesktopDensity;
  fontFamily: UiFontFamily;
  monoFontFamily: UiMonoFontFamily;
  fontWeight: DesktopFontWeight;
  fontScale: number;
  lineHeight: number;
  letterSpacing: number;
  reduceMotion: boolean;
  materialMode: WindowMaterial;
  motionIntensity: MotionIntensity;
  surfaceOpacity: number;
  blurStrength: number;
  showLiveMessages: boolean;
  autoOpenStartUrl: boolean;
};

const defaultDesktopPreferences: DesktopPreferences = {  fontSize: "comfortable",
  density: "comfortable",
  fontFamily: "noto-sans-sc",
  monoFontFamily: "cascadia",
  fontWeight: 500,
  fontScale: 1.1,
  lineHeight: 1.5,
  letterSpacing: 0,
  accent: "teal",
  reduceMotion: false,
  materialMode: "mica",
  motionIntensity: "comfortable",
  surfaceOpacity: 86,
  blurStrength: 20,
  showLiveMessages: true,
  autoOpenStartUrl: true,
  visible: true,
  defaultCollapsed: false,
  position: "bottom-right",
  confirmBeforeStart: true
};

function readDesktopPreferences(): DesktopPreferences {
  const legacyFontSize = localStorage.getItem("hengzhun.desktopFontSize");
  try {
    const saved = JSON.parse(localStorage.getItem("hengzhun.desktopPreferences") || "{}") as Partial<DesktopPreferences>;
    const accents: PluginAccent[] = ["teal", "blue", "green", "graphite"];
    const positions: PluginPosition[] = ["bottom-right", "bottom-left"];
    const materials: WindowMaterial[] = ["solid", "mica", "acrylic"];
    const motionIntensities: MotionIntensity[] = ["off", "comfortable", "lively"];
    const fontFamilies: UiFontFamily[] = ["system", "inter", "noto-sans-sc", "source-han-sans", "microsoft-yahei"];
    const monoFontFamilies: UiMonoFontFamily[] = ["cascadia", "consolas", "system"];
    const numericPreference = (value: unknown, fallback: number, min: number, max: number) => {
      const numberValue = typeof value === "number" ? value : Number(value);
      return Number.isFinite(numberValue) ? Math.min(max, Math.max(min, numberValue)) : fallback;
    };
    const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(saved, key);
    const hasTypographyPreferences = ["fontFamily", "monoFontFamily", "fontWeight", "fontScale", "lineHeight", "letterSpacing"].some(hasOwn);
    const hasLegacyTypographyDefaults = (!hasOwn("fontFamily") || saved.fontFamily === "system")
      && (!hasOwn("monoFontFamily") || saved.monoFontFamily === "cascadia")
      && (!hasOwn("fontWeight") || Number(saved.fontWeight) === 500)
      && (!hasOwn("fontScale") || Number(saved.fontScale) === 1)
      && (!hasOwn("lineHeight") || Number(saved.lineHeight) === 1.5)
      && (!hasOwn("letterSpacing") || Number(saved.letterSpacing) === 0);
    const shouldMigrateTypographyDefaults = localStorage.getItem(typographyDefaultsVersionKey) !== typographyDefaultsVersion
      && (!hasTypographyPreferences || hasLegacyTypographyDefaults);
    const normalized: DesktopPreferences = {
      ...defaultDesktopPreferences,
      ...saved,
      fontSize: desktopFontSizes.includes((saved.fontSize || legacyFontSize) as DesktopFontSize) ? (saved.fontSize || legacyFontSize) as DesktopFontSize : "comfortable",
      density: saved.density === "compact" ? "compact" : "comfortable",
      fontFamily: shouldMigrateTypographyDefaults ? "noto-sans-sc" : fontFamilies.includes(saved.fontFamily as UiFontFamily) ? saved.fontFamily as UiFontFamily : "noto-sans-sc",
      monoFontFamily: monoFontFamilies.includes(saved.monoFontFamily as UiMonoFontFamily) ? saved.monoFontFamily as UiMonoFontFamily : "cascadia",
      fontWeight: desktopFontWeights.includes(Number(saved.fontWeight) as DesktopFontWeight) ? Number(saved.fontWeight) as DesktopFontWeight : 500,
      fontScale: shouldMigrateTypographyDefaults ? 1.1 : numericPreference(saved.fontScale, 1.1, 0.9, 1.2),
      lineHeight: numericPreference(saved.lineHeight, 1.5, 1.3, 1.9),
      letterSpacing: numericPreference(saved.letterSpacing, 0, -0.02, 0.06),
      accent: accents.includes(saved.accent as PluginAccent) ? saved.accent as PluginAccent : "teal",
      position: positions.includes(saved.position as PluginPosition) ? saved.position as PluginPosition : "bottom-right",
      materialMode: materials.includes(saved.materialMode as WindowMaterial) ? saved.materialMode as WindowMaterial : "mica",
      motionIntensity: motionIntensities.includes(saved.motionIntensity as MotionIntensity) ? saved.motionIntensity as MotionIntensity : "comfortable",
      surfaceOpacity: numericPreference(saved.surfaceOpacity, 86, 68, 92),
      blurStrength: numericPreference(saved.blurStrength, 20, 12, 28)
    };
    localStorage.setItem(typographyDefaultsVersionKey, typographyDefaultsVersion);
    if (shouldMigrateTypographyDefaults) localStorage.setItem("hengzhun.desktopPreferences", JSON.stringify(normalized));
    return normalized;
  } catch {
    return { ...defaultDesktopPreferences };
  }
}

function useSystemReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return reduced;
}

const routeTitles: Record<DesktopRoute["id"], { eyebrow: string; title: string; description: string }> = {
  dashboard: { eyebrow: "工作台", title: "智能阅卷", description: "查看当前任务、运行状态和需要处理的答卷。" },
  jobs: { eyebrow: "批改任务", title: "任务管理", description: "创建任务并连接已经打开的智学网阅卷页面。" },
  job: { eyebrow: "当前任务", title: "实时批改", description: "对照评分标准查看网页，并控制连续批改进度。" },
  templates: { eyebrow: "评分资料", title: "评分标准", description: "管理已保存且可继续修改的题目、答案和逐点评分规则。" },
  template: { eyebrow: "评分资料", title: "评分标准详情", description: "核对题目、参考答案和每一个评分点。" },
  history: { eyebrow: "批改记录", title: "历史记录", description: "查找本机保存的答卷结果和人工复核记录。" },
  record: { eyebrow: "批改记录", title: "答卷详情", description: "查看单份答卷的得分、依据和教师评语。" },
  logs: { eyebrow: "开发工具", title: "运行日志", description: "查看模型、评分、存储和网页自动化的详细过程。" },
  models: { eyebrow: "应用设置", title: "教师模型", description: "配置视觉模型服务、连接参数和批改策略。" },
  "browser-debug": { eyebrow: "开发工具", title: "浏览器诊断", description: "检查网页导航、登录状态、学生图像和页面控件。" },
  "plugins-debug": { eyebrow: "开发工具", title: "插件诊断", description: "检查站点适配、网页能力和批改流程连接状态。" },
  settings: { eyebrow: "应用设置", title: "应用设置", description: "管理启动页面、异常处理和本地数据。" }
};

const defaultBrowserState: EmbeddedBrowserState = {
  url: "",
  title: "目标阅卷网站",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  security: "unknown",
  visible: false,
  crashed: false,
  plugin: { ...EMPTY_PLUGIN_STATUS, capabilities: { ...EMPTY_PLUGIN_STATUS.capabilities } }
};

const defaultModelConfig: ModelConfigInput = {
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
  gradingMode: DEFAULT_GRADING_MODE,
  teacherReasoningEffort: DEFAULT_TEACHER_REASONING_EFFORT,
  reviewReasoningEffort: DEFAULT_REVIEW_REASONING_EFFORT,
  supportsJsonSchema: true,
  supportsJsonObject: true,
  supportsBase64Images: true,
  enabled: true
};

function getHost() {
  return (window as Window & { electronHost?: ElectronHostBridge }).electronHost;
}

function normalizeBrowserAddress(value: string, currentUrl: string) {
  const input = value.trim();
  if (!input) throw new Error("请输入目标阅卷网站地址");

  // When the user enters a path while viewing a local test site, keep that
  // path on the current local origin instead of turning it into an HTTPS
  // hostname. The Electron session performs the same validation again.
  if (input.startsWith("/")) {
    try {
      const current = new URL(currentUrl);
      if (current.protocol === "http:" || current.protocol === "https:") {
        return new URL(input, current.origin).href;
      }
    } catch {
      // Fall through to the normal URL error below.
    }
    throw new Error("相对地址只能在已打开的网页中使用");
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("目标地址仅支持 HTTP 或 HTTPS 网页");
    }
    return url.href;
  }

  const localInput = /^(localhost|127\.0\.0\.1)(:\d+)?(?:\/|$)/i.test(input);
  return new URL(`${localInput ? "http" : "https"}://${input}`).href;
}

function parseDesktopRoute(pathname: string): DesktopRoute {
  const parts = pathname.split("/").filter(Boolean).map((value) => decodeURIComponent(value));
  if (!parts.length) return { id: "dashboard" };
  if (parts[0] === "jobs" && parts[1]) return { id: "job", parameter: parts[1] };
  if (parts[0] === "jobs") return { id: "jobs" };
  if (parts[0] === "templates" && parts[1]) return { id: "template", parameter: parts[1] };
  if (parts[0] === "templates") return { id: "templates" };
  if (parts[0] === "history" && parts[1]) return { id: "record", parameter: parts[1] };
  if (parts[0] === "history") return { id: "history" };
  if (parts[0] === "logs") return { id: "logs" };
  if (parts[0] === "models") return { id: "models" };
  if (parts[0] === "debug" && parts[1] === "browser") return { id: "browser-debug" };
  if (parts[0] === "debug" && parts[1] === "plugins") return { id: "plugins-debug" };
  if (parts[0] === "settings") return { id: "settings" };
  return { id: "dashboard" };
}

function routePath(route: DesktopRoute) {
  switch (route.id) {
    case "jobs": return "/jobs";
    case "job": return `/jobs/${encodeURIComponent(route.parameter || "current")}`;
    case "templates": return "/templates";
    case "template": return `/templates/${encodeURIComponent(route.parameter || "")}`;
    case "history": return "/history";
    case "record": return `/history/${encodeURIComponent(route.parameter || "")}`;
    case "logs": return "/logs";
    case "models": return "/models";
    case "browser-debug": return "/debug/browser";
    case "plugins-debug": return "/debug/plugins";
    case "settings": return "/settings";
    default: return "/";
  }
}

function navigatePath(route: DesktopRoute) {
  return `${routePath(route)}?electron=1`;
}

function sharedElementName(prefix: string, value: string) {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function sharedElementStyle(name: string) {
  return { viewTransitionName: name } as CSSProperties;
}

function reducePipelineEvents(events: PipelineEvent[]): PipelineSummary {
  return events.reduce<PipelineSummary>((summary, event) => {
    const next = { ...summary, events: [...summary.events, event].slice(-50) };
    if (event.type === "page_completed") {
      next.processed += 1;
      next.lastScore = event.score;
      next.lastMaxScore = event.maxScore;
    }
    if (event.type === "page_skipped") next.skipped += 1;
    if (event.type === "page_failed") next.failures += 1;
    return next;
  }, { processed: 0, skipped: 0, failures: 0, events: [] });
}

function phaseLabel(phase: PluginPhase) {
  const labels: Record<PluginPhase, string> = {
    disconnected: "未连接", handshaking: "连接中", idle: "待机", preflight: "页面检查",
    ready: "已就绪", extracting: "读取答卷", grading: "模型批改", writing_score: "写入分数",
    submitting: "提交分数", verifying: "校验提交", navigating_next: "进入下一份",
    completed: "批次完成", skipped: "跳过当前", paused: "已暂停", failed: "异常"
  };
  return labels[phase];
}

function hasCompletePluginCapabilities(capabilities: EmbeddedBrowserState["plugin"]["capabilities"]) {
  return capabilities.answerImage
    && capabilities.scoreInput
    && capabilities.submit
    && capabilities.next;
}

function formatTime(value: unknown) {
  if (typeof value !== "string") return "--:--:--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function useElectronState() {
  const [browser, setBrowser] = useState(defaultBrowserState);
  const [summary, setSummary] = useState<PipelineSummary>({ processed: 0, skipped: 0, failures: 0, events: [] });
  useEffect(() => {
    const host = getHost();
    if (!host) return;
    const removeBrowser = host.onBrowserState(setBrowser);
    const removePipeline = host.onPipelineEvent((event) => setSummary((previous) => reducePipelineEvents([...previous.events, event])));
    void host.getBrowserState().then(setBrowser);
    void host.getPipelineEvents().then((events) => setSummary(reducePipelineEvents(events)));
    return () => {
      removeBrowser();
      removePipeline();
    };
  }, []);
  return { browser, summary };
}

function NavLink({ route, current, icon, label }: { route: DesktopRoute; current: DesktopRoute; icon: React.ReactNode; label: string }) {
  const sectionActive = (route.id === "templates" && current.id === "template") || (route.id === "history" && current.id === "record");
  const active = sectionActive || (route.id === current.id && (!route.parameter || route.parameter === current.parameter));
  return <a className={active ? "desktop-nav-link active" : "desktop-nav-link"} href={navigatePath(route)} aria-current={active ? "page" : undefined}>
    {icon}<span>{label}</span>{active && <i />}
  </a>;
}

function DesktopSidebar({ route, browser }: { route: DesktopRoute; browser: EmbeddedBrowserState }) {
  return <aside className="desktop-sidebar">
    <a className="desktop-brand" href="/?electron=1">
      <span className="desktop-brand-icon"><ShieldCheck size={19} /></span>
      <span><strong>衡准</strong><small>智能阅卷</small></span>
    </a>
    <nav aria-label="桌面端主导航">
      <span className="desktop-nav-group">阅卷工作</span>
      <NavLink route={{ id: "dashboard" }} current={route} icon={<LayoutDashboard size={17} />} label="工作台" />
      <NavLink route={{ id: "jobs" }} current={route} icon={<ClipboardCheck size={17} />} label="批改任务" />
      <NavLink route={{ id: "job", parameter: "current" }} current={route} icon={<CirclePlay size={17} />} label="当前批改" />
      <span className="desktop-nav-group">资料与记录</span>
      <NavLink route={{ id: "templates" }} current={route} icon={<BookOpenCheck size={17} />} label="评分标准" />
      <NavLink route={{ id: "history" }} current={route} icon={<History size={17} />} label="批改记录" />
      <span className="desktop-nav-group">开发工具</span>
      <NavLink route={{ id: "logs" }} current={route} icon={<FileClock size={17} />} label="运行日志" />
      <NavLink route={{ id: "models" }} current={route} icon={<Bot size={17} />} label="教师模型" />
      <NavLink route={{ id: "browser-debug" }} current={route} icon={<Globe2 size={17} />} label="浏览器诊断" />
      <NavLink route={{ id: "plugins-debug" }} current={route} icon={<Plug size={17} />} label="插件诊断" />
      <NavLink route={{ id: "settings" }} current={route} icon={<Settings size={17} />} label="应用设置" />
    </nav>
    <div className="desktop-sidebar-status">
      <span className={browser.plugin.connected ? "desktop-live-dot online" : "desktop-live-dot"} />
      <div><strong>{browser.plugin.connected ? "智学网已连接" : "等待连接智学网"}</strong><small>{browser.plugin.connected ? "登录状态已保存" : "打开阅卷页面后自动连接"}</small></div>
    </div>
  </aside>;
}

function PageHeader({ route, browser }: { route: DesktopRoute; browser: EmbeddedBrowserState }) {
  const details = route.id === "template" && route.parameter === "new"
    ? { eyebrow: "评分标准", title: "新建评分标准", description: "导入题目和参考答案，生成、核对并保存新的评分规则。" }
    : route.id === "job" && route.parameter === "new"
    ? { eyebrow: "批改任务", title: "新建批改任务", description: "按照引导完成模型、评分标准、阅卷页面和安全试运行检查。" }
    : routeTitles[route.id];
  return <header className="desktop-page-header">
    <div><span>{details.eyebrow}</span><h1>{details.title}</h1><p>{details.description}</p></div>
    <div className="desktop-header-status">
      <span className={browser.plugin.connected ? "connected" : "disconnected"}>{browser.plugin.connected ? <Wifi size={14} /> : <WifiOff size={14} />}{browser.plugin.connected ? "页面已连接" : "页面未连接"}</span>
      <span><Activity size={14} />{phaseLabel(browser.plugin.phase)}</span>
    </div>
  </header>;
}

function MetricStrip({ browser, summary, template }: { browser: EmbeddedBrowserState; summary: PipelineSummary; template: TemplateContext | null }) {
  return <section className="desktop-metric-strip" aria-label="流水线指标">
    <article className="status"><div className="desktop-metric-icon"><Activity size={18} /></div><div><span>当前状态</span><strong>{phaseLabel(browser.plugin.phase)}</strong><small>{browser.plugin.message}</small></div></article>
    <article className="completed"><div className="desktop-metric-icon"><ClipboardCheck size={18} /></div><div><span>本次已批改</span><strong>{summary.processed}</strong><small>最近 {summary.lastScore ?? "--"} / {summary.lastMaxScore ?? "--"} 分</small></div></article>
    <article className="attention"><div className="desktop-metric-icon"><AlertTriangle size={18} /></div><div><span>需要关注</span><strong>{summary.failures + summary.skipped}</strong><small>失败 {summary.failures} · 跳过 {summary.skipped}</small></div></article>
    <article className="rubric"><div className="desktop-metric-icon"><BookOpenCheck size={18} /></div><div><span>当前评分标准</span><strong>{template?.rubric.totalScore ?? "--"} 分</strong><small>{template?.title || "尚未绑定评分标准"}</small></div></article>
  </section>;
}

function RecentEvents({ events, limit = 8 }: { events: PipelineEvent[]; limit?: number }) {
  const visible = events.slice(-limit).reverse();
  return <ol className="desktop-event-list">
    {visible.length === 0 ? <li className="empty"><span>--:--:--</span><div><strong>等待批改记录</strong><p>打开实时批改并检查智学网页面。</p></div></li> : visible.map((event, index) => <li key={`${event.timestamp || "event"}-${index}`}>
      <span>{formatTime(event.timestamp)}</span><div><strong>{pipelineEventLabel(event)}</strong><p>{event.phase ? phaseLabel(event.phase) : String(event.adapterId || "系统")}</p></div>
    </li>)}
  </ol>;
}

function useTemplateContext() {
  const [template, setTemplate] = useState<TemplateContext | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    setError("");
    const host = getHost();
    const request = host?.getTemplateContext() ?? api<TemplateContext>("/api/pipeline/fixture");
    void request.then((value) => setTemplate(value as TemplateContext)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "模板读取失败"));
  }, []);
  const bind = useCallback(async (templateId: string) => {
    const host = getHost();
    if (!host) throw new Error("当前环境无法绑定真实批改任务");
    const [detail, browserState] = await Promise.all([
      api<GradingTemplateDetail>(`/api/templates/${encodeURIComponent(templateId)}`),
      host.getBrowserState()
    ]);
    if (!browserState.url || browserState.url === "about:blank") {
      throw new Error("请先打开当前智学网阅卷页面，再绑定评分标准");
    }
    const inspection = await host.inspectTargetPage();
    if (!inspection.scoreFields.length) throw new Error("当前阅卷页面没有可用于匹配的最终总分框");
    const alignment = buildPipelineScoreAlignment(detail.rubric, inspection.scoreFields);
    if (!alignment.ok) throw new Error(alignment.issues.join("；") || "网页总分与评分标准不匹配");
    const context = await host.selectPipelineTask({
      mode: "production",
      templateId: detail.id,
      targetUrl: browserState.url
    });
    setTemplate(context);
    return context;
  }, []);
  const enterTest = useCallback(async () => {
    const host = getHost();
    if (!host) throw new Error("当前环境无法打开本地测试页面");
    const context = await host.selectPipelineTask({ mode: "test" });
    setTemplate(context);
    return context;
  }, []);
  useEffect(reload, [reload]);
  return { template, error, reload, bind, enterTest };
}

function TestEntryButton({ onEnterTest }: { onEnterTest: () => Promise<unknown> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const enter = async () => {
    setPending(true);
    setError("");
    try {
      await onEnterTest();
      pushRoute("/jobs/current?electron=1");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本地测试页面打开失败");
    } finally {
      setPending(false);
    }
  };
  return <div className="desktop-test-entry-actions">
    <button className="desktop-test-entry-button" disabled={pending} onClick={() => void enter()}>{pending ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}一键进入本地测试</button>
    <small>自动打开内置模拟阅卷页，无需填写地址或端口</small>
    {error && <span className="desktop-test-entry-error" role="status">{error}</span>}
  </div>;
}

function DashboardPage({ browser, summary, template, onEnterTest }: { browser: EmbeddedBrowserState; summary: PipelineSummary; template: TemplateContext | null; onEnterTest: () => Promise<unknown> }) {
  const pageReady = hasCompletePluginCapabilities(browser.plugin.capabilities);
  const readyCount = [template?.ready, browser.plugin.connected, pageReady].filter(Boolean).length;
  return <div className="desktop-page-body desktop-dashboard">
    <MetricStrip browser={browser} summary={summary} template={template} />
    <section className="desktop-dashboard-grid">
      <div className="desktop-section desktop-readiness">
        <div className="desktop-section-heading"><div><span>启动检查</span><h2>自动批改准备情况</h2></div><strong>{readyCount} / 4</strong></div>
        <div className="desktop-readiness-line"><i style={{ width: `${readyCount * 25}%` }} /></div>
        <ul className="desktop-check-list">
          <li className={template?.ready ? "ok" : ""}>{template?.ready ? <Check size={15} /> : <XCircle size={15} />}评分标准已选择<span>{template?.title || "尚未选择评分标准"}</span></li>
          <li className={browser.plugin.connected ? "ok" : ""}>{browser.plugin.connected ? <Check size={15} /> : <XCircle size={15} />}智学网页面已连接<span>{browser.plugin.adapterName || "等待打开阅卷页面"}</span></li>
          <li className={pageReady ? "ok" : ""}>{pageReady ? <Check size={15} /> : <XCircle size={15} />}学生答卷可以读取<span>{pageReady ? "答卷、评分和翻页控件均已确认" : "需同时确认答卷、评分、提交和翻页控件"}</span></li>
          <li className={pageReady ? "ok" : ""}>{pageReady ? <Check size={15} /> : <XCircle size={15} />}最终总分框可以使用<span>{pageReady ? "提交后自动进入下一份" : "当前页面尚未通过完整检查"}</span></li>
        </ul>
        <a className="desktop-primary-action" href="/jobs/current?electron=1"><CirclePlay size={16} />查看当前批改<ChevronRight size={15} /></a>
      </div>
      <div className="desktop-section">
        <div className="desktop-section-heading"><div><span>实时事件</span><h2>最近流水线活动</h2></div><a href="/logs?electron=1">完整日志</a></div>
        <RecentEvents events={summary.events} limit={7} />
      </div>
    </section>
    <section className="desktop-section desktop-test-entry">
      <div><span>无需配置端口</span><h2>先用本地模拟阅卷验证流程</h2><p>一键打开与智学网控件结构一致的测试页面，可直接测试图像读取、写入总分和翻页，不会访问真实网站。</p></div>
      <TestEntryButton onEnterTest={onEnterTest} />
    </section>
    <section className="desktop-section desktop-current-template">
      <div className="desktop-section-heading"><div><span>当前评分标准</span><h2>{template?.title || "当前任务尚未绑定评分标准"}</h2></div><div className="desktop-heading-actions"><a className="desktop-secondary-action" href="/templates?electron=1"><BookOpenCheck size={14} />{template ? "更换评分标准" : "选择评分标准"}</a><span className={template?.ready ? "desktop-status-label locked" : "desktop-status-label"}><BookOpenCheck size={13} />{template?.ready ? "已绑定" : "未绑定"}</span></div></div>
      <div className="desktop-template-summary">
        <div><span>模板编号</span><strong>{template?.templateId || "--"}</strong></div><div><span>满分</span><strong>{template?.rubric.totalScore ?? "--"} 分</strong></div><div><span>小问</span><strong>{template?.rubric.subquestions.length ?? "--"}</strong></div><div><span>评分点</span><strong>{template?.rubric.subquestions.reduce((count, item) => count + item.scorePoints.length, 0) ?? "--"}</strong></div>
      </div>
    </section>
  </div>;
}

function BrowserSurface({ className = "" }: { className?: string }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = getHost();
    const element = surfaceRef.current;
    if (!host || !element) return;
    let frame = 0;
    const report = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1) {
          host.setBrowserSurface({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
          host.setBrowserVisible(true);
        }
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    const removeRequest = host.onBrowserSurfaceRequest(report);
    window.addEventListener("resize", report);
    window.addEventListener("scroll", report, true);
    report();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      removeRequest();
      window.removeEventListener("resize", report);
      window.removeEventListener("scroll", report, true);
      host.setBrowserVisible(false);
    };
  }, []);
  return <div ref={surfaceRef} className={`desktop-browser-surface ${className}`} aria-label="真实阅卷网页浏览器窗口">
    <div><Globe2 size={24} /><span>正在连接内嵌浏览器窗口</span></div>
  </div>;
}

function BrowserToolbar({ browser, compact = false }: { browser: EmbeddedBrowserState; compact?: boolean }) {
  const [address, setAddress] = useState(browser.url);
  const [message, setMessage] = useState("");
  useEffect(() => setAddress(browser.url), [browser.url]);
  const action = async (value: BrowserAction) => {
    try {
      const host = getHost();
      if (!host) throw new Error("桌面端控制桥接尚未就绪，请稍后重试");
      const result = await host.runBrowserAction(value);
      setMessage(result?.message || "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "浏览器操作失败");
    }
  };
  const navigate = async () => {
    try {
      const host = getHost();
      if (!host) throw new Error("桌面端控制桥接尚未就绪，请稍后重试");
      const normalized = normalizeBrowserAddress(address, browser.url);
      setAddress(normalized);
      setMessage("正在打开网页…");
      await host.navigateBrowser(normalized);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "网页地址无效");
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void navigate();
  };
  const handleAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    // Some embedded Electron layouts can consume the native form submit
    // event. Handle Enter directly as well, while preventing a duplicate
    // submit from the browser's implicit form behavior.
    event.preventDefault();
    event.stopPropagation();
    void navigate();
  };
  return <div className={compact ? "desktop-browser-toolbar compact" : "desktop-browser-toolbar"}>
    <div className="desktop-browser-nav">
      <button title="后退" disabled={!browser.canGoBack} onClick={() => void action("back")}><ArrowLeft size={16} /></button>
      <button title="前进" disabled={!browser.canGoForward} onClick={() => void action("forward")}><ArrowRight size={16} /></button>
      <button title={browser.isLoading ? "停止加载" : "刷新"} onClick={() => void action(browser.isLoading ? "stop" : "reload")}>{browser.isLoading ? <XCircle size={16} /> : <RefreshCw className={browser.isLoading ? "spin" : ""} size={16} />}</button>
      <button title="返回内置测试站" onClick={() => void action("home")}><Home size={16} /></button>
    </div>
    <form className="desktop-address" onSubmit={submit}>
      <span title={browser.security === "secure" ? "HTTPS 安全连接" : browser.security === "local" ? "本机网页" : "非安全连接"}>{browser.security === "secure" || browser.security === "local" ? <Lock size={13} /> : <AlertTriangle size={13} />}</span>
      <input aria-label="目标阅卷网站地址" value={address} onChange={(event) => { setAddress(event.target.value); setMessage(""); }} onKeyDown={handleAddressKeyDown} spellCheck={false} enterKeyHint="go" />
    </form>
    <span className={browser.plugin.connected ? "desktop-plugin-pill online" : "desktop-plugin-pill"}>{browser.plugin.connected ? <Plug size={13} /> : <Unplug size={13} />}{compact ? phaseLabel(browser.plugin.phase) : browser.plugin.adapterId}</span>
    <div className="desktop-browser-tools">
      <button title="保存网页截图" onClick={() => void action("capture_screenshot")}><Camera size={16} /></button>
      <button title="打开目标网页开发者工具" onClick={() => void action("open_devtools")}><Code2 size={16} /></button>
      <button title="重新加载插件" onClick={() => void action("reload_plugin")}><RotateCcw size={16} /></button>
    </div>
    {message && <span className="desktop-toolbar-message" role="status" aria-live="polite">{message}</span>}
  </div>;
}

function PipelineControls({ browser, confirmBeforeStart }: { browser: EmbeddedBrowserState; confirmBeforeStart: boolean }) {
  const [pending, setPending] = useState<PipelineControl | null>(null);
  const [error, setError] = useState("");
  const send = async (control: PipelineControl) => {
    if (control === "start" && confirmBeforeStart && !window.confirm("开始批改会向智学网写入并提交真实分数，确定继续吗？")) return;
    setPending(control); setError("");
    try {
      const host = getHost();
      if (!host) throw new Error("桌面端控制桥接尚未就绪");
      await host.controlPipeline(control);
    } catch (reason) {
      setError(cleanPipelineError(reason instanceof Error ? reason.message : reason) || "流水线控制失败");
    }
    finally { window.setTimeout(() => setPending(null), 280); }
  };
  const active = ["extracting", "grading", "writing_score", "submitting", "verifying", "navigating_next", "preflight"].includes(browser.plugin.phase);
  const pageReady = hasCompletePluginCapabilities(browser.plugin.capabilities) && browser.plugin.phase === "ready";
  return <div className="desktop-pipeline-controls">
    <div><span className={active ? "desktop-live-dot online pulse" : "desktop-live-dot"} /><div><strong>{error ? "启动失败" : phaseLabel(browser.plugin.phase)}</strong><small>{error || browser.plugin.message}</small></div></div>
    <button className="primary" disabled={active || pending !== null || !pageReady} onClick={() => void send("start")}>{pending === "start" ? <LoaderCircle className="spin" size={15} /> : <CirclePlay size={15} />}开始批改</button>
    <button title="暂停流水线" disabled={!active || pending !== null} onClick={() => void send("pause")}><CirclePause size={16} /></button>
    <button title="停止流水线" disabled={!active || pending !== null} onClick={() => void send("stop")}><Square size={15} /></button>
    <button title={browser.plugin.capabilities.skip ? "记录异常并跳过当前答卷" : "当前页面不支持跳过（批完当前份前无法进入下一份）"} disabled={pending !== null || !browser.plugin.capabilities.skip} onClick={() => void send("skip")}><SkipForward size={16} /></button>
  </div>;
}

const pipelineStageDefinitions = [
  { id: "extracting", label: "读取答卷" },
  { id: "grading", label: "模型批改" },
  { id: "writing_score", label: "写入分数" },
  { id: "verifying", label: "校验提交" },
  { id: "navigating_next", label: "下一份" }
] as const;

function pipelineStageIndex(phase: PluginPhase) {
  if (phase === "completed" || phase === "skipped") return pipelineStageDefinitions.length - 1;
  const index = pipelineStageDefinitions.findIndex((stage) => stage.id === phase);
  return index >= 0 ? index : -1;
}

function PipelineStageRail({ phase }: { phase: PluginPhase }) {
  const activeIndex = pipelineStageIndex(phase);
  const terminalTone = phase === "failed" ? "error" : phase === "skipped" ? "warning" : phase === "completed" ? "success" : "active";
  return <div className={`desktop-pipeline-rail ${terminalTone}`} aria-label="当前批改阶段">
    {pipelineStageDefinitions.map((stage, index) => {
      const completed = activeIndex >= 0 && index < activeIndex;
      const active = index === activeIndex && ["extracting", "grading", "writing_score", "submitting", "verifying", "navigating_next"].includes(phase);
      return <div className={completed ? "complete" : active ? "active" : ""} key={stage.id}>
        <span className="desktop-pipeline-rail-dot" />
        <strong>{stage.label}</strong>
        {index < pipelineStageDefinitions.length - 1 && <i />}
      </div>;
    })}
  </div>;
}

function PipelineMessageFeed({ browser, events }: { browser: EmbeddedBrowserState; events: PipelineEvent[] }) {
  const visible = events.slice(-4).reverse();
  return <section className="desktop-live-messages" aria-label="实时任务消息">
    <div className="desktop-live-messages-heading"><span><Activity size={14} />实时任务消息</span><a href="/logs?electron=1">查看完整日志</a></div>
    <div className="desktop-live-message-list">
      {visible.length ? visible.map((event, index) => <article className={pipelineEventTone(event)} style={{ animationDelay: `${Math.min(index, 7) * 20}ms` }} key={`${event.timestamp || "event"}-${index}`}>
        <span className="desktop-live-message-dot" />
        <div><strong>{pipelineEventLabel(event)}</strong><small>{event.phase ? phaseLabel(event.phase) : browser.plugin.adapterName}</small></div>
        <time>{formatTime(event.timestamp)}</time>
      </article>) : <article className="active"><span className="desktop-live-message-dot" /><div><strong>{browser.plugin.message || "等待开始批改"}</strong><small>{phaseLabel(browser.plugin.phase)}</small></div><time>--:--</time></article>}
    </div>
  </section>;
}

function TemplateInspector({ template }: { template: TemplateContext | null }) {
  const [tab, setTab] = useState<"question" | "rubric">("rubric");
  const emptyState = <div className="desktop-inspector-empty" role="status"><BookOpenCheck size={24} /><strong>尚未加载评分标准</strong><span>选择或绑定评分标准后，这里会显示题目原文与逐点判分依据。</span></div>;
  return <aside className="desktop-template-inspector">
    <div className="desktop-inspector-head"><div><span>当前评分标准</span><strong>{template?.title || "正在读取模板"}</strong></div><b>{template?.rubric.totalScore ?? "--"} 分</b></div>
    <div className="desktop-segmented" role="tablist">
      <button className={tab === "question" ? "active" : ""} onClick={() => setTab("question")}>题目原文</button>
      <button className={tab === "rubric" ? "active" : ""} onClick={() => setTab("rubric")}>评分标准</button>
    </div>
    <div className="desktop-inspector-scroll">
      {!template ? emptyState : tab === "question" ? <div className="desktop-question-copy"><MathText value={template.questionText || "题目原文尚未加载"} formulaByDefault /></div> : <div className="desktop-rubric-copy">
        {template.rubric.subquestions.map((question) => <details key={question.id} open>
          <summary><div><strong>{question.id} · {question.title}</strong><span>{question.scorePoints.length} 个评分点</span></div><b>{question.maxScore} 分</b><ChevronDown size={14} /></summary>
          <ol>{question.scorePoints.map((point) => <li key={point.id}><div><span>{point.id}</span><b>{point.score} 分</b></div><strong>{point.title}</strong>{point.description && <MathText value={point.description} formulaByDefault />}{point.expected && <div className="desktop-rubric-expected"><span>判分依据</span><MathText value={point.expected} formulaByDefault /></div>}<ScorePointGuidance point={point} /></li>)}</ol>
        </details>)}
      </div>}
    </div>
    <div className="desktop-inspector-foot"><BookOpenCheck size={13} /><span>{template?.ready ? `本次任务使用评分标准 v${template.rubric.version}` : "尚未选择评分标准"}</span></div>
  </aside>;
}

function ActiveJobPage({ browser, summary, template, preferences }: { browser: EmbeddedBrowserState; summary: PipelineSummary; template: TemplateContext | null; preferences: DesktopPreferences }) {
  return <div className="desktop-job-page">
    <PipelineControls browser={browser} confirmBeforeStart={preferences.confirmBeforeStart} />
    <PipelineStageRail phase={browser.plugin.phase} />
    {preferences.showLiveMessages && <PipelineMessageFeed browser={browser} events={summary.events} />}
    <div className="desktop-workbench">
      <TemplateInspector template={template} />
      <section className="desktop-browser-pane">
        <BrowserToolbar browser={browser} compact />
        <BrowserSurface />
        <footer className="desktop-workbench-footer"><span>已提交 <b>{summary.processed}</b></span><span>跳过 <b>{summary.skipped}</b></span><span>连续失败 <b>{browser.plugin.consecutiveFailures} / 3</b></span><span className="right">目标页与模型密钥保持进程隔离</span></footer>
      </section>
    </div>
  </div>;
}

function JobsPage({ template, browser, onEnterTest }: { template: TemplateContext | null; browser: EmbeddedBrowserState; onEnterTest: () => Promise<unknown> }) {
  return <div className="desktop-page-body">
    <section className="desktop-section desktop-job-setup">
      <div className="desktop-section-heading"><div><span>当前任务</span><h2>智学网自动批改</h2></div><span className="desktop-status-label active"><Activity size={13} />可启动</span></div>
      <div className="desktop-job-definition">
        <div><span>评分标准</span><strong>{template?.title || "尚未选择"}</strong><small>{template?.templateId || "--"}</small></div>
        <ChevronRight size={18} />
        <div><span>阅卷页面</span><strong>{browser.title || "等待打开智学网"}</strong><small>{browser.url || "尚未连接网页"}</small></div>
        <ChevronRight size={18} />
        <div><span>执行策略</span><strong>自动写分并翻页</strong><small>{browser.plugin.capabilities.skip ? "异常自动重试，重试耗尽后跳过" : "异常自动重试，重试耗尽后暂停人工处理"}</small></div>
      </div>
      <div className="desktop-callout"><ShieldCheck size={17} /><div><strong>学生数据与模型配置相互隔离</strong><p>系统只读取当前学生的答卷图像，并将模型给出的最终总分写回智学网；模型密钥始终保存在本机。</p></div></div>
      <div className="desktop-job-actions"><a className="desktop-primary-action inline" href="/jobs/new?electron=1"><CirclePlay size={16} />引导配置新任务<ChevronRight size={15} /></a><TestEntryButton onEnterTest={onEnterTest} /></div>
    </section>
    <section className="desktop-section">
      <div className="desktop-section-heading"><div><span>批改流程</span><h2>每份答卷将依次完成</h2></div></div>
      <div className="desktop-pipeline-map">{["确认当前页面", "读取答卷图像", "按标准评分", "写入最终总分", "确认提交成功", "进入下一份"].map((item, index) => <div key={item}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item}</strong>{index < 5 && <ChevronRight size={14} />}</div>)}</div>
    </section>
  </div>;
}

const guideSteps = ["模型服务", "评分标准", "阅卷页面", "分值匹配", "安全试运行", "启动确认"] as const;

type GuideDraft = {
  step: number;
  templateId: string;
  verifyWrite: boolean;
};

function readGuideDraft(): GuideDraft {
  try {
    const parsed = JSON.parse(localStorage.getItem("hengzhun.guideDraft.v1") || "{}") as Partial<GuideDraft>;
    return {
      step: Math.max(0, Math.min(5, Number(parsed.step) || 0)),
      templateId: typeof parsed.templateId === "string" ? parsed.templateId : "",
      verifyWrite: parsed.verifyWrite === true
    };
  } catch {
    return { step: 0, templateId: "", verifyWrite: false };
  }
}

function GuideCheck({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={ok ? "desktop-guide-check ok" : "desktop-guide-check"}>{ok ? <Check size={14} /> : <AlertTriangle size={14} />}{children}</span>;
}

function GuidedSetupPage({ browser }: { browser: EmbeddedBrowserState }) {
  const draft = useMemo(readGuideDraft, []);
  const [step, setStep] = useState(draft.step);
  const [model, setModel] = useState<ModelSetupStatus | null>(null);
  const [modelTest, setModelTest] = useState<ModelConnectionTestResult | null>(null);
  const [templates, setTemplates] = useState<GradingTemplateSummary[]>([]);
  const [templateId, setTemplateId] = useState(draft.templateId);
  const [template, setTemplate] = useState<GradingTemplateDetail | null>(null);
  const [inspection, setInspection] = useState<TargetPageInspection | null>(null);
  const [inspectedUrl, setInspectedUrl] = useState("");
  const [allowCompletedBatch, setAllowCompletedBatch] = useState(false);
  const [verifyWrite, setVerifyWrite] = useState(draft.verifyWrite);
  const [dryRun, setDryRun] = useState<PipelineDryRunResult | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const host = getHost();
    void host?.getModelSetupStatus().then(setModel).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "模型配置读取失败"));
    void api<GradingTemplateSummary[]>("/api/templates").then(setTemplates).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "评分模板读取失败"));
  }, []);

  useEffect(() => {
    localStorage.setItem("hengzhun.guideDraft.v1", JSON.stringify({ step, templateId, verifyWrite } satisfies GuideDraft));
  }, [step, templateId, verifyWrite]);

  useEffect(() => {
    if (!templateId) { setTemplate(null); return; }
    setDryRun(null);
    void api<GradingTemplateDetail>(`/api/templates/${encodeURIComponent(templateId)}`)
      .then(setTemplate)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "模板详情读取失败"));
  }, [templateId]);

  useEffect(() => {
    if (!inspection) return;
    const pageChanged = inspectedUrl !== browser.url
      || (inspection.pageKey !== undefined
        && browser.plugin.pageKey !== undefined
        && inspection.pageKey !== browser.plugin.pageKey);
    if (!pageChanged) return;
    setInspection(null);
    setInspectedUrl("");
    setDryRun(null);
    setAllowCompletedBatch(false);
  }, [browser.plugin.pageKey, browser.url, inspectedUrl, inspection]);

  const modelReady = Boolean(model?.configured && model.enabled && model.hasApiKey && model.visionModel && modelTest?.ok);
  const templateReady = Boolean(template);
  const inspectionIssues = inspection?.issues ?? [];
  const inspectionAccepted = Boolean(inspection?.ok && (!inspection.batchComplete || allowCompletedBatch));
  const inspectionMatchesCurrentPage = Boolean(inspection?.pageKey && browser.plugin.pageKey && inspection.pageKey === browser.plugin.pageKey);
  const pageCapabilitiesReady = hasCompletePluginCapabilities(browser.plugin.capabilities)
    || Boolean(inspection?.batchComplete && allowCompletedBatch);
  const targetReady = Boolean(
    inspectionAccepted
    && inspectedUrl === browser.url
    && inspectionMatchesCurrentPage
    && pageCapabilitiesReady
    && inspection?.autoSubmit !== true
  );
  const alignment = useMemo<PipelineScoreAlignment | null>(() => (
    template && inspection ? buildPipelineScoreAlignment(template.rubric, inspection.scoreFields) : null
  ), [inspection, template]);
  const alignmentReady = Boolean(targetReady && alignment?.ok);
  const dryRunReady = Boolean(dryRun
    && dryRun.maxScore === template?.rubric.totalScore
    && (!verifyWrite || dryRun.writeTest?.rolledBack));
  const readiness = [modelReady, templateReady, targetReady, alignmentReady, dryRunReady];

  const runAction = async (name: string, operation: () => Promise<void>) => {
    setPending(name);
    setError("");
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "配置步骤执行失败"); }
    finally { setPending(""); }
  };

  const testModel = () => runAction("model", async () => {
    const result = await getHost()!.testModelConnection();
    setModelTest(result);
  });

  const inspectTarget = () => runAction("inspect", async () => {
    const result = await getHost()!.inspectTargetPage();
    setInspection(result);
    setInspectedUrl(browser.url);
    setAllowCompletedBatch(false);
    setDryRun(null);
  });

  const bindTask = async () => {
    if (!template || !alignmentReady || !browser.url) throw new Error("评分模板与阅卷页面尚未完成安全匹配");
    await getHost()!.selectPipelineTask({ mode: "production", templateId: template.id, targetUrl: browser.url });
  };

  const runDryRun = () => runAction("dry-run", async () => {
    await bindTask();
    const result = await getHost()!.dryRunCurrentAnswer({ verifyWrite });
    setDryRun(result);
  });

  const next = () => runAction("next", async () => {
    if (!readiness[step]) throw new Error("请先完成当前步骤的检查");
    if (step === 3) await bindTask();
    setStep((value) => Math.min(5, value + 1));
  });

  const finish = () => runAction("finish", async () => {
    if (!dryRunReady) throw new Error("请先完成不提交试运行");
    await bindTask();
    localStorage.removeItem("hengzhun.guideDraft.v1");
    pushRoute("/jobs/current?electron=1");
  });

  let content: React.ReactNode;
  if (step === 0) {
    content = <>
      <div className="desktop-guide-heading"><span>步骤 1</span><h2>确认教师模型可用</h2><p>使用已保存配置进行一次视觉连接测试，不会发送学生答卷。</p></div>
      <div className="desktop-guide-status-list">
        <div><GuideCheck ok={Boolean(model?.configured)}>已保存模型配置</GuideCheck><strong>{model?.name || "尚未配置"}</strong></div>
        <div><GuideCheck ok={Boolean(model?.enabled && model.hasApiKey)}>配置已启用并包含密钥</GuideCheck><strong>{model?.visionModel || "未选择视觉模型"}</strong></div>
        <div><GuideCheck ok={Boolean(modelTest?.ok)}>视觉连接测试</GuideCheck><strong>{modelTest?.message || "本次任务尚未测试"}</strong></div>
      </div>
      <div className="desktop-form-actions"><button className="desktop-save-button" disabled={pending !== "" || !model?.configured} onClick={() => void testModel()}>{pending === "model" ? <LoaderCircle className="spin" size={15} /> : <Wifi size={15} />}测试视觉模型</button><a className="desktop-secondary-action" href="/models?electron=1"><Settings size={14} />打开模型配置</a></div>
    </>;
  } else if (step === 1) {
    content = <>
      <div className="desktop-guide-heading"><span>步骤 2</span><h2>选择评分标准</h2><p>这里只显示已保存的真实评分标准；内置测试模板不能用于生产任务。</p></div>
      <div className="desktop-guide-template-list">
        {templates.map((item) => <label key={item.id} className={templateId === item.id ? "selected" : ""}><input type="radio" name="guide-template" checked={templateId === item.id} onChange={() => setTemplateId(item.id)} /><div><strong>{item.title}</strong><span>{item.totalScore} 分 · 可编辑 · {item.gradingCount} 条历史记录</span></div><BookOpenCheck size={15} /></label>)}
        {!templates.length && <div className="desktop-guide-empty"><AlertTriangle size={18} /><strong>还没有可用于真实任务的评分标准</strong><span>请先在评分标准编辑器中导入题目和评分依据。</span></div>}
      </div>
      <a className="desktop-secondary-action" href="/templates/new?electron=1"><Plus size={14} />新建评分标准</a>
    </>;
  } else if (step === 2) {
    content = <>
      <div className="desktop-guide-heading"><span>步骤 3</span><h2>识别当前阅卷页面</h2><p>在下方完成登录并打开具体题目，然后让系统读取题号、满分和评分栏结构。</p></div>
      <BrowserToolbar browser={browser} compact />
      <div className="desktop-guide-browser"><BrowserSurface /></div>
      <div className="desktop-form-actions"><button className="desktop-save-button" disabled={pending !== "" || !browser.url || browser.isLoading} onClick={() => void inspectTarget()}>{pending === "inspect" ? <LoaderCircle className="spin" size={15} /> : <ListChecks size={15} />}识别当前页面</button></div>
      {inspection && <div className="desktop-guide-inspection"><div><span>站点适配</span><strong>{inspection.adapterName}</strong></div><div><span>题目</span><strong>{inspection.questionLabel || inspection.pageTitle}</strong></div><div><span>评分栏</span><strong>{inspection.scoreFields.length} 个 / 满分 {inspection.fullScore ?? "--"}</strong></div><div><span>自动提交</span><strong className={inspection.autoSubmit ? "warning" : ""}>{inspection.autoSubmit === undefined ? "未检测到" : inspection.autoSubmit ? "已开启，必须关闭" : "已关闭"}</strong></div>{inspection.progress && <div><span>阅卷进度</span><strong>{inspection.progress.completed} / {inspection.progress.total}</strong></div>}</div>}
      {inspectionIssues.map((issue) => <p className="desktop-guide-warning" key={issue}><AlertTriangle size={14} />{issue}</p>)}
      {inspection?.batchComplete && <div className="desktop-guide-caution desktop-guide-complete-override"><AlertTriangle size={17} /><div><strong>智学网报告当前批改任务已完成</strong><span>仍可继续做图像、字段和页面控制测试；正式流水线会把已完成状态视为批次终点。</span></div><button className="desktop-secondary-action" disabled={allowCompletedBatch} onClick={() => setAllowCompletedBatch(true)}>{allowCompletedBatch ? <Check size={14} /> : <ChevronRight size={14} />}{allowCompletedBatch ? "已允许继续" : "忽略完成状态，继续配置"}</button></div>}
    </>;
  } else if (step === 3) {
    content = <>
      <div className="desktop-guide-heading"><span>步骤 4</span><h2>核对网页总分与模板</h2><p>网页只接收最终总分；小问得分和逐点评审保留在批改历史与运行日志中。</p></div>
      {alignment && <div className="desktop-table-wrap"><table className="desktop-table desktop-guide-alignment"><thead><tr><th>网页输入</th><th>网页满分</th><th>本地匹配项</th><th>模板满分</th><th>状态</th></tr></thead><tbody>{alignment.rows.map((row) => <tr key={row.targetId}><td>{row.targetLabel}<small>{row.targetId}</small></td><td>{row.targetMaxScore ?? "--"}</td><td>{row.sourceLabel || "未匹配"}<small>{row.sourceId || "--"}</small></td><td>{row.sourceMaxScore ?? "--"}</td><td><GuideCheck ok={row.matched}>{row.matched ? "匹配" : "不一致"}</GuideCheck></td></tr>)}</tbody></table></div>}
      {alignment?.issues.map((issue) => <p className="desktop-guide-warning" key={issue}><AlertTriangle size={14} />{issue}</p>)}
      {alignment?.ok && <div className="desktop-guide-success"><ShieldCheck size={17} /><div><strong>最终总分匹配</strong><span>网页只写入模型最终总分；不会填写任何小问或过程评分框。</span></div></div>}
    </>;
  } else if (step === 4) {
    content = <>
      <div className="desktop-guide-heading"><span>步骤 5</span><h2>执行不提交试运行</h2><p>读取当前答卷并请求教师模型。可选的写入测试会校验网页字段后立即恢复原值，绝不点击提交。</p></div>
      <label className="desktop-guide-toggle"><input type="checkbox" checked={verifyWrite} onChange={(event) => { setVerifyWrite(event.target.checked); setDryRun(null); }} /><span><strong>同时验证最终总分写入并回滚</strong><small>只操作总分框；仅在网页自动提交关闭时使用</small></span></label>
      <button className="desktop-save-button" disabled={pending !== ""} onClick={() => void runDryRun()}>{pending === "dry-run" ? <LoaderCircle className="spin" size={15} /> : <CirclePlay size={15} />}开始安全试运行</button>
      {dryRun && <div className="desktop-guide-dry-result"><div><span>模型得分</span><strong>{dryRun.score} / {dryRun.maxScore}</strong></div><div><span>原图</span><strong>{Math.round(dryRun.imageBytes / 1024)} KB</strong><small>{dryRun.imageHash.slice(0, 12)}…</small></div><div><span>人工复核</span><strong className={dryRun.requiresReview ? "warning" : ""}>{dryRun.requiresReview ? "需要复核" : "无需复核"}</strong></div><div><span>网页最终总分</span><strong>{dryRun.writeTest ? dryRun.writeTest.message : "未执行"}</strong></div></div>}
    </>;
  } else {
    content = <>
      <div className="desktop-guide-heading"><span>步骤 6</span><h2>任务已通过启动检查</h2><p>进入实时批改页面后仍需由教师点击“开始批改”，此时才会写入并提交真实成绩。</p></div>
      <div className="desktop-guide-review"><div><span>评分模板</span><strong>{template?.title}</strong><small>版本 {template?.rubric.version} · 满分 {template?.rubric.totalScore}</small></div><div><span>阅卷页面</span><strong>{inspection?.questionLabel || inspection?.pageTitle}</strong><small>{inspection?.scoreFields.length} 个评分栏 · {inspection?.adapterName}</small></div><div><span>试运行</span><strong>{dryRun?.score} / {dryRun?.maxScore}</strong><small>{dryRun?.writeTest ? "写入与回滚已验证" : "已完成只读评分"}</small></div></div>
      <div className="desktop-guide-caution"><AlertTriangle size={17} /><div><strong>“开始批改”会提交真实成绩</strong><span>首次运行应由教师观察至少一份答卷的写分、提交成功和自动翻页结果。</span></div></div>
    </>;
  }

  return <div className="desktop-guide-page">
    <aside className="desktop-guide-steps" aria-label="任务配置步骤">{guideSteps.map((label, index) => <button key={label} className={index === step ? "active" : index < step && readiness[index] ? "complete" : ""} onClick={() => index <= step && setStep(index)}><span>{index < step && readiness[index] ? <Check size={14} /> : index + 1}</span><strong>{label}</strong></button>)}</aside>
    <section className="desktop-guide-content">{error && <div className="desktop-global-error"><AlertTriangle size={15} />{error}</div>}{content}<footer className="desktop-guide-actions"><button className="desktop-secondary-action" disabled={step === 0 || pending !== ""} onClick={() => setStep((value) => Math.max(0, value - 1))}>上一步</button>{step < 5 ? <button className="desktop-save-button" disabled={!readiness[step] || pending !== ""} onClick={() => void next()}>{pending === "next" ? <LoaderCircle className="spin" size={15} /> : null}下一步<ChevronRight size={15} /></button> : <button className="desktop-save-button" disabled={!dryRunReady || pending !== ""} onClick={() => void finish()}>{pending === "finish" ? <LoaderCircle className="spin" size={15} /> : <CirclePlay size={15} />}进入实时批改</button>}</footer></section>
  </div>;
}

function TemplateTable({ activeTemplateId, onBind, onEmpty }: {
  activeTemplateId?: string;
  onBind: (templateId: string) => Promise<TemplateContext>;
  onEmpty?: () => void;
}) {
  const [templates, setTemplates] = useState<GradingTemplateSummary[]>([]);
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const reload = useCallback(async () => {
    try {
      const items = await api<GradingTemplateSummary[]>("/api/templates");
      setTemplates(items);
      setSelectedIds((current) => new Set([...current].filter((id) => items.some((item) => item.id === id && item.id !== activeTemplateId))));
      if (!items.length) onEmpty?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模板读取失败");
    }
  }, [activeTemplateId, onEmpty]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const bind = async (templateId: string) => {
    setPendingId(templateId);
    setError("");
    try { await onBind(templateId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "评分标准绑定失败"); }
    finally { setPendingId(""); }
  };
  const selectableIds = templates.filter((item) => item.id !== activeTemplateId).map((item) => item.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
  const toggle = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(selectableIds));
  const removeSelected = async () => {
    const selected = templates.filter((item) => selectedIds.has(item.id));
    if (!selected.length) return;
    const recordCount = selected.reduce((total, item) => total + item.gradingCount, 0);
    if (!window.confirm(`确定永久删除选中的 ${selected.length} 个评分标准吗？\n\n将同时删除其下 ${recordCount} 条批改记录和全部相关图片，此操作无法恢复。`)) return;
    setDeleting(true);
    setError("");
    try {
      await api("/api/templates", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selected.map((item) => item.id) })
      });
      setSelectedIds(new Set());
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "评分标准删除失败");
    } finally {
      setDeleting(false);
    }
  };
  return <>{error && <div className="desktop-error-state desktop-template-bind-error"><AlertTriangle size={18} />{error}</div>}
    <div className="desktop-bulk-toolbar"><label><input type="checkbox" checked={allSelected} disabled={!selectableIds.length || deleting} onChange={toggleAll} /><span>全选可删除项</span></label><span>已选择 {selectedIds.size} 项</span><button className="desktop-danger-action" disabled={!selectedIds.size || deleting} onClick={() => void removeSelected()}>{deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{deleting ? "正在删除" : "删除所选"}</button></div>
    <div className="desktop-table-wrap"><table className="desktop-table desktop-template-table"><thead><tr><th className="desktop-selection-cell"><span className="desktop-visually-hidden">选择</span></th><th>模板</th><th>状态</th><th>满分</th><th>题目素材</th><th>批改记录</th><th>更新时间</th><th>当前任务</th><th /></tr></thead><tbody>
    {templates.map((item) => {
      const active = activeTemplateId === item.id;
      return <tr className={`${active ? "bound" : ""} ${selectedIds.has(item.id) ? "selected" : ""}`} key={item.id}><td className="desktop-selection-cell"><input type="checkbox" aria-label={`选择评分标准 ${item.title}`} checked={selectedIds.has(item.id)} disabled={active || deleting} title={active ? "当前任务正在使用此评分标准，不能删除" : "选择评分标准"} onChange={() => toggle(item.id)} /></td><td><strong style={sharedElementStyle(sharedElementName("prism-template-title", item.id))}>{item.title}</strong><small>{item.id}</small></td><td><span className="desktop-status-label locked"><BookOpenCheck size={12} />可编辑</span></td><td><span style={sharedElementStyle(sharedElementName("prism-template-score", item.id))}>{item.totalScore} 分</span></td><td>{item.questionImageCount + item.referenceImageCount} 张</td><td>{item.gradingCount}</td><td>{new Date(item.updatedAt).toLocaleString("zh-CN", { hour12: false })}</td><td>{active ? <span className="desktop-status-label locked"><Link2 size={12} />已绑定</span> : <button className="desktop-template-bind-button" disabled={Boolean(pendingId) || deleting} onClick={() => void bind(item.id)}>{pendingId === item.id ? <LoaderCircle className="spin" size={13} /> : <Link2 size={13} />}{pendingId === item.id ? "正在匹配" : "绑定到当前任务"}</button>}</td><td><a title="打开模板" href={`/templates/${encodeURIComponent(item.id)}?electron=1`}><ChevronRight size={16} /></a></td></tr>;
    })}
    {!templates.length && <tr><td colSpan={9} className="desktop-empty-cell">暂无评分模板</td></tr>}
  </tbody></table></div></>;
}

function TemplatesPage({ template, onBindTemplate }: { template: TemplateContext | null; onBindTemplate: (templateId: string) => Promise<TemplateContext> }) {
  return <div className="desktop-page-body"><section className="desktop-section"><div className="desktop-section-heading"><div><span>本地模板库</span><h2>已保存的评分标准</h2><p className="desktop-section-description">评分标准可以继续修改；绑定后流水线固定使用当时选定的版本。</p></div><a className="desktop-save-button" href="/templates/new?electron=1"><Plus size={15} />新建评分标准</a></div><TemplateTable activeTemplateId={template?.templateId} onBind={onBindTemplate} /></section></div>;
}

function TemplateMaterialInput({ title, icon, text, images, placeholder, busy, onText, onImages, onDocument }: {
  title: string;
  icon: React.ReactNode;
  text: string;
  images: TemplateMaterialImage[];
  placeholder: string;
  busy: boolean;
  onText: (value: string) => void;
  onImages: (value: TemplateMaterialImage[]) => void;
  onDocument: (file: File) => void;
}) {
  const imageInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const appendImages = (files: File[], source: TemplateMaterialImage["source"]) => {
    const available = Math.max(0, 10 - images.length);
    const next = files.filter((file) => file.type.startsWith("image/")).slice(0, available).map((file) => ({
      id: crypto.randomUUID(), file, preview: URL.createObjectURL(file), source
    }));
    if (next.length) onImages([...images, ...next]);
  };
  const paste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    appendImages(files, "paste");
  };
  const removeImage = (id: string) => {
    const target = images.find((image) => image.id === id);
    if (target) URL.revokeObjectURL(target.preview);
    onImages(images.filter((image) => image.id !== id));
  };
  return <section className="desktop-template-material">
    <header><div>{icon}<strong>{title}</strong></div><div><button title={`为${title}添加图片`} onClick={() => imageInput.current?.click()}><ImagePlus size={15} />添加图片</button><button title={`导入${title}文档`} disabled={busy} onClick={() => documentInput.current?.click()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}导入文档</button></div></header>
    <textarea value={text} onChange={(event) => onText(event.target.value)} onPaste={paste} placeholder={placeholder} />
    <input ref={imageInput} hidden type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => { appendImages(Array.from(event.target.files || []), "upload"); event.currentTarget.value = ""; }} />
    <input ref={documentInput} hidden type="file" accept=".txt,.md,.docx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => { const file = event.target.files?.[0]; if (file) onDocument(file); event.currentTarget.value = ""; }} />
    {images.length > 0 && <div className="desktop-template-image-list">{images.map((image) => <article key={image.id}><img src={image.preview} alt={`${title}附图`} /><div><strong>{image.file.name}</strong><span>{image.source === "paste" ? "剪贴板粘贴" : "本地添加"}</span></div><button title="移除图片" onClick={() => removeImage(image.id)}><Trash2 size={14} /></button></article>)}</div>}
    <footer><span>{text.length ? `${text.length} 个字符` : "尚未输入文字"}</span><span>{images.length} / 10 张图片</span><span><ImagePlus size={12} />可在输入框按 Ctrl+V 粘贴截图</span></footer>
  </section>;
}

function RubricRefinement({ busy, message, onRefine }: {
  busy: boolean;
  message: string;
  onRefine: (instruction: string) => Promise<void>;
}) {
  const [instruction, setInstruction] = useState("");
  const submit = async () => {
    const value = instruction.trim();
    if (!value || busy) return;
    try {
      await onRefine(value);
      setInstruction("");
    } catch {
      // Keep the teacher instruction available for correction and retry.
    }
  };
  return <div className="desktop-rubric-refinement">
    <div className="desktop-rubric-refinement-heading"><Sparkles size={16} /><div><strong>补充评分细节</strong><span>当前完整 JSON 会交给教师模型修改；总分、题号、评分点 ID 和分值保持不变。</span></div></div>
    <textarea value={instruction} maxLength={4000} disabled={busy} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：补充使用动量定理的替代解法；说明第三小问可接受的等价形式；明确单位错误时的判分说明。" />
    <footer><span>{message || `${instruction.length} / 4000`}</span><button className="desktop-save-button" disabled={!instruction.trim() || busy} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{busy ? "教师模型正在修改" : "交给教师模型完善"}</button></footer>
  </div>;
}

function TemplateCreatePage() {
  const [questionText, setQuestionText] = useState("");
  const [referenceText, setReferenceText] = useState("");
  const [questionImages, setQuestionImages] = useState<TemplateMaterialImage[]>([]);
  const [referenceImages, setReferenceImages] = useState<TemplateMaterialImage[]>([]);
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [rubricJson, setRubricJson] = useState("");
  const [editingJson, setEditingJson] = useState(false);
  const [busy, setBusy] = useState<"question-document" | "reference-document" | "structure" | "refine" | "save" | null>(null);
  const [error, setError] = useState("");
  const [refinementMessage, setRefinementMessage] = useState("");
  const materialReady = Boolean((questionText.trim() || questionImages.length) && (referenceText.trim() || referenceImages.length));
  const invalidateRubric = () => { setRubric(null); setRubricJson(""); setEditingJson(false); };
  const updateQuestionText = (value: string) => { setQuestionText(value); if (rubric) invalidateRubric(); };
  const updateReferenceText = (value: string) => { setReferenceText(value); if (rubric) invalidateRubric(); };
  const updateQuestionImages = (value: TemplateMaterialImage[]) => { setQuestionImages(value); if (rubric) invalidateRubric(); };
  const updateReferenceImages = (value: TemplateMaterialImage[]) => { setReferenceImages(value); if (rubric) invalidateRubric(); };
  const extractDocument = async (file: File, target: "question" | "reference") => {
    setBusy(target === "question" ? "question-document" : "reference-document"); setError("");
    try {
      const result = await uploadDocument(file);
      if (target === "question") updateQuestionText(questionText.trim() ? `${questionText.trim()}\n\n${result.text}` : result.text);
      else updateReferenceText(referenceText.trim() ? `${referenceText.trim()}\n\n${result.text}` : result.text);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "文档内容提取失败"); }
    finally { setBusy(null); }
  };
  const structure = async () => {
    if (!materialReady) return;
    setBusy("structure"); setError("");
    try {
      const form = new FormData();
      form.append("questionText", questionText.trim() || "题目文字见题目图片");
      form.append("referenceText", referenceText.trim() || "参考答案与评分标准见图片");
      questionImages.forEach((image) => form.append("questionImages", image.file, image.file.name));
      referenceImages.forEach((image) => form.append("referenceImages", image.file, image.file.name));
      const generated = await api<Rubric>("/api/rubrics/structure", { method: "POST", body: form });
      setRubric({ ...generated, status: "draft" });
      setRubricJson(JSON.stringify({ ...generated, status: "draft" }, null, 2));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "评分标准生成失败"); }
    finally { setBusy(null); }
  };
  const applyJson = () => {
    try {
      const next = JSON.parse(rubricJson) as Rubric;
      if (!next.title || !Array.isArray(next.subquestions) || !Number.isFinite(next.totalScore)) throw new Error("评分标准缺少标题、总分或小问");
      setRubric({ ...next, status: "draft" }); setEditingJson(false); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "JSON 格式无效"); }
  };
  const refine = async (instruction: string) => {
    if (!rubric) return;
    setBusy("refine"); setError(""); setRefinementMessage("");
    try {
      const next = await api<Rubric>("/api/rubrics/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rubric, instruction })
      });
      setRubric(next); setRubricJson(JSON.stringify(next, null, 2)); setEditingJson(false);
      setRefinementMessage("教师模型已更新草稿，请核对后保存");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "评分细节补充失败"); throw reason; }
    finally { setBusy(null); }
  };
  const saveTemplate = async () => {
    if (!rubric) return;
    setBusy("save"); setError("");
    try {
      const savedRubric: Rubric = { ...rubric, status: "saved" };
      const form = new FormData();
      form.append("questionText", questionText);
      form.append("referenceText", referenceText);
      form.append("rubric", JSON.stringify(savedRubric));
      questionImages.forEach((image) => form.append("questionImages", image.file, image.file.name));
      referenceImages.forEach((image) => form.append("referenceImages", image.file, image.file.name));
      const saved = await api<GradingTemplateSummary>("/api/templates", { method: "POST", body: form });
      pushRoute(`/templates/${encodeURIComponent(saved.id)}?electron=1`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "评分标准保存失败"); setBusy(null); }
  };
  return <div className="desktop-page-body desktop-template-create">
    <nav className="desktop-template-create-progress" aria-label="新建评分标准进度"><span className="complete"><Check size={14} />导入材料</span><i /><span className={rubric ? "complete" : materialReady ? "active" : ""}>{rubric ? <Check size={14} /> : "2"}生成与核对</span><i /><span className={rubric ? "active" : ""}>3 保存</span></nav>
    {error && <div className="desktop-error-state"><AlertTriangle size={17} />{error}{/模型配置|API Key|模型/.test(error) && <a href="/models?electron=1">检查教师模型</a>}</div>}
    <section className="desktop-section desktop-template-import-section">
      <div className="desktop-section-heading"><div><span>步骤 1</span><h2>导入题目与评分依据</h2></div><span className="desktop-status-label">TXT · MD · DOCX · 文本型 PDF · 图片</span></div>
      <div className="desktop-template-material-grid">
        <TemplateMaterialInput title="题目原文" icon={<FileText size={18} />} text={questionText} images={questionImages} placeholder="粘贴题目文字；有题图时可以添加图片或直接粘贴截图。" busy={busy === "question-document"} onText={updateQuestionText} onImages={updateQuestionImages} onDocument={(file) => void extractDocument(file, "question")} />
        <TemplateMaterialInput title="参考答案与评分标准" icon={<FileCheck2 size={18} />} text={referenceText} images={referenceImages} placeholder="粘贴参考答案和逐点给分要求；公式可以使用 LaTeX。" busy={busy === "reference-document"} onText={updateReferenceText} onImages={updateReferenceImages} onDocument={(file) => void extractDocument(file, "reference")} />
      </div>
      <div className="desktop-template-generate-action"><div><strong>{rubric ? "材料发生修改后需要重新生成" : materialReady ? "材料已准备完成" : "题目和评分依据都需要提供文字或图片"}</strong><span>模型先生成评分标准草稿，保存后仍可继续修改。</span></div><button className="desktop-save-button" disabled={!materialReady || busy !== null} onClick={() => void structure()}>{busy === "structure" ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{busy === "structure" ? "正在生成评分标准" : rubric ? "重新生成评分标准" : "生成评分标准"}</button></div>
    </section>
    {rubric && <section className="desktop-section desktop-template-review-section">
      <div className="desktop-section-heading"><div><span>步骤 2</span><h2>核对评分标准草稿</h2></div><div className="desktop-template-review-actions"><button className="desktop-secondary-action" onClick={() => setEditingJson((value) => !value)}><Code2 size={14} />{editingJson ? "返回预览" : "高级编辑"}</button><button className="desktop-save-button" disabled={busy !== null || editingJson} onClick={() => void saveTemplate()}>{busy === "save" ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{busy === "save" ? "正在保存" : "保存评分标准"}</button></div></div>
      <div className="desktop-template-name-field"><label><span>评分标准名称</span><input value={rubric.title} onChange={(event) => { const next = { ...rubric, title: event.target.value, status: "draft" as const }; setRubric(next); setRubricJson(JSON.stringify(next, null, 2)); }} /></label><div><span>总分</span><strong>{rubric.totalScore} 分</strong></div><div><span>小问</span><strong>{rubric.subquestions.length}</strong></div><div><span>评分点</span><strong>{rubric.subquestions.reduce((total, item) => total + item.scorePoints.length, 0)}</strong></div></div>
      <RubricRefinement busy={busy === "refine"} message={refinementMessage} onRefine={refine} />
      {rubric.warnings.length > 0 && <div className="desktop-template-warning"><AlertTriangle size={17} /><div><strong>保存前请检查以下提示</strong>{rubric.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></div>}
      {editingJson ? <div className="desktop-template-json-editor"><textarea value={rubricJson} onChange={(event) => setRubricJson(event.target.value)} spellCheck={false} /><footer><button className="desktop-secondary-action" onClick={() => { setRubricJson(JSON.stringify(rubric, null, 2)); setEditingJson(false); }}>取消修改</button><button className="desktop-save-button" onClick={applyJson}><Check size={15} />应用修改</button></footer></div> : <div className="desktop-rubric-table desktop-template-rubric-preview">{rubric.subquestions.map((question) => <div key={question.id}><header><div><strong>{question.id} · {question.title}</strong><span>{question.scorePoints.length} 个评分点</span></div><b>{question.maxScore} 分</b></header>{question.finalAnswers.length > 0 && <div className="desktop-template-final-answers"><span>参考结果</span><div>{question.finalAnswers.map((answer, index) => <span key={`${answer.expression}-${index}`}><MathText value={answer.expression} formulaByDefault />{answer.unit && <small>{answer.unit}</small>}</span>)}</div></div>}{question.scorePoints.map((point) => <article key={point.id}><span>{point.id}</span><div><strong>{point.title}</strong><MathText value={point.description} formulaByDefault /><div className="desktop-rubric-expected"><span>判分依据</span><MathText value={point.expected} formulaByDefault /></div><ScorePointGuidance point={point} defaultOpen /></div><b>{point.score} 分</b></article>)}</div>)}</div>}
    </section>}
  </div>;
}

function ManualTemplateGrade({ templateId }: { templateId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [studentId, setStudentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const selectFile = (next: File | undefined) => {
    setError("");
    if (!next) return;
    if (!next.type.startsWith("image/")) {
      setError("请选择 JPG、PNG 或 WEBP 格式的试卷图片");
      return;
    }
    if (next.size > 15 * 1024 * 1024) {
      setError("试卷图片不能超过 15 MB");
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(URL.createObjectURL(next));
    if (!studentId) setStudentId(next.name.replace(/\.[^.]+$/, ""));
  };

  const grade = async () => {
    if (!file || busy) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("image", file, file.name);
      if (studentId.trim()) form.append("studentId", studentId.trim());
      const result = await api<GradingResult>(`/api/templates/${encodeURIComponent(templateId)}/grade`, { method: "POST", body: form });
      pushRoute(`/history/${encodeURIComponent(result.id)}?electron=1`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "试卷评分失败");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return <div className="desktop-template-grade-launch"><button className="desktop-save-button" onClick={() => setOpen(true)}><Upload size={14} />上传试卷评分</button></div>;

  return <div className="desktop-template-grade-panel">
    <div className="desktop-template-grade-heading"><div><strong>手动上传试卷评分</strong><span>使用当前已保存版本评分，完成后自动保存到批改记录。</span></div><button title="收起上传区" onClick={() => setOpen(false)}><X size={15} /></button></div>
    <div className="desktop-template-grade-content">
      <button className={`desktop-template-grade-preview ${preview ? "selected" : ""}`} onClick={() => inputRef.current?.click()}>
        {preview ? <img src={preview} alt="待评分试卷预览" /> : <><ImagePlus size={24} /><strong>选择试卷图片</strong><span>JPG、PNG、WEBP，最大 15 MB</span></>}
      </button>
      <div className="desktop-template-grade-fields">
        <label><span>学生标识</span><input value={studentId} maxLength={100} placeholder="例如：张三 / 学号 202601" onChange={(event) => setStudentId(event.target.value)} /></label>
        <div className="desktop-template-grade-file"><span>答卷文件</span><strong>{file?.name || "尚未选择"}</strong>{file && <small>{(file.size / 1024 / 1024).toFixed(2)} MB</small>}</div>
        {error && <div className="desktop-template-grade-error"><AlertTriangle size={14} />{error}</div>}
        <div className="desktop-template-grade-actions"><button className="desktop-secondary-action" disabled={busy} onClick={() => inputRef.current?.click()}><ImagePlus size={14} />{file ? "更换图片" : "选择图片"}</button><button className="desktop-save-button" disabled={!file || busy} onClick={() => void grade()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{busy ? "正在调用模型评分" : "开始评分"}</button></div>
      </div>
    </div>
    <input ref={inputRef} className="desktop-visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { selectFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
  </div>;
}

function TemplateDetailPage({ templateId }: { templateId?: string }) {
  const [template, setTemplate] = useState<GradingTemplateDetail | null>(null);
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [rubricJson, setRubricJson] = useState("");
  const [editingJson, setEditingJson] = useState(false);
  const [busy, setBusy] = useState<"refine" | "save" | null>(null);
  const [changed, setChanged] = useState(false);
  const [refinementMessage, setRefinementMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!templateId) return;
    void api<GradingTemplateDetail>(`/api/templates/${encodeURIComponent(templateId)}`).then((next) => {
      setTemplate(next); setRubric(next.rubric); setRubricJson(JSON.stringify(next.rubric, null, 2));
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "模板读取失败"));
  }, [templateId]);
  const applyRubric = (next: Rubric, message = "") => {
    const draft = { ...next, status: "draft" as const };
    setRubric(draft); setRubricJson(JSON.stringify(draft, null, 2)); setEditingJson(false); setChanged(true); setRefinementMessage(message);
  };
  const applyJson = () => {
    try {
      const next = JSON.parse(rubricJson) as Rubric;
      if (!next.title || !Array.isArray(next.subquestions) || !Number.isFinite(next.totalScore)) throw new Error("评分标准缺少标题、总分或小问");
      applyRubric(next); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "JSON 格式无效"); }
  };
  const refine = async (instruction: string) => {
    if (!rubric) return;
    setBusy("refine"); setError(""); setRefinementMessage("");
    try {
      const next = await api<Rubric>("/api/rubrics/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rubric, instruction })
      });
      applyRubric(next, "教师模型已更新草稿，保存后将生成新版本");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "评分细节补充失败"); throw reason; }
    finally { setBusy(null); }
  };
  const save = async () => {
    if (!template || !rubric || !changed) return;
    setBusy("save"); setError("");
    try {
      const next = await api<GradingTemplateDetail>(`/api/templates/${encodeURIComponent(template.id)}/rubric`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rubric })
      });
      setTemplate(next); setRubric(next.rubric); setRubricJson(JSON.stringify(next.rubric, null, 2));
      setChanged(false); setEditingJson(false); setRefinementMessage(`已保存为 v${next.rubric.version}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "评分标准保存失败"); }
    finally { setBusy(null); }
  };
  if (error && !template) return <div className="desktop-page-body"><div className="desktop-error-state"><AlertTriangle size={18} />{error}</div></div>;
  if (!template || !rubric) return <DesktopLoading label="正在读取模板详情" />;
  return <div className="desktop-page-body desktop-template-detail">
    {error && <div className="desktop-error-state"><AlertTriangle size={17} />{error}</div>}
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>{template.id}</span><h2 style={sharedElementStyle(sharedElementName("prism-template-title", template.id))}>{rubric.title}</h2></div><div className="desktop-template-review-actions"><span className="desktop-status-label locked"><BookOpenCheck size={13} />评分标准 v{template.rubric.version} · 可编辑</span><button className="desktop-secondary-action" disabled={busy !== null} onClick={() => setEditingJson((value) => !value)}><Code2 size={14} />{editingJson ? "返回预览" : "高级编辑"}</button><button className="desktop-save-button" disabled={!changed || busy !== null || editingJson} onClick={() => void save()}>{busy === "save" ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{busy === "save" ? "正在保存" : changed ? `保存为 v${template.rubric.version + 1}` : "已保存"}</button></div></div><div className="desktop-template-summary"><div><span>满分</span><strong style={sharedElementStyle(sharedElementName("prism-template-score", template.id))}>{rubric.totalScore} 分</strong></div><div><span>小问</span><strong>{rubric.subquestions.length}</strong></div><div><span>历史答卷</span><strong>{template.records.length}</strong></div><div><span>素材</span><strong>{template.questionImageCount + template.referenceImageCount} 张</strong></div></div>{changed && <div className="desktop-template-unsaved"><AlertTriangle size={14} />当前修改尚未保存；上传评分仍使用已保存的 v{template.rubric.version}。</div>}<ManualTemplateGrade templateId={template.id} /></section>
    <div className="desktop-two-columns"><section className="desktop-section"><div className="desktop-section-heading"><div><span>题目</span><h2>识别原文</h2></div></div><div className="desktop-document-copy"><MathText value={template.questionText} formulaByDefault /></div></section><section className="desktop-section"><div className="desktop-section-heading"><div><span>参考答案</span><h2>标准解答</h2></div></div><div className="desktop-document-copy"><MathText value={template.referenceText} formulaByDefault /></div></section></div>
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>逐点给分</span><h2>评分标准</h2></div></div><RubricRefinement busy={busy === "refine"} message={refinementMessage} onRefine={refine} />{editingJson ? <div className="desktop-template-json-editor"><textarea value={rubricJson} onChange={(event) => setRubricJson(event.target.value)} spellCheck={false} /><footer><button className="desktop-secondary-action" onClick={() => { setRubricJson(JSON.stringify(rubric, null, 2)); setEditingJson(false); }}>取消修改</button><button className="desktop-save-button" onClick={applyJson}><Check size={15} />应用修改</button></footer></div> : <div className="desktop-rubric-table">{rubric.subquestions.map((question) => <div key={question.id}><header><strong>{question.id} · {question.title}</strong><b>{question.maxScore} 分</b></header>{question.scorePoints.map((point) => <article key={point.id}><span>{point.id}</span><div><strong>{point.title}</strong>{point.description && <MathText value={point.description} formulaByDefault />}{point.expected && <div className="desktop-rubric-expected"><span>判分依据</span><MathText value={point.expected} formulaByDefault /></div>}<ScorePointGuidance point={point} /></div><b>{point.score} 分</b></article>)}</div>)}</div>}</section>
  </div>;
}

function HistoryPage() {
  const [rows, setRows] = useState<Array<{ record: GradingHistoryRecord; templateId: string; templateTitle: string }>>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { records } = await api<{ records: Array<{ record: GradingHistoryRecord; templateId: string; templateTitle: string }> }>("/api/history-records?limit=200");
      const nextRows = records.map((row) => ({ record: row.record, templateId: row.templateId, templateTitle: row.templateTitle }));
      setRows(nextRows);
      setSelectedIds((current) => new Set([...current].filter((id) => nextRows.some((row) => row.record.id === id))));
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "批改记录读取失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const filtered = useMemo(() => rows.filter((row) => `${row.record.result.fileName} ${row.record.result.studentId} ${row.templateTitle}`.toLowerCase().includes(query.trim().toLowerCase())), [query, rows]);
  const reviewCount = rows.filter((row) => row.record.result.status !== "completed").length;
  const filteredIds = filtered.map((row) => row.record.id);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const toggleRecord = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleFiltered = () => setSelectedIds((current) => {
    const next = new Set(current);
    if (allFilteredSelected) filteredIds.forEach((id) => next.delete(id));
    else filteredIds.forEach((id) => next.add(id));
    return next;
  });
  const removeSelected = async () => {
    if (!selectedIds.size) return;
    if (!window.confirm(`确定永久删除选中的 ${selectedIds.size} 条批改记录吗？\n\n相关评分结果、模型原始返回和不再使用的答卷图片将一并删除，此操作无法恢复。`)) return;
    setDeleting(true);
    setError("");
    try {
      await api("/api/history-records", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selectedIds] })
      });
      setSelectedIds(new Set());
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "批改记录删除失败");
    } finally {
      setDeleting(false);
    }
  };
  if (error) return <div className="desktop-page-body"><div className="desktop-error-state"><AlertTriangle size={18} />{error}</div></div>;
  return <div className="desktop-page-body desktop-history-page">
    <section className="desktop-history-overview"><div><span>全部答卷</span><strong>{rows.length}</strong></div><div><span>已完成</span><strong>{rows.length - reviewCount}</strong></div><div className={reviewCount ? "warning" : ""}><span>待复核</span><strong>{reviewCount}</strong></div><div><span>评分标准</span><strong>{new Set(rows.map((row) => row.templateId)).size}</strong></div></section>
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>学生答卷</span><h2>逐份批改记录</h2></div><span className="desktop-status-label"><FileClock size={13} />自动保存</span></div>
      <div className="desktop-history-toolbar"><label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索答卷、学生编号或评分标准" /></label><span>{filtered.length} 条记录</span></div>
      <div className="desktop-bulk-toolbar"><label><input type="checkbox" checked={allFilteredSelected} disabled={!filtered.length || deleting} onChange={toggleFiltered} /><span>全选当前结果</span></label><span>已选择 {selectedIds.size} 条</span><button className="desktop-danger-action" disabled={!selectedIds.size || deleting} onClick={() => void removeSelected()}>{deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{deleting ? "正在删除" : "删除所选"}</button></div>
      <div className="desktop-table-wrap"><table className="desktop-table desktop-history-table"><thead><tr><th className="desktop-selection-cell"><span className="desktop-visually-hidden">选择</span></th><th>答卷</th><th>评分标准</th><th>得分</th><th>状态</th><th>模型</th><th>批改时间</th><th /></tr></thead><tbody>
        {filtered.map(({ record, templateTitle }) => <tr className={selectedIds.has(record.id) ? "selected" : ""} key={record.id}><td className="desktop-selection-cell"><input type="checkbox" aria-label={`选择批改记录 ${record.result.fileName}`} checked={selectedIds.has(record.id)} disabled={deleting} onChange={() => toggleRecord(record.id)} /></td><td><strong>{record.result.fileName}</strong><small>{record.result.studentId || record.id}</small></td><td><span style={sharedElementStyle(sharedElementName("prism-record-template", record.id))}>{templateTitle}</span></td><td><b className="desktop-history-score" style={sharedElementStyle(sharedElementName("prism-record-score", record.id))}>{record.result.score} / {record.result.maxScore}</b></td><td><span className={`desktop-status-label ${record.result.status === "completed" ? "locked" : "warning"}`}>{record.result.status === "completed" ? <Check size={12} /> : <AlertTriangle size={12} />}{record.result.status === "completed" ? "已完成" : record.result.status === "needs_review" ? "待复核" : "失败"}</span></td><td>{record.result.modelName}<small>{record.modelCallCount} 次调用</small></td><td>{new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}</td><td><a title="打开批改记录" href={`/history/${encodeURIComponent(record.id)}?electron=1`}><ChevronRight size={16} /></a></td></tr>)}
        {!filtered.length && <tr><td colSpan={8} className="desktop-empty-cell">{loading ? "正在读取批改记录" : query ? "没有符合条件的批改记录" : "暂无批改记录"}</td></tr>}
      </tbody></table></div>
    </section>
  </div>;
}

function RecordPage({ recordId }: { recordId?: string }) {
  const [record, setRecord] = useState<GradingHistoryRecord | null>(null);
  const [templateTitle, setTemplateTitle] = useState("");
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [modelCalls, setModelCalls] = useState<ModelCallHistoryEntry[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!recordId) return;
    void (async () => {
      try {
        const { records } = await api<{ records: Array<{ record: GradingHistoryRecord; templateId: string; templateTitle: string; rubric: Rubric }> }>(
          `/api/history-records?recordId=${encodeURIComponent(recordId)}`
        );
        const found = records[0];
        if (!found) throw new Error("找不到该批改记录");
        setRecord(found.record); setTemplateTitle(found.templateTitle); setRubric(found.rubric);
        try {
          setModelCalls(await api<ModelCallHistoryEntry[]>(`/api/history-records/${encodeURIComponent(found.record.id)}/model-calls`));
        } catch {
          setModelCalls([]);
        }
      } catch (reason) { setError(reason instanceof Error ? reason.message : "记录读取失败"); }
    })();
  }, [recordId]);
  if (error) return <div className="desktop-page-body"><div className="desktop-error-state"><AlertTriangle size={18} />{error}</div></div>;
  if (!record) return <DesktopLoading label="正在检索批改记录" />;
  return <div className="desktop-page-body desktop-record-detail-page">
    <section className="desktop-record-overview">
      <div><span>评分标准</span><strong style={sharedElementStyle(sharedElementName("prism-record-template", record.id))}>{templateTitle}</strong></div>
      <div><span>批改时间</span><strong>{new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}</strong></div>
      <div><span>规则覆盖率</span><strong>{Math.round(record.result.metrics.ruleCoverage * 100)}%</strong></div>
      <div><span>证据可追溯</span><strong>{Math.round(record.result.metrics.evidenceTraceability * 100)}%</strong></div>
      <div><span>自动决策率</span><strong>{Math.round(record.result.metrics.autoDecisionRate * 100)}%</strong></div>
      <div><span>批改耗时</span><strong>{(record.result.metrics.durationMs / 1000).toFixed(1)} 秒</strong></div>
    </section>
    <section className="desktop-section desktop-record-audit">
      <ResultDetail
        result={record.result}
        rubric={rubric ?? undefined}
        answerImageUrl={record.answerImage.url}
        canRegrade={false}
        regrading={false}
        scoreViewTransitionName={sharedElementName("prism-record-score", record.id)}
        onRegrade={async () => undefined}
      />
    </section>
    {modelCalls ? <ModelCallHistory calls={modelCalls} /> : <section className="model-call-history"><div className="model-call-history-empty">正在读取本题模型原始调用...</div></section>}
  </div>;
}

function LogsPage() {
  const [snapshot, setSnapshot] = useState<SystemLogSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [stopError, setStopError] = useState("");
  const reload = useCallback(() => {
    const host = getHost();
    void Promise.all([
      api<SystemLogSnapshot>("/api/logs?limit=400"),
      host?.getPipelineEvents().catch(() => [] as PipelineEvent[]) ?? Promise.resolve([] as PipelineEvent[])
    ]).then(([next, pipelineEvents]) => {
      const pipelineEntries = pipelineEvents.map(pipelineEventLogEntry);
      setSnapshot({
        ...next,
        entries: [...next.entries, ...pipelineEntries]
          .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
          .slice(-500)
      });
    });
  }, []);
  useEffect(() => { reload(); if (!autoRefresh) return; const timer = window.setInterval(reload, 2000); return () => window.clearInterval(timer); }, [autoRefresh, reload]);
  const forceStop = async (operationId: string, label: string, scope: SystemLogEntry["scope"]) => {
    if (!window.confirm(`确定强制停止“${label}”吗？\n\n当前模型请求会立即中断，当前答卷不会写分、提交或跳到下一份。`)) return;
    setStoppingId(operationId);
    setStopError("");
    try {
      if (scope === "grading") await getHost()?.controlPipeline("stop").catch(() => undefined);
      await api(`/api/operations/${encodeURIComponent(operationId)}/force-stop`, { method: "POST" });
      reload();
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "强制停止失败");
    } finally {
      setStoppingId(null);
    }
  };
  const entries = useMemo(() => (snapshot?.entries || []).filter((entry) => `${entry.scope} ${entry.step} ${entry.message}`.toLowerCase().includes(query.toLowerCase())).slice().reverse(), [query, snapshot]);
  return <div className="desktop-page-body desktop-logs-page">
    <section className="desktop-log-toolbar"><label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选步骤、消息或作用域" /></label><button className={autoRefresh ? "active" : ""} onClick={() => setAutoRefresh((value) => !value)}><RefreshCw className={autoRefresh ? "spin-slow" : ""} size={14} />自动刷新</button><button title="立即刷新" onClick={reload}><RefreshCw size={15} /></button></section>
    {stopError && <div className="desktop-log-stop-error"><AlertTriangle size={13} />{stopError}</div>}
    <section className="desktop-log-layout"><aside><span>活动操作</span>{snapshot?.activeOperations.length ? snapshot.activeOperations.map((operation) => <div key={operation.id}><LoaderCircle className="spin" size={14} /><strong>{operation.label}</strong><small>{operation.step}</small>{operation.cancellable && <button className="desktop-force-stop" title="强制停止任务" disabled={stoppingId !== null} onClick={() => void forceStop(operation.id, operation.label, operation.scope)}>{stoppingId === operation.id ? <LoaderCircle className="spin" size={12} /> : <Square size={11} />}<span>{stoppingId === operation.id ? "正在停止" : "强制停止"}</span></button>}</div>) : <p>当前没有运行中的模型调用</p>}</aside><div className="desktop-log-stream">{entries.map((entry) => <LogEntry key={entry.id} entry={entry} />)}{!entries.length && <div className="desktop-empty-state"><TerminalSquare size={22} /><strong>暂无匹配日志</strong><span>运行任务后，模型调用和流水线步骤会显示在这里。</span></div>}</div></section>
  </div>;
}

function pipelineEventLogEntry(event: PipelineEvent, index: number): SystemLogEntry {
  const tone = pipelineEventTone(event);
  const timestamp = typeof event.timestamp === "string" ? event.timestamp : new Date(0).toISOString();
  return {
    id: `pipeline-${timestamp}-${event.type}-${index}`,
    operationId: String(event.pageKey || event.sourcePageKey || "pipeline"),
    timestamp,
    level: tone === "error" ? "error" : tone === "warning" ? "warning" : tone === "success" ? "success" : "info",
    status: tone === "error" ? "failed" : tone === "success" ? "completed" : "progress",
    scope: "system",
    step: `pipeline:${event.type}`,
    message: pipelineEventLabel(event),
    details: { ...event, reason: cleanPipelineError(event.reason) || event.reason }
  };
}

function LogEntry({ entry }: { entry: SystemLogEntry }) {
  const [open, setOpen] = useState(false);
  const modelCall = entry.scope === "model" && entry.details?.kind === "model_call";
  return <article className={`desktop-log-entry ${entry.level}`}><button onClick={() => setOpen((value) => !value)}><span>{formatTime(entry.timestamp)}</span><i>{entry.scope}</i><strong>{entry.message}</strong><em>{entry.status}</em><ChevronDown className={open ? "open" : ""} size={15} /></button>{open && (modelCall ? <div className="desktop-model-call-detail"><ModelCallDetails details={entry.details as unknown as ModelCallLogDetails} /></div> : <pre>{JSON.stringify(entry.details || { step: entry.step, operationId: entry.operationId }, null, 2)}</pre>)}</article>;
}

function ModelsPage() {
  const [form, setForm] = useState<ModelConfigInput>(defaultModelConfig);
  const [current, setCurrent] = useState<PublicModelConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { void api<PublicModelConfig | null>("/api/model-config").then((value) => { setCurrent(value); if (value) setForm({ ...value, apiKey: "", reviewApiKey: "" }); }); }, []);
  const update = <K extends keyof ModelConfigInput>(key: K, value: ModelConfigInput[K]) => setForm((previous) => ({ ...previous, [key]: value }));
  const save = async () => {
    setSaving(true); setMessage("");
    try {
      const saved = await api<PublicModelConfig>("/api/model-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      setCurrent(saved); setForm((value) => ({ ...value, apiKey: "", reviewApiKey: "" })); setMessage("配置已应用到全局模型调用");
    } catch (error) { setMessage(error instanceof Error ? error.message : "配置保存失败"); }
    finally { setSaving(false); }
  };
  return <div className="desktop-page-body desktop-model-page">
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>OpenAI 兼容接口</span><h2>全局连接信息</h2></div><span className={current?.enabled && current.hasApiKey ? "desktop-status-label locked" : "desktop-status-label warning"}>{current?.enabled && current.hasApiKey ? <Wifi size={13} /> : <WifiOff size={13} />}{current?.enabled && current.hasApiKey ? "已配置" : "待配置"}</span></div>
      <div className="desktop-form-grid"><label><span>配置名称</span><input value={form.name} onChange={(event) => update("name", event.target.value)} /></label><label className="wide"><span>教师 API Base URL</span><input value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" /></label><label className="wide"><span>教师 API Key</span><div className="desktop-input-with-icon"><KeyRound size={14} /><input type="password" value={form.apiKey || ""} onChange={(event) => update("apiKey", event.target.value)} placeholder={current?.hasApiKey ? `保留现有密钥 ${current.apiKeyMasked}` : "输入教师服务密钥"} /></div></label><label><span>多模态教师模型</span><input value={form.visionModel} onChange={(event) => update("visionModel", event.target.value)} /></label><label><span>文本模型</span><input value={form.textModel} onChange={(event) => update("textModel", event.target.value)} /></label><label><span>局部审验模型</span><input value={form.reviewModel || ""} onChange={(event) => update("reviewModel", event.target.value)} placeholder="留空则不主动审验数值答案" /></label><label className="wide"><span>审验 API Base URL</span><input value={form.reviewBaseUrl || ""} onChange={(event) => update("reviewBaseUrl", event.target.value)} placeholder="留空则复用教师服务地址" /></label><label className="wide"><span>审验 API Key</span><div className="desktop-input-with-icon"><ShieldCheck size={14} /><input type="password" value={form.reviewApiKey || ""} onChange={(event) => update("reviewApiKey", event.target.value)} placeholder={current?.hasReviewApiKey ? `保留现有审验密钥 ${current.reviewApiKeyMasked}` : "输入独立审验服务密钥"} /></div></label></div>
    </section>
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>调用策略</span><h2>批改参数</h2></div></div><div className="desktop-form-grid three"><label><span>批改模式</span><select value={form.gradingMode} onChange={(event) => update("gradingMode", event.target.value as ModelConfigInput["gradingMode"])}><option value="vision_direct">教师模型直看图像</option><option value="evidence_pipeline">证据转录流水线</option></select></label><label><span>教师模型推理强度</span><select value={form.teacherReasoningEffort} onChange={(event) => update("teacherReasoningEffort", event.target.value as ModelConfigInput["teacherReasoningEffort"])}><option value="disabled">不传 reasoning_effort</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option><option value="ultra">ultra</option></select></label><label><span>审验模型推理强度</span><select value={form.reviewReasoningEffort} onChange={(event) => update("reviewReasoningEffort", event.target.value as ModelConfigInput["reviewReasoningEffort"])}><option value="disabled">不传 reasoning_effort</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option><option value="ultra">ultra</option></select></label><label><span>超时（毫秒）</span><input type="number" min={1000} max={300000} value={form.timeoutMs} onChange={(event) => update("timeoutMs", Number(event.target.value))} /></label><label><span>最大重试</span><input type="number" min={0} max={5} value={form.maxRetries} onChange={(event) => update("maxRetries", Number(event.target.value))} /></label><label><span>并发数</span><input type="number" min={1} max={20} value={form.maxConcurrency} onChange={(event) => update("maxConcurrency", Number(event.target.value))} /></label><label><span>人工复核分值阈值</span><input type="number" step={0.5} min={0.5} value={form.unreadableReviewThreshold} onChange={(event) => update("unreadableReviewThreshold", Number(event.target.value))} /></label></div>
      <div className="desktop-toggle-row"><label><input type="checkbox" checked={form.supportsJsonSchema} onChange={(event) => update("supportsJsonSchema", event.target.checked)} /><span>JSON Schema</span></label><label><input type="checkbox" checked={form.supportsJsonObject} onChange={(event) => update("supportsJsonObject", event.target.checked)} /><span>JSON Object</span></label><label><input type="checkbox" checked={form.supportsBase64Images} onChange={(event) => update("supportsBase64Images", event.target.checked)} /><span>Base64 图像</span></label><label><input type="checkbox" checked={form.enabled} onChange={(event) => update("enabled", event.target.checked)} /><span>启用此配置</span></label></div>
      <div className="desktop-form-actions"><button className="desktop-save-button" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存并全局应用</button>{message && <span>{message}</span>}</div>
    </section>
  </div>;
}

function BrowserDebugPage({ browser }: { browser: EmbeddedBrowserState }) {
  const [inspection, setInspection] = useState<TargetPageInspection | null>(null);
  const [score, setScore] = useState("");
  const [pending, setPending] = useState<"inspect" | PluginDiagnosticAction | null>(null);
  const [records, setRecords] = useState<Array<{ id: string; ok: boolean; title: string; message: string; detail?: string }>>([]);
  const host = getHost();
  const diagnosticsAvailable = typeof host?.runPluginDiagnostic === "function";
  useEffect(() => {
    setInspection(null);
  }, [browser.url]);
  useEffect(() => {
    if (!inspection || inspection.pageKey === undefined) return;
    if (browser.plugin.pageKey === undefined || inspection.pageKey === browser.plugin.pageKey) return;
    setInspection(null);
  }, [browser.plugin.pageKey, inspection]);
  const appendRecord = (record: Omit<(typeof records)[number], "id">) => {
    setRecords((current) => [{ ...record, id: `${Date.now()}-${Math.random()}` }, ...current].slice(0, 8));
  };
  const inspect = async (recordResult = true) => {
    if (!host) return;
    setPending("inspect");
    try {
      const result = await host.inspectTargetPage();
      setInspection(result);
      if (recordResult) appendRecord({
        ok: result.ok,
        title: "页面检测",
        message: result.ok ? `已识别 ${result.scoreFields.length} 个最终总分框` : result.issues.join("；") || "页面检查未通过",
        detail: result.pageKey
      });
    } catch (error) {
      if (recordResult) appendRecord({ ok: false, title: "页面检测", message: error instanceof Error ? error.message : "页面检测失败" });
    } finally {
      setPending(null);
    }
  };
  const runDiagnostic = async (action: PluginDiagnosticAction) => {
    if (!host?.runPluginDiagnostic) return;
    const numericScore = score.trim() === "" ? undefined : Number(score);
    if (action === "write-score" && !Number.isFinite(numericScore)) {
      appendRecord({ ok: false, title: "写入测试分数", message: "请输入有效的测试分数" });
      return;
    }
    setPending(action);
    const titles: Record<PluginDiagnosticAction, string> = {
      "extract-image": "提取学生图像",
      "previous-page": "进入上一份",
      "next-page": "进入下一份",
      "write-score": "写入测试分数",
      "clear-score": "清空总分框"
    };
    try {
      const result: PluginDiagnosticResult = await host.runPluginDiagnostic({ action, score: numericScore });
      appendRecord({
        ok: true,
        title: titles[action],
        message: result.message,
        detail: result.savedImage?.path || result.pageKey || (result.fieldId ? `${result.fieldId}${result.score === undefined ? "" : ` = ${result.score}`}` : undefined)
      });
      if (action === "previous-page" || action === "next-page") await inspect(false);
    } catch (error) {
      appendRecord({ ok: false, title: titles[action], message: error instanceof Error ? error.message : "插件行为测试失败" });
    } finally {
      setPending(null);
    }
  };
  const busy = pending !== null;
  const inspectionMatchesCurrentPage = browser.plugin.phase === "ready"
    && inspection?.pageKey !== undefined
    && inspection.pageKey === browser.plugin.pageKey;
  const capabilities = inspectionMatchesCurrentPage && inspection ? inspection.capabilities : browser.plugin.capabilities;
  const diagnosticsReady = browser.plugin.phase === "ready" && hasCompletePluginCapabilities(capabilities);
  return <div className="desktop-debug-browser-page"><BrowserToolbar browser={browser} /><div className="desktop-debug-browser-layout"><aside className="desktop-browser-diagnostics">
    <div className="desktop-browser-facts"><div><span>页面标题</span><strong>{browser.title || "--"}</strong></div><div><span>连接安全</span><strong>{browser.security}</strong></div><div><span>加载状态</span><strong>{browser.crashed ? "渲染进程异常" : browser.isLoading ? "正在加载" : "加载完成"}</strong></div><div><span>浏览器引擎</span><strong>Electron {host?.version || "--"}</strong></div><div><span>插件适配器</span><strong>{browser.plugin.adapterId}</strong></div><div><span>页面线索（非学生 ID）</span><strong title="由答卷图像地址和当前题目文字生成，只用于判断网页是否切换">{inspection?.pageKey || browser.plugin.pageKey || "--"}</strong></div></div>
    <p className="desktop-browser-fingerprint-note"><AlertTriangle size={13} /><span><b>zhixue:xxxxxxxx</b> 是网页切换线索，不代表学生身份。提取答卷后系统会改用图像内容的 SHA-256 校验，作为真正的答卷唯一标识。</span></p>
    <section className="desktop-plugin-test-panel">
      <div className="desktop-plugin-test-heading"><div><span>插件行为测试</span><strong>{inspection?.questionLabel || "当前答卷"}</strong></div><button title="重新检测当前页面" disabled={busy} onClick={() => void inspect()}>{pending === "inspect" ? <LoaderCircle className="spin" size={15} /> : <ListChecks size={15} />}</button></div>
      {!diagnosticsAvailable && <p className="desktop-plugin-test-notice"><AlertTriangle size={14} />主程序组件尚未载入本次更新，重启工作台后可执行下列动作。</p>}
      <div className="desktop-plugin-test-actions">
        <button disabled={busy || !diagnosticsAvailable || !diagnosticsReady} onClick={() => void runDiagnostic("extract-image")}><ImageDown size={15} />提取并保存图像</button>
        <div className="desktop-plugin-page-actions"><button disabled={busy || !diagnosticsAvailable || !diagnosticsReady} onClick={() => void runDiagnostic("previous-page")}><ArrowLeft size={15} />上一份</button><button disabled={busy || !diagnosticsAvailable || !diagnosticsReady} onClick={() => void runDiagnostic("next-page")}>下一份<ArrowRight size={15} /></button></div>
      </div>
      <div className="desktop-plugin-score-test"><label><span>测试总分{inspection?.fullScore !== undefined ? `（满分 ${inspection.fullScore}）` : ""}</span><input type="number" min={0} max={inspection?.fullScore} step="0.5" value={score} onChange={(event) => setScore(event.target.value)} placeholder="输入分数" /></label><div><button disabled={busy || !diagnosticsAvailable || !diagnosticsReady || !score.trim()} onClick={() => void runDiagnostic("write-score")}>写入</button><button title="清空网页最终总分框" disabled={busy || !diagnosticsAvailable || !diagnosticsReady} onClick={() => void runDiagnostic("clear-score")}><XCircle size={14} /></button></div><small>只修改最终总分框，不点击提交。</small></div>
      <div className="desktop-plugin-test-log"><span>最近操作</span>{records.length ? records.map((record) => <article className={record.ok ? "ok" : "failed"} key={record.id}><div>{record.ok ? <Check size={13} /> : <XCircle size={13} />}<strong>{record.title}</strong></div><p>{record.message}</p>{record.detail && <code>{record.detail}</code>}</article>) : <p className="empty">尚未执行插件行为测试</p>}</div>
    </section>
    <p className="desktop-browser-session-note">目标站点使用独立持久化会话；诊断图像保存到项目的 <code>tmp/plugin-diagnostics</code> 目录。</p>
  </aside><BrowserSurface /></div></div>;
}

function PluginsDebugPage({ browser }: { browser: EmbeddedBrowserState }) {
  const capabilities = browser.plugin.capabilities;
  const isZhixue = browser.plugin.adapterId === "zhixue-grading";
  const [pending, setPending] = useState(false);
  const preflight = async () => { setPending(true); try { await getHost()?.controlPipeline("preflight"); } finally { window.setTimeout(() => setPending(false), 300); } };
  return <div className="desktop-page-body desktop-plugin-debug">
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>当前适配器</span><h2>{browser.plugin.adapterName}</h2></div><span className={browser.plugin.connected ? "desktop-status-label locked" : "desktop-status-label warning"}>{browser.plugin.connected ? <Plug size={13} /> : <Unplug size={13} />}{phaseLabel(browser.plugin.phase)}</span></div><div className="desktop-plugin-meta"><div><span>ID</span><strong>{browser.plugin.adapterId}</strong></div><div><span>版本</span><strong>{browser.plugin.adapterVersion}</strong></div><div><span>页面线索</span><strong title="非学生 ID，仅用于判断智学网页面是否切换">{browser.plugin.pageKey || "未识别"}</strong></div><div><span>更新时间</span><strong>{formatTime(browser.plugin.updatedAt)}</strong></div></div><div className="desktop-form-actions"><button className="desktop-save-button" disabled={pending} onClick={() => void preflight()}>{pending ? <LoaderCircle className="spin" size={15} /> : <ListChecks size={15} />}重新执行页面检查</button><button className="desktop-secondary-action" onClick={() => void getHost()?.runBrowserAction("reload_plugin")}><RotateCcw size={14} />重载插件</button></div></section>
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>DOM 能力</span><h2>自动化控件检查</h2></div></div><div className="desktop-capability-grid"><Capability label="学生答卷图像" value={capabilities.answerImage} selector={isZhixue ? "#topicImgContent 原始作答图" : "[data-grading-answer-image] / img / canvas"} /><Capability label="最终总分输入框" value={capabilities.scoreInput} selector={isZhixue ? "可见总分/满分输入框（只写最终总分）" : "[data-grading-score]"} /><Capability label="提交按钮" value={capabilities.submit} selector={isZhixue ? "#bnt_save" : "[data-grading-submit]"} /><Capability label="下一份按钮" value={capabilities.next} selector={isZhixue ? "a[title='下一份']" : "[data-grading-next]"} /><Capability label="跳过当前答卷" value={capabilities.skip} selector={isZhixue ? "不支持（批完当前份前无法进入下一份）" : "未批完可翻页即支持"} /></div></section>
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>适配顺序</span><h2>预置插件</h2></div></div><div className="desktop-adapter-list"><div><span>01</span><div><strong>zhixue-grading</strong><p>智学网专用适配器；本地 `/zhixue-mock` 复刻真实阅卷 DOM，用于导入测试用例和回归验证。</p></div><b>专用</b></div><div><span>02</span><div><strong>mock-grading</strong><p>通用 `data-grading-*` 控件测试站，保留用于通用适配器回归。</p></div><b>启用</b></div><div><span>03</span><div><strong>generic-data-attributes</strong><p>真实网站通用适配器，使用稳定 data 属性定位答卷、写分与翻页控件。</p></div><b>后备</b></div></div></section>
  </div>;
}

function Capability({ label, value, selector }: { label: string; value: boolean; selector: string }) {
  return <article className={value ? "ok" : "failed"}>{value ? <Check size={17} /> : <XCircle size={17} />}<div><strong>{label}</strong><code>{selector}</code></div><span>{value ? "已找到" : "缺失"}</span></article>;
}

function SettingsPage({ preferences, onPreferencesChange }: { preferences: DesktopPreferences; onPreferencesChange: (patch: Partial<DesktopPreferences>) => void }) {
  const [startUrl, setStartUrl] = useState(() => readStartUrl(localStorage));
  const [saved, setSaved] = useState(false);
  const save = () => { localStorage.setItem(START_URL_STORAGE_KEY, startUrl); setSaved(true); window.setTimeout(() => setSaved(false), 1800); };
  const fontOptions: Array<{ value: DesktopFontSize; label: string; description: string }> = [
    { value: "compact", label: "紧凑", description: "适合较小窗口" },
    { value: "comfortable", label: "舒适", description: "推荐的默认大小" },
    { value: "large", label: "大号", description: "更易阅读" }
  ];
  const fontFamilyOptions: Array<{ value: UiFontFamily; label: string; description: string; preview: string }> = [
    { value: "system", label: "Windows 系统", description: "Segoe UI + 微软雅黑 UI", preview: "衡准 · Segoe UI" },
    { value: "inter", label: "Inter", description: "现代、清晰的中性无衬线", preview: "衡准 · Inter" },
    { value: "noto-sans-sc", label: "Noto Sans SC", description: "中英文均衡，适合长文本", preview: "衡准 · Noto Sans" },
    { value: "source-han-sans", label: "思源黑体", description: "中文笔画稳定、信息密度高", preview: "衡准 · 思源黑体" },
    { value: "microsoft-yahei", label: "微软雅黑 UI", description: "Windows 中文界面风格", preview: "衡准 · 微软雅黑" }
  ];
  const monoFontOptions: Array<{ value: UiMonoFontFamily; label: string; description: string }> = [
    { value: "cascadia", label: "Cascadia", description: "Windows 现代等宽字体" },
    { value: "consolas", label: "Consolas", description: "经典、紧凑的代码字体" },
    { value: "system", label: "系统等宽", description: "跟随操作系统的等宽字体" }
  ];
  const fontWeightOptions: Array<{ value: DesktopFontWeight; label: string }> = [
    { value: 400, label: "常规 400" },
    { value: 500, label: "中等 500" },
    { value: 600, label: "半粗 600" },
    { value: 700, label: "粗体 700" }
  ];
  const accentOptions: Array<{ value: PluginAccent; label: string; color: string }> = [
    { value: "teal", label: "青绿", color: "#13a8a2" },
    { value: "blue", label: "海蓝", color: "#397fe8" },
    { value: "green", label: "松绿", color: "#2d8b68" },
    { value: "graphite", label: "石墨", color: "#4f6572" }
  ];
  const materialOptions: Array<{ value: WindowMaterial; label: string; description: string }> = [
    { value: "solid", label: "纯色", description: "稳定、低占用的纯色回退" },
    { value: "mica", label: "Mica", description: "Windows 11 推荐材质" },
    { value: "acrylic", label: "Acrylic", description: "更通透的局部玻璃层" }
  ];
  const motionOptions: Array<{ value: MotionIntensity; label: string; description: string }> = [
    { value: "off", label: "关闭", description: "只保留必要的短淡入" },
    { value: "comfortable", label: "舒适", description: "适合长时间阅卷" },
    { value: "lively", label: "绚丽", description: "加强关键状态反馈" }
  ];
  return <div className="desktop-page-body desktop-settings-page">
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>外观</span><h2>界面显示</h2></div><span className="desktop-status-label active">即时生效</span></div>
      <div className="desktop-setting-block"><div className="desktop-setting-copy"><strong>强调色</strong><span>同步应用到工作台和智学网页面内的阅卷插件。</span></div><div className="desktop-accent-picker" role="group" aria-label="界面强调色">{accentOptions.map((option) => <button key={option.value} className={preferences.accent === option.value ? "active" : ""} aria-pressed={preferences.accent === option.value} onClick={() => onPreferencesChange({ accent: option.value })}><i style={{ background: option.color }} /><span>{option.label}</span>{preferences.accent === option.value && <Check size={13} />}</button>)}</div></div>
      <div className="desktop-setting-block vertical"><div className="desktop-setting-copy"><strong>材质模式</strong><span>Windows 11 优先使用原生 Mica；不支持时自动保持不透明浅灰回退。</span></div><div className="desktop-font-size-picker prism-material-picker" role="group" aria-label="材质模式">{materialOptions.map((option) => <button key={option.value} className={preferences.materialMode === option.value ? "active" : ""} aria-pressed={preferences.materialMode === option.value} onClick={() => onPreferencesChange({ materialMode: option.value })}><strong>{option.label}</strong><span>{option.description}</span></button>)}</div></div>
      <div className="desktop-setting-block vertical"><div className="desktop-setting-copy"><strong>动效强度</strong><span>动效集中在页面切换、状态变化和关键操作反馈，不改变控件尺寸。</span></div><div className="desktop-font-size-picker prism-motion-picker" role="group" aria-label="动效强度">{motionOptions.map((option) => <button key={option.value} className={preferences.motionIntensity === option.value ? "active" : ""} aria-pressed={preferences.motionIntensity === option.value} onClick={() => onPreferencesChange({ motionIntensity: option.value })}><strong>{option.label}</strong><span>{option.description}</span></button>)}</div></div>
      <div className="desktop-setting-block prism-range-grid"><label><span>透明度</span><input type="range" min="68" max="92" step="1" value={preferences.surfaceOpacity} disabled={preferences.materialMode === "solid"} title={preferences.materialMode === "solid" ? "纯色模式下不启用透明效果" : undefined} style={{ "--prism-range-fill": `${((preferences.surfaceOpacity - 68) / 24) * 100}%` } as CSSProperties} onChange={(event) => onPreferencesChange({ surfaceOpacity: Number(event.target.value) })} /><output>{preferences.surfaceOpacity}%</output></label><label><span>模糊强度</span><input type="range" min="12" max="28" step="2" value={preferences.blurStrength} disabled={preferences.materialMode === "solid"} title={preferences.materialMode === "solid" ? "纯色模式下不启用模糊效果" : undefined} style={{ "--prism-range-fill": `${((preferences.blurStrength - 12) / 16) * 100}%` } as CSSProperties} onChange={(event) => onPreferencesChange({ blurStrength: Number(event.target.value) })} /><output>{preferences.blurStrength}px</output></label>{preferences.materialMode === "solid" ? <p className="desktop-setting-hint">当前为纯色模式，透明与模糊不生效；切换为 Mica 或 Acrylic 后启用。</p> : <p className="desktop-setting-hint">透明度与模糊作用于整个页面（侧栏、页头、内容卡片与表格），向下拖动可透出背景光斑。</p>}</div>
      <div className="desktop-setting-block vertical"><div className="desktop-setting-copy"><strong>字体大小</strong><span>按屏幕尺寸和阅读习惯选择，不会缩放网页答卷。</span></div><div className="desktop-font-size-picker" role="group" aria-label="界面字体大小">{fontOptions.map((option) => <button key={option.value} className={preferences.fontSize === option.value ? "active" : ""} aria-pressed={preferences.fontSize === option.value} onClick={() => onPreferencesChange({ fontSize: option.value })}><strong>{option.label}</strong><span>{option.description}</span></button>)}</div></div>
      <div className="desktop-setting-block vertical"><div className="desktop-setting-copy"><strong>字体族</strong><span>只使用本机已经安装的字体；未安装时会自动按字体栈回退，不会影响程序启动。</span></div><div className="desktop-font-family-picker" role="group" aria-label="界面字体族">{fontFamilyOptions.map((option) => <button key={option.value} className={preferences.fontFamily === option.value ? "active" : ""} aria-pressed={preferences.fontFamily === option.value} onClick={() => onPreferencesChange({ fontFamily: option.value })} style={{ fontFamily: fontFamilyStacks[option.value] }}><strong>{option.preview}</strong><span>{option.label} · {option.description}</span></button>)}</div></div>
      <div className="desktop-typography-grid">
        <label><span>正文粗细</span><select value={preferences.fontWeight} onChange={(event) => onPreferencesChange({ fontWeight: Number(event.target.value) as DesktopFontWeight })}>{fontWeightOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span>等宽字体</span><select value={preferences.monoFontFamily} onChange={(event) => onPreferencesChange({ monoFontFamily: event.target.value as UiMonoFontFamily })}>{monoFontOptions.map((option) => <option key={option.value} value={option.value}>{option.label} · {option.description}</option>)}</select></label>
        <label><span>细节缩放</span><input type="range" min="0.9" max="1.2" step="0.05" value={preferences.fontScale} onChange={(event) => onPreferencesChange({ fontScale: Number(event.target.value) })} /><output>{Math.round(preferences.fontScale * 100)}%</output></label>
        <label><span>正文行高</span><input type="range" min="1.3" max="1.9" step="0.05" value={preferences.lineHeight} onChange={(event) => onPreferencesChange({ lineHeight: Number(event.target.value) })} /><output>{preferences.lineHeight.toFixed(2)}</output></label>
        <label><span>字间距</span><input type="range" min="-0.02" max="0.06" step="0.01" value={preferences.letterSpacing} onChange={(event) => onPreferencesChange({ letterSpacing: Number(event.target.value) })} /><output>{preferences.letterSpacing > 0 ? "+" : ""}{preferences.letterSpacing.toFixed(2)}em</output></label>
      </div>
      <div className="desktop-font-preview" style={{ fontFamily: fontFamilyStacks[preferences.fontFamily], fontWeight: preferences.fontWeight, lineHeight: preferences.lineHeight, letterSpacing: `${preferences.letterSpacing}em` }}><div><span>字体实时预览</span><strong>衡准自动改卷工作台</strong><p>高中物理 · 评分标准 · Newton's second law: F = ma</p></div><code style={{ fontFamily: monoFontStacks[preferences.monoFontFamily] }}>score = 8 / 10</code></div>
      <div className="desktop-form-actions desktop-typography-actions"><button className="desktop-secondary-action" onClick={() => onPreferencesChange({ fontFamily: "noto-sans-sc", monoFontFamily: "cascadia", fontWeight: 500, fontScale: 1.1, lineHeight: 1.5, letterSpacing: 0 })}><RotateCcw size={14} />恢复字体默认</button><span className="desktop-setting-hint">字体设置会同时作用于工作台和网页中的衡准控制插件；答卷网页自身的字体不被修改。</span></div>
      <div className="desktop-setting-block"><div className="desktop-setting-copy"><strong>界面密度</strong><span>控制页面留白和列表行高，字体大小保持不变。</span></div><div className="desktop-segment-control" role="group" aria-label="界面密度"><button className={preferences.density === "comfortable" ? "active" : ""} aria-pressed={preferences.density === "comfortable"} onClick={() => onPreferencesChange({ density: "comfortable" })}>舒适</button><button className={preferences.density === "compact" ? "active" : ""} aria-pressed={preferences.density === "compact"} onClick={() => onPreferencesChange({ density: "compact" })}>紧凑</button></div></div>
      <label className="desktop-setting-switch"><div><strong>减少界面动效</strong><span>关闭状态脉冲和非必要过渡，适合长时间阅卷；也会自动跟随 Windows 的减少动态效果设置。</span></div><input type="checkbox" checked={preferences.reduceMotion} onChange={(event) => onPreferencesChange({ reduceMotion: event.target.checked })} /><i /></label>
      <div className="prism-preview-card" data-material={preferences.materialMode} data-motion={preferences.motionIntensity}><div className="prism-preview-sheen" /><div><span>实时预览</span><strong>晶透工作台 · Prism Mica</strong><p>页面内容保持近乎不透明，导航与浮层保留适度材质层次。</p></div><div className="prism-preview-actions"><i /><i /><i /></div></div>
    </section>
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>工作区</span><h2>启动与任务信息</h2></div></div>
      <label className="desktop-setting-switch"><div><strong>显示实时任务消息</strong><span>在当前批改页面顶部展示最近四条流水线状态。</span></div><input type="checkbox" checked={preferences.showLiveMessages} onChange={(event) => onPreferencesChange({ showLiveMessages: event.target.checked })} /><i /></label>
      <label className="desktop-setting-switch"><div><strong>启动时打开默认阅卷网站</strong><span>关闭后保留嵌入式浏览器当前状态，只有手动操作才会导航。</span></div><input type="checkbox" checked={preferences.autoOpenStartUrl} onChange={(event) => onPreferencesChange({ autoOpenStartUrl: event.target.checked })} /><i /></label>
      <div className="desktop-setting-block vertical"><div className="desktop-setting-copy"><strong>默认阅卷网站</strong><span>用于主页按钮和启用自动打开时的启动地址。</span></div><div className="desktop-form-grid"><label className="wide"><span>启动地址</span><input value={startUrl} onChange={(event) => setStartUrl(event.target.value)} /></label></div><div className="desktop-form-actions"><button className="desktop-save-button" onClick={save}>{saved ? <Check size={15} /> : <Save size={15} />}{saved ? "已保存" : "保存地址"}</button><button className="desktop-secondary-action" onClick={() => void getHost()?.navigateBrowser(startUrl)}><Globe2 size={14} />立即打开</button></div></div>
    </section>
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>网页插件</span><h2>浮动控制器</h2></div><span className="desktop-status-label locked">跟随全局配色</span></div>
      <label className="desktop-setting-switch"><div><strong>在阅卷网页中显示插件</strong><span>隐藏后仍可从工作台控制批改流程。</span></div><input type="checkbox" checked={preferences.visible} onChange={(event) => onPreferencesChange({ visible: event.target.checked })} /><i /></label>
      <label className="desktop-setting-switch"><div><strong>插件默认折叠</strong><span>只保留标题栏，减少对答卷和评分区的遮挡。</span></div><input type="checkbox" checked={preferences.defaultCollapsed} onChange={(event) => onPreferencesChange({ defaultCollapsed: event.target.checked })} /><i /></label>
      <div className="desktop-setting-block"><div className="desktop-setting-copy"><strong>插件位置</strong><span>固定在网页底部，选择避开智学网操作区的一侧。</span></div><div className="desktop-segment-control" role="group" aria-label="网页插件位置"><button className={preferences.position === "bottom-left" ? "active" : ""} aria-pressed={preferences.position === "bottom-left"} onClick={() => onPreferencesChange({ position: "bottom-left" })}>左下角</button><button className={preferences.position === "bottom-right" ? "active" : ""} aria-pressed={preferences.position === "bottom-right"} onClick={() => onPreferencesChange({ position: "bottom-right" })}>右下角</button></div></div>
      <label className="desktop-setting-switch"><div><strong>开始批改前再次确认</strong><span>同时作用于工作台和网页插件，防止误触后提交真实分数。</span></div><input type="checkbox" checked={preferences.confirmBeforeStart} onChange={(event) => onPreferencesChange({ confirmBeforeStart: event.target.checked })} /><i /></label>
    </section>
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>异常策略</span><h2>流水线保护</h2></div></div><div className="desktop-policy-list"><div><span>提交前失败</span><strong>记录原因；连续 3 次失败后自动暂停</strong></div><div><span>写分或提交后失败</span><strong>停留在当前答卷，等待人工核对</strong></div><div><span>本地数据</span><strong>模板、历史、日志与模型配置保存在本机</strong></div><div><span>本地服务</span><strong>仅监听回环地址，并在启动时分配受保护端口</strong></div></div></section>
    <section className="desktop-section"><div className="desktop-section-heading"><div><span>安全边界</span><h2>进程隔离</h2></div></div><div className="desktop-callout"><ShieldCheck size={17} /><div><strong>目标网页仅运行站点插件</strong><p>模型 URL、API Key、评分模板和历史数据均由本地主进程与 API 服务持有，不注入真实阅卷网站的 JavaScript 上下文。</p></div></div></section>
  </div>;
}

function DesktopLoading({ label }: { label: string }) {
  return <div className="desktop-page-body"><div className="desktop-loading"><LoaderCircle className="spin" size={20} /><span>{label}</span></div></div>;
}

function DesktopPage({ route, browser, summary, template, preferences, onPreferencesChange, onBindTemplate, onEnterTest }: {
  route: DesktopRoute;
  browser: EmbeddedBrowserState;
  summary: PipelineSummary;
  template: TemplateContext | null;
  preferences: DesktopPreferences;
  onPreferencesChange: (patch: Partial<DesktopPreferences>) => void;
  onBindTemplate: (templateId: string) => Promise<TemplateContext>;
  onEnterTest: () => Promise<unknown>;
}) {
  switch (route.id) {
    case "dashboard": return <DashboardPage browser={browser} summary={summary} template={template} onEnterTest={onEnterTest} />;
    case "jobs": return <JobsPage template={template} browser={browser} onEnterTest={onEnterTest} />;
    case "job": return route.parameter === "new" ? <GuidedSetupPage browser={browser} /> : <ActiveJobPage browser={browser} summary={summary} template={template} preferences={preferences} />;
    case "templates": return <TemplatesPage template={template} onBindTemplate={onBindTemplate} />;
    case "template": return route.parameter === "new" ? <TemplateCreatePage /> : <TemplateDetailPage templateId={route.parameter} />;
    case "history": return <HistoryPage />;
    case "record": return <RecordPage recordId={route.parameter} />;
    case "logs": return <LogsPage />;
    case "models": return <ModelsPage />;
    case "browser-debug": return <BrowserDebugPage browser={browser} />;
    case "plugins-debug": return <PluginsDebugPage browser={browser} />;
    case "settings": return <SettingsPage preferences={preferences} onPreferencesChange={onPreferencesChange} />;
  }
}

export default function DesktopApp() {
  const [route, setRoute] = useState(() => parseDesktopRoute(window.location.pathname));
  const [preferences, setPreferences] = useState<DesktopPreferences>(readDesktopPreferences);
  const startupNavigationStarted = useRef(false);
  const systemReducedMotion = useSystemReducedMotion();
  const { browser, summary } = useElectronState();
  const { template, error: templateError, bind: bindTemplate, enterTest } = useTemplateContext();
  useEffect(() => {
    if (startupNavigationStarted.current) return;
    startupNavigationStarted.current = true;
    const startUrl = readStartUrl(localStorage);
    const host = getHost();
    if (!preferences.autoOpenStartUrl || !host) return;
    void host.getBrowserState().then((state) => {
      if (state.url && state.url !== "about:blank" && state.url === startUrl) return state;
      return host.navigateBrowser(startUrl);
    });
  }, [preferences.autoOpenStartUrl]);
  useEffect(() => {
    const pluginPreferences: PluginUiPreferences = {
      accent: preferences.accent,
      visible: preferences.visible,
      defaultCollapsed: preferences.defaultCollapsed,
      position: preferences.position,
      confirmBeforeStart: preferences.confirmBeforeStart,
      material: preferences.materialMode,
      motionIntensity: preferences.motionIntensity,
      reduceMotion: preferences.reduceMotion || systemReducedMotion,
      fontFamily: preferences.fontFamily,
      monoFontFamily: preferences.monoFontFamily,
      fontWeight: preferences.fontWeight,
      fontScale: preferences.fontScale,
      lineHeight: preferences.lineHeight,
      letterSpacing: preferences.letterSpacing
    };
    void getHost()?.setPluginPreferences(pluginPreferences);
  }, [preferences.accent, preferences.visible, preferences.defaultCollapsed, preferences.position, preferences.confirmBeforeStart, preferences.materialMode, preferences.motionIntensity, preferences.reduceMotion, preferences.fontFamily, preferences.monoFontFamily, preferences.fontWeight, preferences.fontScale, preferences.lineHeight, preferences.letterSpacing, systemReducedMotion]);
  useEffect(() => {
    document.documentElement.dataset.reduceMotion = preferences.reduceMotion || systemReducedMotion || preferences.motionIntensity === "off"
      ? "true"
      : "false";
    return () => {
      delete document.documentElement.dataset.reduceMotion;
    };
  }, [preferences.reduceMotion, preferences.motionIntensity, systemReducedMotion]);
  useEffect(() => {
    const host = getHost();
    if (!host) return;
    void host.setWindowMaterial(preferences.materialMode).catch(() => undefined);
  }, [preferences.materialMode]);
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      runRouteTransition(() => setRoute(parseDesktopRoute(window.location.pathname)), directionFromPopState(event));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = new URL(anchor.href, window.location.href);
      if (target.origin !== window.location.origin || target.searchParams.get("electron") !== "1") return;
      event.preventDefault();
      pushRoute(`${target.pathname}?electron=1`);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);
  const changePreferences = useCallback((patch: Partial<DesktopPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      localStorage.setItem("hengzhun.desktopPreferences", JSON.stringify(next));
      localStorage.setItem("hengzhun.desktopFontSize", next.fontSize);
      return next;
    });
  }, []);
  const browserPage = route.id === "job" || route.id === "browser-debug";
  const motionFactor = preferences.motionIntensity === "off" ? 0 : preferences.motionIntensity === "lively" ? 0.85 : 1;
  const prismStyle = {
    "--prism-surface-opacity": String(preferences.surfaceOpacity / 100),
    "--prism-blur": `${preferences.blurStrength}px`,
    "--prism-motion-factor": String(motionFactor),
    "--desktop-font-family": fontFamilyStacks[preferences.fontFamily],
    "--desktop-mono-font-family": monoFontStacks[preferences.monoFontFamily],
    "--desktop-font-weight": String(preferences.fontWeight),
    "--desktop-font-scale": String(preferences.fontScale),
    "--desktop-line-height": String(preferences.lineHeight),
    "--desktop-letter-spacing": `${preferences.letterSpacing}em`
  } as CSSProperties;
  const reduceMotion = preferences.reduceMotion || systemReducedMotion || preferences.motionIntensity === "off";
  return <div className={browserPage ? "desktop-shell browser-active" : "desktop-shell"} data-font-size={preferences.fontSize} data-density={preferences.density} data-accent={preferences.accent} data-material={preferences.materialMode} data-motion={preferences.motionIntensity} data-reduce-motion={reduceMotion ? "true" : "false"} style={prismStyle}>
    <DesktopSidebar route={route} browser={browser} />
    <main className="desktop-main">
      <PageHeader route={route} browser={browser} />
      {templateError && <div className="desktop-global-error"><AlertTriangle size={15} />评分模板读取失败：{templateError}</div>}
      <div className="desktop-route-stage">
        <DesktopPage route={route} browser={browser} summary={summary} template={template} preferences={preferences} onPreferencesChange={changePreferences} onBindTemplate={bindTemplate} onEnterTest={enterTest} />
      </div>
    </main>
  </div>;
}
