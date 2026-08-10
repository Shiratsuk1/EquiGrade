import { app, BrowserWindow, ipcMain } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BrowserAction,
  BrowserSurfaceBounds,
  ModelConnectionTestResult,
  ModelSetupStatus,
  PipelineControl,
  PipelineDryRunOptions,
  PipelineTaskSelection,
  PipelineTemplateContext,
  PluginDiagnosticRequest,
  PluginResponse,
  PluginStatus,
  PluginUiPreferences,
  WindowMaterial
} from "../shared/electron.js";
import { EmbeddedBrowserSession } from "./browserSession.js";
import { configureStableUserData } from "./userData.js";

const userDataConfiguration = configureStableUserData(app);

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const isDevelopment = !app.isPackaged;
const devPort = Number(process.env.VITE_PORT ?? 5173);
let apiPort = Number(process.env.PORT ?? (isDevelopment ? 8788 : 0));
const localApiToken = process.env.HENGZHUN_API_TOKEN?.trim() || randomBytes(32).toString("hex");
const nativeWindowsMaterialSupported = process.platform === "win32"
  && Number(process.getSystemVersion().split(".").at(-1)) >= 22621;
const recentPipelineEvents: Array<Record<string, unknown>> = [];

let serverProcess: ChildProcess | null = null;
let pipelineLogQueue: Promise<void> = Promise.resolve();
let hostWindow: BrowserWindow | null = null;
let browserSession: EmbeddedBrowserSession | null = null;
let appQuitPending = false;
let allowAppQuit = false;
let activePipelineTask: {
  mode: PipelineTaskSelection["mode"];
  targetUrl: string;
  context: PipelineTemplateContext;
} | null = null;

function localBaseUrl() {
  return isDevelopment ? `http://127.0.0.1:${devPort}` : `http://127.0.0.1:${apiPort}`;
}

function requireBrowserSession() {
  if (!browserSession) throw new Error("嵌入式浏览器尚未就绪");
  return browserSession;
}

async function flushAllBrowserStorage() {
  const operations: Promise<void>[] = [];
  if (browserSession) operations.push(browserSession.flushStorage());
  if (hostWindow && !hostWindow.isDestroyed() && !hostWindow.webContents.isDestroyed()) {
    const hostSession = hostWindow.webContents.session;
    hostSession.flushStorageData();
    operations.push(hostSession.cookies.flushStore());
  }
  await Promise.all(operations);
}

async function apiJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("X-Hengzhun-Token", localApiToken);
  const response = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, { ...init, headers });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `本地服务返回 ${response.status}`);
  return body as T;
}

function isTrustedHostUrl(value: string) {
  try {
    return new URL(value).origin === new URL(localBaseUrl()).origin;
  } catch {
    return false;
  }
}

function isTrustedHostSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  return Boolean(
    hostWindow
    && event.sender === hostWindow.webContents
    && event.senderFrame === hostWindow.webContents.mainFrame
    && isTrustedHostUrl(event.senderFrame.url)
  );
}

function requireHostSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (!isTrustedHostSender(event)) throw new Error("非可信工作台页面不允许执行该操作");
}

async function loadPipelineTemplate(selection: PipelineTaskSelection): Promise<PipelineTemplateContext> {
  if (selection.mode === "test") {
    return apiJson<PipelineTemplateContext>("/api/pipeline/fixture");
  }
  const templateId = selection.templateId?.trim();
  if (!templateId) throw new Error("真实批改任务未指定评分模板");
  const detail = await apiJson<{
    id: string;
    title: string;
    builtIn?: boolean;
    questionText: string;
    referenceText: string;
    rubric: PipelineTemplateContext["rubric"];
  }>(`/api/templates/${encodeURIComponent(templateId)}`);
  if (detail.builtIn) throw new Error("内置测试模板只能从流水线测试入口使用");
  if (detail.rubric.status !== "locked") throw new Error("评分模板尚未锁定");
  return {
    templateId: detail.id,
    title: detail.title,
    locked: true,
    questionText: detail.questionText,
    referenceText: detail.referenceText,
    rubric: detail.rubric
  };
}

function recordPipelineEvent(payload: Record<string, unknown>) {
  const entry = { timestamp: new Date().toISOString(), ...payload };
  recentPipelineEvents.push(entry);
  if (recentPipelineEvents.length > 300) recentPipelineEvents.splice(0, recentPipelineEvents.length - 300);
  const filePath = path.join(app.getPath("userData"), "pipeline-events.jsonl");
  pipelineLogQueue = pipelineLogQueue.then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }).catch(() => undefined);
  if (hostWindow && !hostWindow.isDestroyed() && !hostWindow.webContents.isDestroyed()) {
    hostWindow.webContents.send("pipeline:event", entry);
  }
}

