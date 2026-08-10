import type { Rubric } from "./types.js";

export type BrowserSecurityState = "local" | "secure" | "insecure" | "unknown";

export type PluginPhase =
  | "disconnected"
  | "handshaking"
  | "idle"
  | "preflight"
  | "ready"
  | "extracting"
  | "grading"
  | "writing_score"
  | "submitting"
  | "verifying"
  | "navigating_next"
  | "completed"
  | "skipped"
  | "paused"
  | "failed";

export interface PluginCapabilities {
  answerImage: boolean;
  scoreInput: boolean;
  submit: boolean;
  next: boolean;
}

export interface PluginStatus {
  connected: boolean;
  adapterId: string;
  adapterName: string;
  adapterVersion: string;
  phase: PluginPhase;
  message: string;
  pageKey?: string;
  consecutiveFailures: number;
  lastScore?: number;
  maxScore?: number;
  capabilities: PluginCapabilities;
  updatedAt: string;
}

export interface EmbeddedBrowserState {
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  security: BrowserSecurityState;
  visible: boolean;
  crashed: boolean;
  plugin: PluginStatus;
}

export interface BrowserSessionHealth {
  userDataPath: string;
  partition: string;
  encryptionAvailable: boolean;
  vaultCookieCount: number;
  restoredCookieCount: number;
  liveZhixueCookieCount: number;
  persistentCookieCount: number;
  sessionCookieCount: number;
  cookieNames: string[];
  lastTargetUrl?: string;
  persistenceError?: string;
}

export interface BrowserSurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserAction =
  | "back"
  | "forward"
  | "reload"
  | "stop"
  | "home"
  | "open_devtools"
  | "close_devtools"
  | "reload_plugin"
  | "capture_screenshot";

export type PipelineControl = "preflight" | "start" | "pause" | "stop" | "skip";

export type PluginAccent = "teal" | "blue" | "green" | "graphite";
export type PluginPosition = "bottom-right" | "bottom-left";
export type WindowMaterial = "solid" | "mica" | "acrylic";
export type MotionIntensity = "off" | "comfortable" | "lively";
export type UiFontFamily = "system" | "inter" | "noto-sans-sc" | "source-han-sans" | "microsoft-yahei";
export type UiMonoFontFamily = "cascadia" | "consolas" | "system";

export interface PluginUiPreferences {
  accent: PluginAccent;
  visible: boolean;
  defaultCollapsed: boolean;
  position: PluginPosition;
  confirmBeforeStart: boolean;
  material?: WindowMaterial;
  motionIntensity?: MotionIntensity;
  reduceMotion?: boolean;
  fontFamily?: UiFontFamily;
  monoFontFamily?: UiMonoFontFamily;
  fontWeight?: number;
  fontScale?: number;
  lineHeight?: number;
  letterSpacing?: number;
}

export interface PipelineTaskSelection {
  mode: "production" | "test";
  templateId?: string;
  targetUrl?: string;
}

export interface ModelSetupStatus {
  configured: boolean;
  enabled: boolean;
  hasApiKey: boolean;
  name?: string;
  baseUrl?: string;
  visionModel?: string;
  updatedAt?: string;
}

export interface ModelConnectionTestResult {
  ok: boolean;
  model?: string;
  durationMs?: number;
  message: string;
}

export interface TargetScoreField {
  id: string;
  label: string;
  maxScore?: number;
}

export interface TargetPageInspection {
  ok: boolean;
  issues: string[];
  adapterId: string;
  adapterName: string;
  pageKey?: string;
  pageTitle: string;
  questionLabel?: string;
  fullScore?: number;
  scoreFields: TargetScoreField[];
  autoSubmit?: boolean;
  batchComplete: boolean;
  progress?: {
    completed: number;
    total: number;
  };
  capabilities: PluginCapabilities;
}

export type PipelineScoreAlignmentSource = "total" | "subquestions" | "points";

export interface PipelineScoreAlignmentRow {
  targetId: string;
  targetLabel: string;
  targetMaxScore?: number;
  sourceId?: string;
  sourceLabel?: string;
  sourceMaxScore?: number;
  matched: boolean;
}

export interface PipelineScoreAlignment {
  ok: boolean;
  source?: PipelineScoreAlignmentSource;
  rows: PipelineScoreAlignmentRow[];
  issues: string[];
}

export interface PipelineWriteTestResult {
  supported: boolean;
  rolledBack: boolean;
  fieldValues: Array<{
    id: string;
    value: number;
    maxScore?: number;
  }>;
  total?: number;
  message: string;
}

