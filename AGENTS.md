# AGENTS.md — 衡准 · 物理评分台 开发规范

面向 AI 编码代理（Codex / Claude Code / Cursor 等）与本项目开发者的工作约定。改代码前请先读本文件，尤其"核心设计不变量"一节。

## 1. 项目概览

高中物理手写作答 AI 自动改卷工作台（本地单机，Windows 优先）。

- **技术栈**：Express 5 · React 19 · Vite 7 · Electron 43 · TypeScript 5.8（strict）· zod · vitest · KaTeX
- **核心模式**：视觉直批——教师多模态模型一次调用同时返回"逐小问最终答案判定 + 逐评分点审验 + 教师评语"；后端只做结构校验、按当前评分标准版本**重算总分**、复核阈值判定，不采用模型返回的总分。
- **运行形态**：桌面端（Electron）为主，右侧内嵌智学网阅卷页面并自动写分/提交/翻页；本地 Web 版已下线（`main.tsx` 对非 Electron 访问显示引导页）。

## 2. 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发（API 8788 随机端口 + Vite 5173） |
| `npm run dev:api` / `npm run dev:web` | 单独起 API / Vite |
| `npm run electron:dev` | 桌面端开发（构建 preload + 启动 Electron） |
| `npm run electron:run` | 运行已构建的桌面端 |
| `npm run build` | 前端构建（`tsc -b && vite build`） |
| `npm run build:server` / `npm run build:electron` | 后端 / Electron 构建（含 esbuild preload bundle） |
| `npm run package:win` | 打包 Windows x64 安装包 |
| `npm test` / `npx vitest run` | 全量测试（当前 146 个用例） |
| `npx tsc -b` | 前端+shared 类型检查 |
| `npx tsc -p tsconfig.server.json` / `tsconfig.electron.json` | server / electron 类型检查 |

**改完代码的标准验证链**：`npx tsc -b` → 对应 `tsc -p` → `npx vitest run` → 必要时 `npm run build`。

## 3. 目录结构

```
src/           前端。DesktopApp.tsx 桌面端主应用（1900 行，巨型文件）；
               App.tsx 仅因 DesktopApp 复用其导出（ResultDetail 等）而保留，入口已下线
server/        后端。index.ts 路由；workflows.ts 批改工作流（1026 行）；
               gradingEngine.ts 计分引擎；modelClient.ts 模型调用（降级链/信号量）；
               historyStore.ts 本地存储；systemLog.ts 操作日志；configStore.ts 配置加密；
               schemas.ts zod 校验
electron/      主进程 main.ts / browserSession.ts（嵌入式浏览器+会话持久化）；
               plugins/ 站点适配器：runtime.ts 流水线状态机、zhixueAdapter.ts（智学网）、
               genericAdapter.ts（通用）、imageExtractor.ts（答卷图提取）、
               pipelineSafety.ts（防串卷）、preflightSafety.ts
shared/        前后端共享：types.ts 领域类型、electron.ts IPC 契约、
               uiConstants.ts（主题/字体/白名单/图片上限）、pipelineEvents.ts（事件文案）、
               formulaProtocol.ts（LaTeX 安全协议）、startUrl.ts
.data/         运行时数据（模板/历史/加密配置）——gitignore，绝不提交
```

## 4. 核心设计不变量（违反即引入 bug，改前必读）

1. **计分权威**：教师模型判定最终答案 `correct` 的小问**无条件满分**，过程评分点仍审验但**不得降低得分**（`gradingEngine.ts` 的 `grantsFullCredit`）；总分由后端重算，不信任模型总分。
2. **复核安全**：`unreadable`/`uncertain`/审验冲突 → **转人工复核**，绝不静默按普通 0 分发布；`maximumPossibleScore` 不因复核提高。
3. **局部数值审验**（`workflows.ts` `reviewNumericFinalAnswers`）：对比判定是**子集**——教师读出的数字 token 必须全部出现在审验结果中才放行；**禁止改回"完全相等"**（曾因审验多读过程数字导致误判冲突、误扣过程分的历史 bug，2026-08-15 修复）。
4. **防串卷**：`pageKey`/`pageToken`/`imageHash` 三重校验是写分/提交前的最后同步防线，任何"优化"不得绕过或放宽 `assertSameAnswer`。
5. **智学网现实约束**：批完（保存提交）当前份之前"下一份"按钮禁用 → 跳过不可行。跳过仅支持 `capabilities.skip=true` 的适配器（通用/mock）；zhixue 场景失败重试 2 次后直接暂停。
6. **模型调用**：结构化输出降级链 `json_schema → json_object → prompt_json`；`finish_reason=length` 整次作废；JSON 内 LaTeX 反斜杠必须走 `[[LATEX_BS]]` 协议；模型服务返回 HTML 时要报"检查 Base URL（通常需 /v1）"类可读错误。
7. **安全边界**：所有 `/api` 需 `HENGZHUN_API_TOKEN`（timingSafeEqual）；外呼模型 URL 过白名单（`outboundUrlPolicy`）；API Key AES-256-GCM 存 `.data/`；日志脱敏（不记录 Key、图片 Base64，只记类型/字节数/SHA-256）。
8. **图片上限**：统一使用 `shared/uiConstants.ts` 的 `MAX_IMAGE_BYTES`（25MB），三处消费（渲染提取/主进程读图/诊断解码）不得各自定义新值。