async function startPackagedServer() {
  if (isDevelopment) return;
  const packagedRoot = path.join(process.resourcesPath, "app.asar.unpacked");
  const entry = path.join(packagedRoot, "dist-server/server/index.js");
  if (!existsSync(entry)) throw new Error("打包版缺少本地 API 服务入口");
  const child = fork(entry, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(apiPort),
      APP_DIST_DIR: path.join(packagedRoot, "dist"),
      APP_DATA_DIR: app.getPath("userData"),
      HENGZHUN_API_TOKEN: localApiToken
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"]
  });
  serverProcess = child;
  apiPort = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("本地 API 服务启动超时")), 12_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`本地 API 服务提前退出：${code ?? "unknown"}`));
    });
    child.on("message", (message) => {
      const payload = message as { type?: string; port?: number };
      if (payload.type !== "hengzhun-api-listening" || !Number.isInteger(payload.port) || Number(payload.port) <= 0) return;
      clearTimeout(timeout);
      resolve(Number(payload.port));
    });
  });
}

async function waitForHostServer() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${localBaseUrl()}/api/health`);
      if (response.ok) return;
      lastError = new Error(`工作台服务返回 ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw lastError instanceof Error ? lastError : new Error("工作台服务启动超时");
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#f5f8f8",
    backgroundMaterial: nativeWindowsMaterialSupported ? "mica" : "none",
    title: "衡准自动改卷工作台",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      additionalArguments: [`--hengzhun-api-token=${localApiToken}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  hostWindow = window;
  browserSession = new EmbeddedBrowserSession({
    window,
    preloadPath: path.join(currentDirectory, "targetPreload.cjs"),
    homeUrl: ""
  });
  browserSession.view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  let windowClosePending = false;
  let allowWindowClose = false;
  window.on("close", (event) => {
    if (allowAppQuit || allowWindowClose) return;
    event.preventDefault();
    if (windowClosePending) return;
    windowClosePending = true;
    void flushAllBrowserStorage().catch((error: unknown) => {
      recordPipelineEvent({
        type: "browser_storage_flush_failed",
        reason: error instanceof Error ? error.message : "浏览器登录状态写盘失败"
      });
    }).finally(() => {
      allowWindowClose = true;
      if (!window.isDestroyed()) window.close();
    });
  });

  window.on("closed", () => {
    hostWindow = null;
    browserSession = null;
  });
  window.on("resize", () => {
    if (!window.webContents.isDestroyed()) window.webContents.send("browser:request-surface");
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedHostUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedHostUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  void (async () => {
    await window.webContents.session.cookies.set({
      url: localBaseUrl(),
      name: "hengzhun_api_token",
      value: localApiToken,
      httpOnly: true,
      sameSite: "strict",
      secure: false
    });
    await window.loadURL(`${localBaseUrl()}/?electron=1`);
  })().catch((error: unknown) => {
    recordPipelineEvent({
      type: "host_window_load_failed",
      reason: error instanceof Error ? error.message : "工作台加载失败"
    });
  });
  void browserSession.initialize().then((health) => {
    recordPipelineEvent({
      type: "browser_session_restored",
      encryptionAvailable: health.encryptionAvailable,
      vaultCookieCount: health.vaultCookieCount,
      restoredCookieCount: health.restoredCookieCount,
      liveZhixueCookieCount: health.liveZhixueCookieCount,
      persistentCookieCount: health.persistentCookieCount,
      sessionCookieCount: health.sessionCookieCount,
      cookieNames: health.cookieNames,
      lastTargetUrl: health.lastTargetUrl,
      persistenceError: health.persistenceError
    });
  }).catch((error: unknown) => {
    recordPipelineEvent({
      type: "browser_load_failed",
      reason: error instanceof Error ? error.message : "目标网页加载失败"
    });
  });
}

ipcMain.handle("pipeline:sha256", async (event, payload: { bytes?: number[] }) => {
  const session = requireBrowserSession();
  if (event.sender !== session.view.webContents) throw new Error("非目标网页进程不允许计算答卷哈希");
  if (!Array.isArray(payload.bytes) || payload.bytes.length === 0) throw new Error("没有收到可计算哈希的图片数据");
  return createHash("sha256").update(Buffer.from(payload.bytes)).digest("hex");
});

ipcMain.handle("pipeline:read-target-image", async (event, payload: { url?: string; documentUrl?: string }) => {
  const session = requireBrowserSession();
  if (event.sender !== session.view.webContents) throw new Error("非目标网页进程不允许读取答卷图片");
  if (typeof payload?.url !== "string" || typeof payload?.documentUrl !== "string") {
    throw new Error("答卷图片请求参数无效");
  }
  return session.readTargetImage(payload.url, payload.documentUrl);
});

ipcMain.handle("pipeline:recent-events", (event) => {
  requireHostSender(event);
  return recentPipelineEvents.slice(-100);
});

ipcMain.handle("pipeline:model-setup-status", async (event): Promise<ModelSetupStatus> => {
  requireHostSender(event);
  const config = await apiJson<null | {
    name: string;
    baseUrl: string;
    visionModel: string;
    enabled: boolean;
    hasApiKey: boolean;
    updatedAt: string;
  }>("/api/model-config");
  if (!config) return { configured: false, enabled: false, hasApiKey: false };
  return {
    configured: true,
    enabled: config.enabled,
    hasApiKey: config.hasApiKey,
    name: config.name,
    baseUrl: config.baseUrl,
    visionModel: config.visionModel,
    updatedAt: config.updatedAt
  };
});

ipcMain.handle("pipeline:test-model", async (event): Promise<ModelConnectionTestResult> => {
  requireHostSender(event);
  const result = await apiJson<{ model: string; durationMs: number }>("/api/model-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "vision" })
  });
  return {
    ok: true,
    model: result.model,
    durationMs: result.durationMs,
    message: `视觉模型 ${result.model} 连接成功`
  };
});

ipcMain.handle("pipeline:inspect-target", async (event) => {
  requireHostSender(event);
  return requireBrowserSession().inspectTargetPage();
});

ipcMain.handle("pipeline:plugin-diagnostic", async (event, request: PluginDiagnosticRequest) => {
  requireHostSender(event);
  const result = await requireBrowserSession().runPluginDiagnostic(request);
  recordPipelineEvent({
    type: "plugin_diagnostic_completed",
    action: result.action,
    pageKey: result.pageKey,
    previousPageKey: result.previousPageKey,
    score: result.score,
    fieldId: result.fieldId,
    savedImage: result.savedImage
  });
  return result;
});

ipcMain.handle("pipeline:dry-run", async (event, options: PipelineDryRunOptions) => {
  requireHostSender(event);
  if (!activePipelineTask?.context.locked) throw new Error("请先选择并锁定真实评分模板");
  return requireBrowserSession().dryRunCurrentAnswer({ verifyWrite: Boolean(options?.verifyWrite) });
});

ipcMain.handle("pipeline:select-task", async (event, selection: PipelineTaskSelection) => {
  requireHostSender(event);
  if (!selection || (selection.mode !== "production" && selection.mode !== "test")) {
    throw new Error("批改任务类型无效");
  }
  const context = await loadPipelineTemplate(selection);
  const targetUrl = selection.mode === "test"
    ? `${localBaseUrl()}/mock-grading?embedded=1&scenario=complex`
    : selection.targetUrl?.trim();
  if (!targetUrl) throw new Error("真实批改任务未指定阅卷页面");
  const session = requireBrowserSession();
  const activePhases = new Set(["preflight", "extracting", "grading", "writing_score", "submitting", "verifying", "navigating_next"]);
  if (activePhases.has(session.getState().plugin.phase)) {
    throw new Error("流水线正在处理答卷，请先暂停后再更换评分标准");
  }
  const currentUrl = session.getState().url;
  await session.setHomeUrl(targetUrl, currentUrl !== targetUrl);
  activePipelineTask = { mode: selection.mode, targetUrl, context };
  recordPipelineEvent({
    type: "pipeline_template_bound",
    mode: selection.mode,
    templateId: context.templateId,
    templateTitle: context.title,
    totalScore: context.rubric.totalScore,
    targetUrl
  });
  return context;
});

ipcMain.handle("pipeline:template-context", (event) => {
  requireHostSender(event);
  return activePipelineTask?.context ?? null;
});

ipcMain.handle("pipeline:grade-image", async (event, payload: {
  pageKey: string;
  imageHash: string;
  sourcePageKey?: string;
  imageDataUrl: string;
  studentId?: string;
  fileName?: string;
}) => {
  const session = requireBrowserSession();
  if (event.sender !== session.view.webContents) throw new Error("非目标网页进程不允许提交答卷图像");
  const task = activePipelineTask;
  if (!task?.context.locked) throw new Error("请先从批改任务或流水线测试入口选择任务");
  const imageResponse = await fetch(payload.imageDataUrl);
  if (!imageResponse.ok) throw new Error("无法读取网页答卷图片");
  const blob = await imageResponse.blob();
  const form = new FormData();
  form.append("templateId", task.context.templateId);
  form.append("pageKey", payload.pageKey);
  form.append("imageHash", payload.imageHash);
  if (payload.sourcePageKey) form.append("sourcePageKey", payload.sourcePageKey);
  if (payload.studentId) form.append("studentId", payload.studentId);
  if (payload.fileName) form.append("fileName", payload.fileName);
  form.append("image", blob, payload.fileName || `${payload.imageHash}.png`);
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/pipeline/grade`, {
    method: "POST",
    headers: { "X-Hengzhun-Token": localApiToken },
    body: form
  });
  const body = await response.json().catch(() => ({})) as { error?: string; [key: string]: unknown };
  if (!response.ok) throw new Error(body.error || `批改服务返回 ${response.status}`);
  return body;
});

