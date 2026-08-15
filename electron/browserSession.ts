import { app, BrowserWindow, WebContentsView, dialog, safeStorage, type Cookie, type Session } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserSessionHealth,
  BrowserSecurityState,
  BrowserSurfaceBounds,
  EmbeddedBrowserState,
  PipelineControl,
  PipelineDryRunOptions,
  PipelineDryRunResult,
  PluginDiagnosticRequest,
  PluginDiagnosticResult,
  PluginDiagnosticTargetResult,
  PluginRequest,
  PluginResponse,
  PluginStatus,
  PluginUiPreferences,
  TargetPageInspection
} from "../shared/electron.js";
import { EMPTY_PLUGIN_STATUS } from "../shared/electron.js";
import { DEFAULT_START_URL, isLegacyMockStartUrl } from "../shared/startUrl.js";
import { MAX_IMAGE_BYTES } from "../shared/uiConstants.js";
import {
  EncryptedCookieVault,
  selectZhixueCookies,
  TargetNavigationStore,
  toCookieSetDetails,
  type PersistedTargetCookie
} from "./sessionPersistence.js";
import { assertAllowedImageResource } from "./targetImagePolicy.js";

type BrowserSessionOptions = {
  window: BrowserWindow;
  preloadPath: string;
  homeUrl: string;
};

type CdpFrame = {
  id: string;
  url: string;
};

type CdpFrameTree = {
  frame: CdpFrame;
  childFrames?: CdpFrameTree[];
};

const MAX_TARGET_IMAGE_BYTES = MAX_IMAGE_BYTES;
const DEFAULT_PLUGIN_PREFERENCES: PluginUiPreferences = {
  accent: "teal",
  visible: true,
  defaultCollapsed: false,
  position: "bottom-right",
  confirmBeforeStart: true,
  material: "mica",
  motionIntensity: "comfortable",
  reduceMotion: false,
  fontFamily: "noto-sans-sc",
  monoFontFamily: "cascadia",
  fontWeight: 500,
  fontScale: 1.1,
  lineHeight: 1.5,
  letterSpacing: 0
};

function imageExtension(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    case "image/bmp": return "bmp";
    default: return "png";
  }
}

function decodeDiagnosticImage(result: PluginDiagnosticTargetResult) {
  const match = result.imageDataUrl?.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error("插件返回的答卷图像不是有效的 Base64 图片");
  const mimeType = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.byteLength) throw new Error("插件返回的答卷图像为空");
  if (bytes.byteLength > MAX_TARGET_IMAGE_BYTES) throw new Error("答卷图片超过 25 MB 安全上限");
  if (result.imageBytes !== undefined && result.imageBytes !== bytes.byteLength) throw new Error("插件返回的答卷图像大小校验失败");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (result.imageHash && result.imageHash.toLowerCase() !== sha256) throw new Error("插件返回的答卷图像哈希校验失败");
  return { bytes, mimeType, sha256 };
}

function flattenFrameTree(tree: CdpFrameTree, result: CdpFrame[] = []) {
  result.push(tree.frame);
  tree.childFrames?.forEach((child) => flattenFrameTree(child, result));
  return result;
}

function comparableFrameUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function imageMimeType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  throw new Error("目标资源不是受支持的位图图片");
}

function securityForUrl(value: string): BrowserSecurityState {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return "secure";
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.protocol === "file:") return "local";
    if (url.protocol === "http:") return "insecure";
  } catch {
    return "unknown";
  }
  return "unknown";
}