## 5. 代码规范

- TypeScript `strict`；ESM——NodeNext 侧（server/electron）import 带 `.js` 后缀，前端 Bundler 侧可省略。
- **共享单点维护**：主题色/字体栈/白名单/图片上限 → `shared/uiConstants.ts`；流水线事件类型文案与色调 → `shared/pipelineEvents.ts`（新增事件类型只改这一处）；IPC 通道与桥类型 → `shared/electron.ts`；领域类型 → `shared/types.ts`。禁止在多个文件复制同值常量。
- **控制流**：禁止 magic string 错误（如 `"__PIPELINE_STOPPED__"`），用带 `code` 的错误类（参考 `PipelineInterruptError`、`StaleAnswerError`）。
- **错误消息**：面向用户的中文、可审计（说明停在哪一步、为什么、怎么办）。
- **日志**：模型调用记录走 `systemLog`（`recordModelCall`），操作级日志走 `logEvent`/`logProgress`；日志里不得出现密钥与图片内容。
- **异步取消**：长任务用 `beginOperation` 获得 `operationId`，配合 `AbortController` 与 `throwIfOperationCancelled`；批改完成/失败记得释放 modelCalls（`releaseOperationModelCalls`，幂等）。
- **前端**：巨型文件（DesktopApp.tsx / App.tsx）改动前先 `grep` 精确定位；可复用的纯函数与常量优先抽到 `shared/` 或独立模块以便测试。

## 6. 测试规范

- **新逻辑必须补 vitest 测试**，至少覆盖边界与失败路径；涉及计分/审验逻辑时，`server/gradingEngine.test.ts` 与 `server/workflows.test.ts` 全量回归。
- 本地存储相关测试用临时目录 + 动态 `import("./historyStore.js")`（模块级读 `APP_DATA_DIR`），参考 `server/historyStore.test.ts` 的 `withTempStore` 模式。
- 前端两大文件（App/DesktopApp）无组件测试——不要为它们硬写组件测试；把可测逻辑下沉后测试。
- 运行：`npx vitest run`；提交前保证全绿。

## 7. Git 规范

- 提交信息：`<type>: <摘要>`，type ∈ `fix|feat|refactor|chore|docs|test|release`；摘要中英皆可，写明"为什么"。
- 工作树有未提交改动时先 `git status` 确认范围；大改前打备份 tag（如 `backup-<日期>`），备份提交消息以 `backup:` 开头。
- 绝不提交：`.data/`、`dist*/`、`release*/`、`node_modules/`、`tmp/`、`*.log`、`*.tsbuildinfo`、`deepseek-harness-app/`。
- 不要修改 `hi.docx` 类无关文件；无关文件发现后删除并从暂存区排除。

## 8. 常见陷阱速查

- **模型调用报 `Unexpected token '<'`**：模型 Base URL 缺 `/v1` 路径，请求命中网站首页 HTML。修复是配置改为 `https://host/v1`，不是代码问题。
- **查看运行中实例日志**：开发模式下 API token 由 `scripts/run-dev.mjs` 随机生成，无法直连；走 Vite 代理（`http://127.0.0.1:<web端口>/api/logs`）免 token。历史模型调用详情在 `.data/history.json` 的 `records[].modelCalls`。
- **`localhost:5173` 类硬编码**：打包版没有 Vite 端口，链接必须用同源相对路径。
- **zhixue 模拟页**（`src/ZhixueMockPage.tsx`）：已对齐"未保存时下一份禁用"；改模拟页时保持该约束，否则流水线回归测试失真。
- **双前端现状**：不要重新启用 `main.tsx` 里的 Web 版入口；`App.tsx` 删除前必须先把 `ResultDetail`/`ModelCallDetails`/`ModelCallHistory` 抽离并改 DesktopApp 引用。