ipcMain.on("pipeline:event", (event, payload: Record<string, unknown>) => {
  if (!browserSession || event.sender !== browserSession.view.webContents) return;
  recordPipelineEvent(payload);
});

ipcMain.on("plugin:status", (event, payload: PluginStatus) => {
  if (!browserSession || event.sender !== browserSession.view.webContents) return;
  requireBrowserSession().updatePlugin(payload);
});

ipcMain.on("plugin:response", (event, payload: PluginResponse) => {
  if (!browserSession || event.sender !== browserSession.view.webContents) return;
  browserSession.resolvePluginResponse(payload);
});

ipcMain.handle("browser:get-state", (event) => {
  requireHostSender(event);
  return requireBrowserSession().getState();
});
ipcMain.handle("browser:session-health", (event) => {
  requireHostSender(event);
  return requireBrowserSession().getSessionHealth();
});
ipcMain.handle("browser:navigate", (event, url: string) => {
  requireHostSender(event);
  return requireBrowserSession().navigate(url);
});
ipcMain.handle("browser:action", (event, action: BrowserAction) => {
  requireHostSender(event);
  return requireBrowserSession().action(action);
});
ipcMain.handle("plugin:set-preferences", (event, preferences: PluginUiPreferences) => {
  requireHostSender(event);
  const accents = new Set(["teal", "blue", "green", "graphite"]);
  const positions = new Set(["bottom-right", "bottom-left"]);
  const materials = new Set<WindowMaterial>(["solid", "mica", "acrylic"]);
  const motionIntensities = new Set(["off", "comfortable", "lively"]);
  requireBrowserSession().setPluginPreferences({
    accent: accents.has(preferences?.accent) ? preferences.accent : "teal",
    visible: preferences?.visible !== false,
    defaultCollapsed: Boolean(preferences?.defaultCollapsed),
    position: positions.has(preferences?.position) ? preferences.position : "bottom-right",
    confirmBeforeStart: preferences?.confirmBeforeStart !== false,
    material: materials.has(preferences?.material as WindowMaterial) ? preferences.material as WindowMaterial : "mica",
    motionIntensity: motionIntensities.has(preferences?.motionIntensity as string) ? preferences.motionIntensity : "comfortable",
    reduceMotion: preferences?.reduceMotion === true
  });
});
ipcMain.handle("window:set-material", (event, material: WindowMaterial) => {
  requireHostSender(event);
  if (!nativeWindowsMaterialSupported || !hostWindow || hostWindow.isDestroyed()) return;
  const materialMap: Record<WindowMaterial, "none" | "mica" | "acrylic"> = {
    solid: "none",
    mica: "mica",
    acrylic: "acrylic"
  };
  const safeMaterial = materialMap[material] ?? "mica";
  try {
    hostWindow.setBackgroundMaterial(safeMaterial);
  } catch {
    hostWindow.setBackgroundMaterial("none");
  }
});
ipcMain.handle("pipeline:control", (event, control: PipelineControl) => {
  requireHostSender(event);
  if (control === "start" && !activePipelineTask) throw new Error("请先选择真实批改任务或流水线测试任务");
  return requireBrowserSession().controlPipeline(control);
});