export interface PipelineDryRunOptions {
  verifyWrite: boolean;
}

export interface PipelineDryRunResult {
  pageKey: string;
  sourcePageKey?: string;
  imageHash: string;
  imageBytes: number;
  imageMimeType: string;
  imageSource: string;
  score: number;
  maxScore: number;
  status: string;
  requiresReview: boolean;
  segments: Array<{
    id: string;
    title: string;
    score: number;
    maxScore: number;
    points: Array<{
      id: string;
      score: number;
      maxScore: number;
    }>;
  }>;
  writeTest?: PipelineWriteTestResult;
}

export type PluginDiagnosticAction =
  | "extract-image"
  | "previous-page"
  | "next-page"
  | "write-score"
  | "clear-score";

export interface PluginDiagnosticRequest {
  action: PluginDiagnosticAction;
  score?: number;
}

export interface PluginDiagnosticResult {
  action: PluginDiagnosticAction;
  message: string;
  pageKey?: string;
  previousPageKey?: string;
  score?: number;
  fieldId?: string;
  savedImage?: {
    path: string;
    mimeType: string;
    bytes: number;
    sha256: string;
    source: string;
  };
}

export interface PluginDiagnosticTargetResult extends Omit<PluginDiagnosticResult, "savedImage"> {
  imageDataUrl?: string;
  imageMimeType?: string;
  imageBytes?: number;
  imageHash?: string;
  imageSource?: string;
}

export type PluginRequest =
  | { requestId: string; kind: "inspect-setup" }
  | { requestId: string; kind: "dry-run"; options: PipelineDryRunOptions }
  | { requestId: string; kind: "plugin-diagnostic"; diagnostic: PluginDiagnosticRequest };

export interface PluginResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface PipelineTemplateContext {
  templateId: string;
  title: string;
  locked: boolean;
  questionText: string;
  referenceText: string;
  rubric: Rubric;
}

export interface PipelineEvent extends Record<string, unknown> {
  type: string;
  timestamp?: string;
  phase?: PluginPhase;
  pageKey?: string;
  sourcePageKey?: string;
  reason?: string;
  message?: string;
  score?: number;
  maxScore?: number;
  segments?: Array<{
    id: string;
    title: string;
    score: number;
    maxScore: number;
    points: Array<{ id: string; score: number; maxScore: number }>;
  }>;
  consecutiveFailures?: number;
}

export interface BrowserActionResult {
  ok: boolean;
  path?: string;
  message?: string;
}

export interface ElectronHostBridge {
  isElectron: true;
  version: string;
  getModelSetupStatus(): Promise<ModelSetupStatus>;
  testModelConnection(): Promise<ModelConnectionTestResult>;
  inspectTargetPage(): Promise<TargetPageInspection>;
  dryRunCurrentAnswer(options: PipelineDryRunOptions): Promise<PipelineDryRunResult>;
  runPluginDiagnostic(request: PluginDiagnosticRequest): Promise<PluginDiagnosticResult>;
  selectPipelineTask(selection: PipelineTaskSelection): Promise<PipelineTemplateContext>;
  getTemplateContext(): Promise<PipelineTemplateContext | null>;
  getPipelineEvents(): Promise<PipelineEvent[]>;
  onPipelineEvent(callback: (event: PipelineEvent) => void): () => void;
  getBrowserState(): Promise<EmbeddedBrowserState>;
  getBrowserSessionHealth(): Promise<BrowserSessionHealth>;
  onBrowserState(callback: (state: EmbeddedBrowserState) => void): () => void;
  onBrowserSurfaceRequest(callback: () => void): () => void;
  navigateBrowser(url: string): Promise<EmbeddedBrowserState>;
  runBrowserAction(action: BrowserAction): Promise<BrowserActionResult>;
  setBrowserSurface(bounds: BrowserSurfaceBounds): void;
  setBrowserVisible(visible: boolean): void;
  setPluginPreferences(preferences: PluginUiPreferences): Promise<void>;
  setWindowMaterial(material: WindowMaterial): Promise<void>;
  controlPipeline(control: PipelineControl): Promise<BrowserActionResult>;
}

export const EMPTY_PLUGIN_STATUS: PluginStatus = {
  connected: false,
  adapterId: "none",
  adapterName: "等待目标页插件",
  adapterVersion: "0.0.0",
  phase: "disconnected",
  message: "尚未连接目标网页",
  consecutiveFailures: 0,
  capabilities: {
    answerImage: false,
    scoreInput: false,
    submit: false,
    next: false
  },
  updatedAt: new Date(0).toISOString()
};
