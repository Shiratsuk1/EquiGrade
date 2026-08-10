import { contextBridge, ipcRenderer } from "electron";
import type {
  BrowserAction,
  BrowserSurfaceBounds,
  BrowserSessionHealth,
  EmbeddedBrowserState,
  PipelineControl,
  PipelineDryRunOptions,
  PipelineEvent,
  PluginUiPreferences,
  PluginDiagnosticRequest,
  PipelineTaskSelection,
  WindowMaterial
} from "../shared/electron.js";

function subscribe<T>(channel: string, callback: (payload: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const apiTokenArgument = process.argv.find((value) => value.startsWith("--hengzhun-api-token="));
const apiToken = apiTokenArgument?.slice("--hengzhun-api-token=".length) ?? "";

contextBridge.exposeInMainWorld("electronHost", {
  isElectron: true,
  version: process.versions.electron,
  apiToken,
  getModelSetupStatus: () => ipcRenderer.invoke("pipeline:model-setup-status"),
  testModelConnection: () => ipcRenderer.invoke("pipeline:test-model"),
  inspectTargetPage: () => ipcRenderer.invoke("pipeline:inspect-target"),
  runPluginDiagnostic: (request: PluginDiagnosticRequest) => ipcRenderer.invoke("pipeline:plugin-diagnostic", request),
  dryRunCurrentAnswer: (options: PipelineDryRunOptions) => ipcRenderer.invoke("pipeline:dry-run", options),
  selectPipelineTask: (selection: PipelineTaskSelection) => ipcRenderer.invoke("pipeline:select-task", selection),
  getTemplateContext: () => ipcRenderer.invoke("pipeline:template-context"),
  getPipelineEvents: () => ipcRenderer.invoke("pipeline:recent-events"),
  onPipelineEvent: (callback: (event: PipelineEvent) => void) => subscribe("pipeline:event", callback),
  getBrowserState: () => ipcRenderer.invoke("browser:get-state"),
  getBrowserSessionHealth: (): Promise<BrowserSessionHealth> => ipcRenderer.invoke("browser:session-health"),
  onBrowserState: (callback: (state: EmbeddedBrowserState) => void) => subscribe("browser:state", callback),
  onBrowserSurfaceRequest: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("browser:request-surface", listener);
    return () => ipcRenderer.removeListener("browser:request-surface", listener);
  },
  navigateBrowser: (url: string) => ipcRenderer.invoke("browser:navigate", url),
  runBrowserAction: (action: BrowserAction) => ipcRenderer.invoke("browser:action", action),
  setBrowserSurface: (bounds: BrowserSurfaceBounds) => ipcRenderer.send("browser:set-surface", bounds),
  setBrowserVisible: (visible: boolean) => ipcRenderer.send("browser:set-visible", visible),
  setPluginPreferences: (preferences: PluginUiPreferences) => ipcRenderer.invoke("plugin:set-preferences", preferences),
  setWindowMaterial: (material: WindowMaterial) => ipcRenderer.invoke("window:set-material", material),
  controlPipeline: (control: PipelineControl) => ipcRenderer.invoke("pipeline:control", control)
});

window.addEventListener("DOMContentLoaded", () => document.body.classList.add("electron-host"));