function normalizeNavigationUrl(value: string, baseUrl = "") {
  const input = value.trim();
  if (!input) throw new Error("请输入目标阅卷网站地址");
  if (input.startsWith("/")) {
    try {
      const base = new URL(baseUrl);
      if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error();
      return new URL(input, base.origin).href;
    } catch {
      throw new Error("相对地址只能在已打开的网页中使用");
    }
  }
  const url = /^[a-z][a-z\d+.-]*:/i.test(input)
    ? new URL(input)
    : /^(localhost|127\.0\.0\.1)(:\d+)?(?:\/|$)/i.test(input)
      ? new URL(`http://${input}`)
      : new URL(`https://${input}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("目标地址仅支持 HTTP 或 HTTPS 网页");
  return url.href;
}

export class EmbeddedBrowserSession {
  readonly view: WebContentsView;
  private readonly window: BrowserWindow;
  private readonly targetSession: Session;
  private homeUrl: string;
  private attached = false;
  private visible = false;
  private surface: BrowserSurfaceBounds = { x: 0, y: 0, width: 1, height: 1 };
  private crashed = false;
  private plugin: PluginStatus = { ...EMPTY_PLUGIN_STATUS, capabilities: { ...EMPTY_PLUGIN_STATUS.capabilities } };
  private pluginPreferences: PluginUiPreferences = { ...DEFAULT_PLUGIN_PREFERENCES };
  private debuggerQueue: Promise<void> = Promise.resolve();
  private storageFlushQueue: Promise<void> = Promise.resolve();
  private storageFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private authenticationSnapshotTimer: ReturnType<typeof setTimeout> | undefined;
  private authenticationSnapshotQueue: Promise<void> = Promise.resolve();
  private navigationSaveQueue: Promise<void> = Promise.resolve();
  private readonly cookieVault: EncryptedCookieVault;
  private readonly navigationStore: TargetNavigationStore;
  private restoredCookieCount = 0;
  private vaultCookieCount = 0;
  private persistenceError: string | undefined;
  private initializationPromise: Promise<BrowserSessionHealth> | undefined;
  private pendingNavigation: { url: string; promise: Promise<EmbeddedBrowserState> } | undefined;
  private readonly pluginRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor({ window, preloadPath, homeUrl }: BrowserSessionOptions) {
    this.window = window;
    this.homeUrl = homeUrl;
    this.view = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        partition: "persist:hengzhun-target"
      }
    });
    this.targetSession = this.view.webContents.session;
    const persistenceDirectory = path.join(app.getPath("userData"), "target-session");
    this.cookieVault = new EncryptedCookieVault(path.join(persistenceDirectory, "zhixue-cookies.bin"), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plainText) => safeStorage.encryptString(plainText),
      decrypt: (cipherText) => safeStorage.decryptString(cipherText)
    });
    this.navigationStore = new TargetNavigationStore(path.join(persistenceDirectory, "last-target.json"));
    this.targetSession.cookies.on("changed", () => {
      this.scheduleStorageFlush();
      this.scheduleAuthenticationSnapshot();
    });

    const contents = this.view.webContents;
    const publish = () => this.publishState();
    const resetPluginForNavigation = () => {
      this.updatePlugin({
        phase: "preflight",
        message: "正在重新检查阅卷页面",
        pageKey: undefined,
        capabilities: { ...EMPTY_PLUGIN_STATUS.capabilities }
      });
    };
    contents.on("did-start-loading", resetPluginForNavigation);
    contents.on("did-stop-loading", publish);
    contents.on("did-navigate", (_event, url) => {
      resetPluginForNavigation();
      this.rememberTargetUrl(url);
      publish();
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      resetPluginForNavigation();
      this.rememberTargetUrl(url);
      publish();
      contents.send("pipeline:page-invalidated");
      setTimeout(() => {
        if (!contents.isDestroyed()) contents.send("pipeline:page-ready");
      }, 120);
    });
    contents.on("did-stop-loading", () => this.scheduleStorageFlush(700));
    contents.on("did-navigate", () => this.scheduleStorageFlush(700));
    contents.on("page-title-updated", publish);
    contents.on("render-process-gone", () => {
      this.rejectPluginRequests("目标网页渲染进程已退出");
      this.crashed = true;
      this.updatePlugin({
        connected: false,
        phase: "failed",
        message: "目标网页渲染进程已退出"
      });
    });
    contents.on("did-finish-load", () => {
      this.crashed = false;
      contents.send("pipeline:page-ready");
      contents.send("plugin:preferences", this.pluginPreferences);
      publish();
    });
    contents.on("did-frame-finish-load", (_event, isMainFrame) => {
      if (!isMainFrame) setTimeout(() => contents.send("pipeline:page-ready"), 120);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void contents.loadURL(url);
      return { action: "deny" };
    });
  }

  initialize() {
    if (!this.initializationPromise) this.initializationPromise = this.initializeOnce();
    return this.initializationPromise;
  }

  private async initializeOnce() {
    try {
      const cookies = await this.cookieVault.load();
      this.vaultCookieCount = cookies.length;
      const results = await Promise.allSettled(cookies.map((cookie) => this.targetSession.cookies.set(toCookieSetDetails(cookie))));
      this.restoredCookieCount = results.filter((result) => result.status === "fulfilled").length;
      const lastTargetUrl = await this.navigationStore.load();
      if (lastTargetUrl && isLegacyMockStartUrl(lastTargetUrl)) {
        this.homeUrl = DEFAULT_START_URL;
        await this.navigationStore.save(DEFAULT_START_URL);
      } else if (lastTargetUrl) {
        this.homeUrl = lastTargetUrl;
      }
    } catch (error) {
      this.persistenceError = error instanceof Error ? error.message : "无法恢复目标网页会话";
    }
    if (this.homeUrl) await this.view.webContents.loadURL(this.homeUrl);
    this.scheduleAuthenticationSnapshot(0);
    return this.getSessionHealth();
  }

  async setHomeUrl(value: string, navigate = false) {
    this.homeUrl = normalizeNavigationUrl(value);
    if (navigate) await this.view.webContents.loadURL(this.homeUrl);
    return this.getState();
  }

  getState(): EmbeddedBrowserState {
    const contents = this.view.webContents;
    const history = contents.navigationHistory;
    return {
      url: contents.getURL() || this.homeUrl,
      title: contents.getTitle() || "目标阅卷网站",
      isLoading: contents.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      security: securityForUrl(contents.getURL()),
      visible: this.visible,
      crashed: this.crashed,
      plugin: this.plugin
    };
  }

  setSurface(bounds: BrowserSurfaceBounds) {
    const content = this.window.getContentBounds();
    const x = Math.max(0, Math.min(content.width - 1, Math.round(bounds.x)));
    const y = Math.max(0, Math.min(content.height - 1, Math.round(bounds.y)));
    const width = Math.max(1, Math.min(content.width - x, Math.round(bounds.width)));
    const height = Math.max(1, Math.min(content.height - y, Math.round(bounds.height)));
    this.surface = { x, y, width, height };
    if (this.attached) this.view.setBounds(this.surface);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible && !this.attached) {
      this.window.contentView.addChildView(this.view);
      this.attached = true;
      this.view.setBounds(this.surface);
    } else if (!visible && this.attached) {
      this.window.contentView.removeChildView(this.view);
      this.attached = false;
    }
    this.publishState();
  }

  setPluginPreferences(preferences: PluginUiPreferences) {
    this.pluginPreferences = { ...preferences };
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.send("plugin:preferences", this.pluginPreferences);
    }
  }

  async navigate(value: string) {
    await this.initialize();
    const url = normalizeNavigationUrl(value, this.view.webContents.getURL() || this.homeUrl);
    if (this.view.webContents.getURL() === url) return this.getState();
    if (this.pendingNavigation?.url === url) return this.pendingNavigation.promise;
    const promise = this.view.webContents.loadURL(url).then(() => this.getState()).finally(() => {
      if (this.pendingNavigation?.promise === promise) this.pendingNavigation = undefined;
    });
    this.pendingNavigation = { url, promise };
    return promise;
  }

  async readTargetImage(urlValue: string, documentUrlValue: string) {
    const resourceUrl = new URL(urlValue);
    const documentUrl = new URL(documentUrlValue);
    if (!/^https?:$/.test(resourceUrl.protocol) || !/^https?:$/.test(documentUrl.protocol)) {
      throw new Error("答卷图片仅支持 HTTP 或 HTTPS 资源");
    }
    if (resourceUrl.href.length > 4096 || documentUrl.href.length > 4096) throw new Error("答卷图片地址过长");
    assertAllowedImageResource(resourceUrl, documentUrl);

    return this.withDebugger(async () => {
      const contents = this.view.webContents;
      if (contents.isDestroyed()) throw new Error("目标网页已关闭");
      const client = contents.debugger;
      const attachedHere = !client.isAttached();
      if (attachedHere) client.attach("1.3");
      try {
        await client.sendCommand("Page.enable");
        const treeResult = await client.sendCommand("Page.getFrameTree") as { frameTree: CdpFrameTree };
        const frames = flattenFrameTree(treeResult.frameTree);
        const comparableDocumentUrl = comparableFrameUrl(documentUrl.href);
        const frame = frames.find((candidate) => comparableFrameUrl(candidate.url) === comparableDocumentUrl);
        if (!frame) throw new Error("答卷图片所属页面不在当前阅卷窗口中");
        const cached = await client.sendCommand("Page.getResourceContent", {
          frameId: frame.id,
          url: resourceUrl.href
        }) as { content: string; base64Encoded?: boolean };
        const bytes = Buffer.from(cached.content, cached.base64Encoded ? "base64" : "utf8");
        if (bytes.byteLength > MAX_TARGET_IMAGE_BYTES) throw new Error("答卷图片超过 25 MB 安全上限");
        if (!bytes.byteLength) throw new Error("提取出的答卷图片为空");
        const mimeType = imageMimeType(bytes);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        return {
          dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
          mimeType,
          sha256,
          source: "electron.resource-cache",
          bytes: bytes.byteLength
        };
      } finally {
        if (attachedHere && client.isAttached()) client.detach();
      }
    });
  }

  async action(action: BrowserAction): Promise<BrowserActionResult> {
    const contents = this.view.webContents;
    const history = contents.navigationHistory;
    switch (action) {
      case "back":
        if (history.canGoBack()) history.goBack();
        break;
      case "forward":
        if (history.canGoForward()) history.goForward();
        break;
      case "reload":
        contents.reload();
        break;
      case "stop":
        contents.stop();
        break;
      case "home":
        if (!this.homeUrl) return { ok: false, message: "尚未选择批改任务首页" };
        await contents.loadURL(this.homeUrl);
        break;
      case "open_devtools":
        contents.openDevTools({ mode: "detach", activate: true });
        break;
      case "close_devtools":
        contents.closeDevTools();
        break;
      case "reload_plugin":
        contents.reloadIgnoringCache();
        break;
      case "capture_screenshot": {
        const image = await contents.capturePage();
        const suggested = `grading-page-${new Date().toISOString().replaceAll(":", "-")}.png`;
        const result = await dialog.showSaveDialog(this.window, {
          title: "保存目标网页截图",
          defaultPath: path.join(app.getPath("pictures"), suggested),
          filters: [{ name: "PNG 图片", extensions: ["png"] }]
        });
        if (result.canceled || !result.filePath) return { ok: false, message: "已取消保存截图" };
        await writeFile(result.filePath, image.toPNG());
        return { ok: true, path: result.filePath, message: "截图已保存" };
      }
    }
    return { ok: true };
  }

  controlPipeline(control: PipelineControl): BrowserActionResult {
    if (this.view.webContents.isDestroyed()) return { ok: false, message: "目标网页已关闭" };
    this.view.webContents.send("plugin:command", { control });
    return { ok: true };
  }

  inspectTargetPage() {
    return this.requestPlugin<TargetPageInspection>({ requestId: randomUUID(), kind: "inspect-setup" }, 15_000);
  }

  dryRunCurrentAnswer(options: PipelineDryRunOptions) {
    return this.requestPlugin<PipelineDryRunResult>({ requestId: randomUUID(), kind: "dry-run", options }, 360_000);
  }

  flushStorage() {
    if (this.storageFlushTimer) {
      clearTimeout(this.storageFlushTimer);
      this.storageFlushTimer = undefined;
    }
    if (this.authenticationSnapshotTimer) {
      clearTimeout(this.authenticationSnapshotTimer);
      this.authenticationSnapshotTimer = undefined;
    }
    const operation = this.storageFlushQueue.catch(() => undefined).then(async () => {
      await this.snapshotAuthenticationCookies();
      this.targetSession.flushStorageData();
      await this.targetSession.cookies.flushStore();
    });
    this.storageFlushQueue = operation;
    return operation;
  }

  async getSessionHealth(): Promise<BrowserSessionHealth> {
    const liveCookies = selectZhixueCookies((await this.targetSession.cookies.get({})).map((cookie) => this.toPersistedCookie(cookie)));
    return {
      userDataPath: app.getPath("userData"),
      partition: "persist:hengzhun-target",
      encryptionAvailable: this.cookieVault.isAvailable(),
      vaultCookieCount: this.vaultCookieCount,
      restoredCookieCount: this.restoredCookieCount,
      liveZhixueCookieCount: liveCookies.length,
      persistentCookieCount: liveCookies.filter((cookie) => cookie.expirationDate !== undefined).length,
      sessionCookieCount: liveCookies.filter((cookie) => cookie.expirationDate === undefined).length,
      cookieNames: liveCookies.map((cookie) => cookie.name).sort(),
      lastTargetUrl: await this.navigationStore.load().catch(() => undefined),
      persistenceError: this.persistenceError
    };
  }

  async runPluginDiagnostic(request: PluginDiagnosticRequest): Promise<PluginDiagnosticResult> {
    const actions = new Set(["extract-image", "previous-page", "next-page", "write-score", "clear-score"]);
    if (!request || !actions.has(request.action)) throw new Error("插件测试动作无效");
    if (request.action === "write-score" && (!Number.isFinite(request.score) || Number(request.score) < 0)) {
      throw new Error("请输入大于等于 0 的有效测试分数");
    }
    const result = await this.requestPlugin<PluginDiagnosticTargetResult>({
      requestId: randomUUID(),
      kind: "plugin-diagnostic",
      diagnostic: request
    }, request.action === "extract-image" ? 45_000 : 20_000);
    const { imageDataUrl: _imageDataUrl, imageMimeType: _imageMimeType, imageBytes: _imageBytes, imageHash: _imageHash, imageSource: _imageSource, ...publicResult } = result;
    if (request.action !== "extract-image") return publicResult;

    const image = decodeDiagnosticImage(result);
    const directory = app.isPackaged
      ? path.join(app.getPath("documents"), "Hengzhun", "plugin-diagnostics")
      : path.join(app.getAppPath(), "tmp", "plugin-diagnostics");
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(directory, `answer-${timestamp}-${image.sha256.slice(0, 12)}.${imageExtension(image.mimeType)}`);
    await writeFile(filePath, image.bytes, { flag: "wx" });
    return {
      ...publicResult,
      message: "学生答卷图像已提取并保存到项目诊断目录",
      savedImage: {
        path: filePath,
        mimeType: image.mimeType,
        bytes: image.bytes.byteLength,
        sha256: image.sha256,
        source: result.imageSource || "plugin"
      }
    };
  }

  resolvePluginResponse(response: PluginResponse) {
    const pending = this.pluginRequests.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pluginRequests.delete(response.requestId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error || "目标页插件请求失败"));
  }

  updatePlugin(patch: Partial<PluginStatus>) {
    this.plugin = {
      ...this.plugin,
      ...patch,
      capabilities: patch.capabilities ? { ...patch.capabilities } : this.plugin.capabilities,
      updatedAt: new Date().toISOString()
    };
    this.publishState();
  }

  private publishState() {
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send("browser:state", this.getState());
    }
  }

  private scheduleStorageFlush(delayMs = 350) {
    if (this.storageFlushTimer) clearTimeout(this.storageFlushTimer);
    this.storageFlushTimer = setTimeout(() => {
      this.storageFlushTimer = undefined;
      void this.flushStorage().catch(() => undefined);
    }, delayMs);
  }

  private scheduleAuthenticationSnapshot(delayMs = 300) {
    if (this.authenticationSnapshotTimer) clearTimeout(this.authenticationSnapshotTimer);
    this.authenticationSnapshotTimer = setTimeout(() => {
      this.authenticationSnapshotTimer = undefined;
      void this.snapshotAuthenticationCookies().catch((error: unknown) => {
        this.persistenceError = error instanceof Error ? error.message : "认证 Cookie 保险库写入失败";
      });
    }, delayMs);
  }

  private snapshotAuthenticationCookies() {
    const operation = this.authenticationSnapshotQueue.catch(() => undefined).then(async () => {
      const cookies = (await this.targetSession.cookies.get({})).map((cookie) => this.toPersistedCookie(cookie));
      this.vaultCookieCount = await this.cookieVault.save(cookies);
    });
    this.authenticationSnapshotQueue = operation;
    return operation;
  }

  private toPersistedCookie(cookie: Cookie): PersistedTargetCookie {
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || "",
      hostOnly: Boolean(cookie.hostOnly),
      path: cookie.path || "/",
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: cookie.sameSite,
      ...(cookie.session || cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate })
    };
  }

  private rememberTargetUrl(url: string) {
    this.navigationSaveQueue = this.navigationSaveQueue.catch(() => undefined).then(async () => {
      const saved = await this.navigationStore.save(url);
      if (saved) this.homeUrl = url;
    }).catch((error: unknown) => {
      this.persistenceError = error instanceof Error ? error.message : "最后阅卷页面保存失败";
    });
  }

  private async withDebugger<T>(operation: () => Promise<T>) {
    const previous = this.debuggerQueue;
    let release: () => void = () => {};
    this.debuggerQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private requestPlugin<T>(request: PluginRequest, timeoutMs: number) {
    if (this.view.webContents.isDestroyed()) return Promise.reject(new Error("目标网页已关闭"));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pluginRequests.delete(request.requestId);
        reject(new Error("目标页插件响应超时"));
      }, timeoutMs);
      this.pluginRequests.set(request.requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      this.view.webContents.send("plugin:request", request);
    });
  }

  private rejectPluginRequests(message: string) {
    for (const pending of this.pluginRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pluginRequests.clear();
  }
}