ipcMain.on("browser:set-surface", (event, bounds: BrowserSurfaceBounds) => {
  if (!isTrustedHostSender(event)) return;
  requireBrowserSession().setSurface(bounds);
});

ipcMain.on("browser:set-visible", (event, visible: boolean) => {
  if (!isTrustedHostSender(event)) return;
  requireBrowserSession().setVisible(Boolean(visible));
});

app.whenReady().then(async () => {
  recordPipelineEvent({
    type: "browser_user_data_ready",
    userDataPath: userDataConfiguration.path,
    migratedFrom: userDataConfiguration.migratedFrom,
    recoveredCookiesFrom: userDataConfiguration.recoveredCookiesFrom
  });
  await startPackagedServer();
  await waitForHostServer();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  console.error("[electron] failed to start trusted local services", error);
  app.quit();
});

app.on("before-quit", (event) => {
  if (allowAppQuit || !browserSession) return;
  event.preventDefault();
  if (appQuitPending) return;
  appQuitPending = true;
  void flushAllBrowserStorage().catch((error: unknown) => {
    recordPipelineEvent({
      type: "browser_storage_flush_failed",
      reason: error instanceof Error ? error.message : "浏览器登录状态写盘失败"
    });
  }).finally(() => {
    allowAppQuit = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  if (process.platform !== "darwin") app.quit();
});
