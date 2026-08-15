import type { PluginAccent, PluginPhase, PluginPosition, UiFontFamily, UiMonoFontFamily, WindowMaterial, MotionIntensity } from "./electron.js";

/**
 * 跨端共享的 UI/策略常量。
 * 此前在 electron/plugins/runtime.ts、electron/main.ts、src/DesktopApp.tsx、src/App.tsx
 * 中重复定义；统一在此维护，避免样式与白名单漂移。
 */

/** 答卷图片安全上限（字节）。主进程、渲染进程与流水线读图路径共用。 */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export const pluginAccents: PluginAccent[] = ["teal", "blue", "green", "graphite"];
export const pluginPositions: PluginPosition[] = ["bottom-right", "bottom-left"];
export const windowMaterials: WindowMaterial[] = ["solid", "mica", "acrylic"];
export const motionIntensities: MotionIntensity[] = ["off", "comfortable", "lively"];
export const uiFontFamilies: UiFontFamily[] = ["system", "inter", "noto-sans-sc", "source-han-sans", "microsoft-yahei"];
export const uiMonoFontFamilies: UiMonoFontFamily[] = ["cascadia", "consolas", "system"];
export const uiFontWeights = [400, 500, 600, 700] as const;

export const pluginThemes: Record<PluginAccent, { accent: string; hover: string; soft: string; ring: string }> = {
  teal: { accent: "#13a8a2", hover: "#0d8c88", soft: "#e8f8f6", ring: "rgba(19,168,162,.14)" },
  blue: { accent: "#397fe8", hover: "#2868c9", soft: "#edf4ff", ring: "rgba(57,127,232,.14)" },
  green: { accent: "#2d8b68", hover: "#237255", soft: "#eaf6f0", ring: "rgba(45,139,104,.14)" },
  graphite: { accent: "#4f6572", hover: "#394d59", soft: "#edf2f4", ring: "rgba(79,101,114,.14)" }
};

export const pluginFontStacks: Record<UiFontFamily, string> = {
  system: '"Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif',
  inter: 'Inter, "Segoe UI Variable", "Segoe UI", "Noto Sans SC", "Microsoft YaHei UI", sans-serif',
  "noto-sans-sc": '"Noto Sans SC", "Noto Sans CJK SC", "Segoe UI", "Microsoft YaHei UI", sans-serif',
  "source-han-sans": '"Source Han Sans SC", "思源黑体", "Noto Sans SC", "Microsoft YaHei UI", sans-serif',
  "microsoft-yahei": '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
};

export const pluginMonoFontStacks: Record<UiMonoFontFamily, string> = {
  cascadia: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  consolas: 'Consolas, "Cascadia Mono", monospace',
  system: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
};

/** 流水线阶段的中文标签（插件悬浮窗与桌面端共用）。 */
export const pluginPhaseLabels: Record<PluginPhase, string> = {
  disconnected: "未连接",
  handshaking: "连接中",
  idle: "待机",
  preflight: "页面检查",
  ready: "已就绪",
  extracting: "读取答卷",
  grading: "模型批改",
  writing_score: "写入分数",
  submitting: "提交分数",
  verifying: "校验提交",
  navigating_next: "进入下一份",
  completed: "批次完成",
  skipped: "跳过当前",
  paused: "已暂停",
  failed: "异常"
};

/** 系统日志作用域的中文标签。 */
export const systemLogScopeLabels: Record<string, string> = {
  rubric: "评分标准",
  grading: "答卷批改",
  equivalence: "答案判定审计",
  scoring: "规则计分",
  storage: "数据保存",
  model: "模型调用",
  system: "系统"
};
