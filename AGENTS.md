# AGENTS.md — 衡准 · 物理评分台 开发规范

面向 AI 编码代理（Codex / Claude Code / Cursor 等）与本项目开发者的工作约定。改代码前请先读本文件，尤其"核心设计不变量"一节。

## 1. 项目概览

高中物理手写作答 AI 全自动改卷工作台（大题与小题，本地单机，Windows 优先）。

- **技术栈**：Express 5 · React 19 · Vite 7 · Electron 43 · TypeScript 5.8（strict）· zod · vitest · KaTeX
- **大题链路**：默认使用稳定分阶段链路，支持在“PaddleOCR 服务”（默认）与“模型原生视觉分块”两种定位引擎间切换：前者由 PaddleOCR 提供整页 bbox 分块定位，后者由多模态大模型原生进行视觉版面分析与作答区域边界框检测（完全免除外部 PaddleOCR 与 Bos Token）；教师模型核验区块前先区分有效学生作答、扫描阴影/伪影和图像不可用，只有存在连续书写结构时才允许进入 uncertain/unreadable，确认无有效作答时返回 missing 并跳过局部复核；随后核验区块转录并返回逐小问最终答案判定与归一化手写坐标，系统自动提取各小问最终答案局部高清切图作为持久化审计与复核证据；若全部小问最终答案首轮均正确，直接触发全对满分快速通道（无需第二轮模型调用）；若存在真实错误、疑似作答或图像不可用小问，则携带对应小问的高清局部切图按需并行进入视觉复核和评分点审验。每次模型调用保存 callId、尝试次数、耗时、HTTP/解析状态和脱敏失败分类；相同学生、答卷图片哈希与评分标准版本的重跑记录建立重复关系。可手动切换到新的 Responses Agent 链路：该链路仅用于大题、完全不调用 PaddleOCR，由单一主 Agent 直接查看整页视觉输入并按需调用只读局部放大工具。
- **小题链路**：PaddleOCR 读取卷面 → GPT 只根据学生答卷图与 OCR 忠实还原作答 → 评分模型只根据题目、参考答案、锁定评分标准和作答还原评分，不再接收学生原图。
- **计分权威**：教师评语由后端根据已校验结果生成；无论稳定链路还是 Responses Agent 链路，后端都按当前评分标准版本**重算总分**并执行复核判定，不采用模型返回的总分。
- **运行形态**：桌面端（Electron）内嵌目标阅卷页面，完成答卷提取、批改、写分、提交验证与进入下一份。当前默认真实站点为智学网，支持在设置页一键切换到睿芽云，同时保留本地模拟/通用适配器。本地 Web 业务入口已下线，非 Electron 访问只显示桌面端引导与测试页。

## 2. 系统设计目标

### 2.1 主目标：无人值守的全流程自动批改

- 正常情况下，教师只需选定评分标准、打开目标阅卷任务并启动流水线。系统应循环完成“确认当前答卷 → 提取学生图像 → 识别与批改 → 后端重算分数 → 防串卷校验 → 写入网页分数 → 提交并回读验证 → 进入下一份”，直到站点明确返回批次完成。
- 人工操作是异常处理与事后审计手段，不是正常批改链路中每份答卷的前置必经步骤。
- 计分不确定与提交不确定必须区分：前者可在已有合法确定分数时标记复核后继续；后者涉及写分、提交、回读、翻页或串卷风险，必须停止并等待人工核对。

### 2.2 证据目标：每一个结果都能解释、定位和回放

- 系统不得只保存最终分数。每条批改记录应尽可能保留：学生答卷原图与哈希、图像预处理审计、稳定链路的 PaddleOCR 原始 JSONL/Markdown/bbox 或 Responses Agent 链路的完整 output item、工具调用与局部图、视觉转录、最终答案判定、逐评分点决定与扣分、置信度、歧义和复核原因、评分标准快照/版本、模型路由与原始调用记录，以及网页身份、写分、提交和回读事件。
- 卷面证据必须能回到原图的实际区域，只有文字摘要、模型结论或 `blockId` 而无可核对位置，不足以构成高风险判分的完整证据。
- 日志是辅助证据，不能代替结构化历史记录。只出现在进程内存或短期日志中、重启后无法定位的信息，不应被当作可持续审计证据。

### 2.3 复核与回评目标：让人工只看真正有风险的答卷

- `needs_review` 是风险和证据标记，不是对全自动流水线的默认阻断。只要后端已得到有效确定分数且网页提交链路安全，正式流水线应继续写分、提交和翻页，同时将该答卷进入人工复核队列。
- 历史记录和复核界面应能按风险来源、受影响小问/评分点、可能影响分值、置信度和模型/链路版本筛选，并将“模型结论”与“支持或反驳它的卷面证据”并列展示，便于人工判断是否需要回评。
- 重新批改、缓存 OCR 回放或人工回评必须生成新结果并保留旧结果，通过 `previousResultId` / `regradedAt` / `regradeReason` 等关系建立可追溯版本链，不得覆盖或静默改写原历史。

### 2.4 实现决策优先级

出现冲突时按以下顺序取舍：

1. 不串卷、不重复提交、不在提交状态不明时自动翻页；
2. 后端计分权威和当前评分标准版本不可被绕过；
3. 保留足以支持人工复核、回评和回放的证据；
4. 尽可能提高正常批次的自动化率、稳定性和吞吐量；
5. 最后才是界面精简、速度微优化和兼容历史实现的便利性。

## 3. 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发 Web 引导/测试页（API 与 Vite 端口均动态分配） |
| `npm run dev:api` / `npm run dev:web` | 单独起 API / Vite |
| `npm run electron:dev` | 桌面端开发（构建 preload + 启动 Electron） |
| `npm run electron:run` | 运行已构建的桌面端 |
| `npm run build` | 前端构建（`tsc -b && vite build`） |
| `npm run build:server` / `npm run build:electron` | 后端 / Electron 构建（含 esbuild preload bundle） |
| `npm run package:win` | 打包 Windows x64 安装包 |
| `npm test` / `npx vitest run` | 全量测试 |
| `npx tsc -b` | 前端+shared 类型检查 |
| `npx tsc -p tsconfig.server.json` / `tsconfig.electron.json` | server / electron 类型检查 |

**改完代码的标准验证链**：`npx tsc -b` → 对应 `tsc -p` → `npx vitest run` → 必要时 `npm run build`。

## 4. 目录结构

```
src/           前端。DesktopApp.tsx 桌面端主应用（巨型文件）；
               App.tsx 仅因 DesktopApp 复用其导出（ResultDetail 等）而保留，入口已下线；
               ModelRoutingSettings.tsx 管理大题/小题/OCR 模型路由
server/        后端。index.ts 路由；workflows.ts 统一调度与小题链路；
               largeQuestionGrading.ts 大题分阶段链路；paddleOcr.ts OCR 客户端/审计；
               directVisualReview.ts 局部视觉复核；imagePreprocess.ts 答卷预处理；
               gradingEngine.ts 计分引擎；modelClient.ts 模型调用（严格 JSON Schema/信号量）；
               responsesAgentClient.ts Responses API 传输；responsesAgentGrading.ts 无 OCR Agent 大题链路；
               gradingArtifactStore.ts 批改产物与 Agent 局部图持久化；
               historyStore.ts 本地存储；systemLog.ts 操作日志；configStore.ts 配置加密；
               modelRouting.ts 模型路由；schemas.ts zod/JSON Schema 校验
electron/      主进程 main.ts / browserSession.ts（嵌入式浏览器+会话持久化）；
               plugins/ 站点适配器：runtime.ts 流水线状态机、zhixueAdapter.ts（默认智学网）、
               ruiyaAdapter.ts（睿芽云）、genericAdapter.ts（通用）、imageExtractor.ts（答卷图提取）、
               pipelineSafety.ts（防串卷）、preflightSafety.ts
shared/        前后端共享：types.ts 领域类型、electron.ts IPC 契约、
               uiConstants.ts（主题/字体/白名单/图片上限）、pipelineEvents.ts（事件文案）、
               formulaProtocol.ts（LaTeX 安全协议）、startUrl.ts
.data/         运行时数据（模板/历史/加密配置）——gitignore，绝不提交
```

## 5. 核心设计不变量（违反即引入 bug，改前必读）

1. **计分权威**：教师模型判定最终答案 `correct` 的小问**无条件满分**，过程评分点仍审验但**不得降低得分**（`gradingEngine.ts` 的 `grantsFullCredit`）；总分由后端重算，不信任模型总分。
2. **复核安全**：`unreadable`/`uncertain`/审验冲突 → 标记 `needs_review` 并保存原因、置信度和卷面证据；明确判定 `missing + no_effective_answer` 时，评分点只保留 `synthetic_missing` 未作答审计占位，不进入局部视觉复核或评分点审验，也不因没有审验调用而阻断 `scoreResolved`，结果可以确定为 `0` 分并完成流水线；真正缺失模型判断、存在有效但不可辨认作答或审验冲突仍必须进入复核。只要后端已有有效确定分数，正式流水线仍继续走串卷校验、写分、提交和验证；写分或提交过程本身失败仍必须暂停，`maximumPossibleScore` 不因复核提高。
3. **证据不可丢失**：新增或改造批改链路不得只返回/保存最终分数。历史记录必须能追溯到当时的答卷、评分标准版本、OCR/转录、最终答案与评分点判定、复核原因、模型调用和自动提交结果；重评只能追加新版本，不得覆盖旧证据。
4. **局部数值审验**（`workflows.ts` `reviewNumericFinalAnswers`）：对比判定是**子集**——教师读出的数字 token 必须全部出现在审验结果中才放行；**禁止改回"完全相等"**（曾因审验多读过程数字导致误判冲突、误扣过程分的历史 bug，2026-08-15 修复）。
5. **防串卷**：`pageKey`/`pageToken`/`imageHash` 三重校验是写分/提交前的最后同步防线，任何"优化"不得绕过或放宽 `assertSameAnswer`。
6. **站点自动化约束**：只有 `capabilities.skip=true` 的通用/mock 适配器允许跳过当前答卷。智学网在当前份保存前禁用"下一份"；睿芽云没有独立的下一份按钮，提交成功后由站点自动装载下一份。两者均不得为了连续运行伪造跳过；页面不支持跳过或写分/提交/验证状态不明时必须暂停。
7. **模型调用**：稳定链路和 Responses Agent 链路都强制使用严格 `json_schema`，禁止降级到 `json_object` 或 `prompt_json`；Responses Agent 必须请求 `/responses`，严禁回退到 `/chat/completions`，固定 `store:false`，本地手动重放完整 output item（含 reasoning item 与 function-call `call_id`），不依赖 `previous_response_id`；本地智联模型和 PaddleOCR 外呼默认直连，只有显式设置 `HENGZHUN_MODEL_PROXY_URL` 为 HTTP(S) 地址时才使用代理，设置为 `direct` 或空值也直连；`finish_reason=length` 或 Responses `incomplete/failed` 整次作废；模型直接输出标准 LaTeX，JSON 反斜杠由本地解析器在 `JSON.parse` 前修复，历史 `[[LATEX_BS]]` 仅作兼容读取；模型服务返回 HTML 时要报"检查 Base URL（通常需 /v1）"类可读错误。
8. **安全边界**：所有 `/api` 需 `HENGZHUN_API_TOKEN`（timingSafeEqual）；模型和 PaddleOCR 目标 URL 不做 DNS/IP 网络范围限制，只校验 HTTP(S) 结构和禁止目标地址内嵌用户名/密码，目标解析与链路由代理负责；API Key AES-256-GCM 存 `.data/`；日志脱敏（不记录 Key、图片 Base64，只记类型/字节数/SHA-256）。本机 PaddleOCR 联调允许从未跟踪的 `.data/paddleocr.token` 读取明文 Token，环境变量优先；该文件不得进入代码、测试夹具、文档、日志、命令输出或 Git。曾在聊天中暴露的 Token 必须视为失效，不得使用。
9. **图片上限**：统一使用 `shared/uiConstants.ts` 的 `MAX_IMAGE_BYTES`（25MB），所有渲染提取、站点图片读取、主进程传输、诊断解码和预处理路径均不得各自定义新值。
10. **兼容名称不等于当前架构**：`DEFAULT_GRADING_MODE` 和历史配置中的 `vision_direct` 名称为兼容字段；当前大题默认分支实际调用 `gradeLargeQuestionStaged`。不得因字段名称把架构误改回旧版单次整题视觉直批。

11. **Responses Agent 范围**：Responses Agent 仅覆盖手动启用的大题链路，默认配置仍为稳定分阶段链路；Agent v1 只运行一个主 Agent，不派生或并行启动子 Agent。Agent 输入及其局部放大图统一为 WebP q90，学生答卷执行灰度增强，题目/参考答案保留颜色；工具只能读取局部图，不能修改分数、写网页或提交。Agent 调用失败、工具越界/重复/超额或证据来源不真实时必须标记 `needs_review`，不得静默回退稳定链路；`backendGuardrailsEnabled` 默认开启时，`incorrect`/`missing` 即使分数可解析也额外进入 `needs_review` 并可触发独立审验，关闭只取消这项升级，不关闭证据来源、坐标和计分安全校验。
12. **真实环境验收**：Responses API 兼容服务的真实视觉、并发/额度、代理链路，以及真实睿芽云/智学网站点的提取、写分、提交、回读和翻页，必须在登录后的目标环境中人工验收；本地单元测试、模拟页面或 HTTP 200 不等于真实链路验收通过。
13. **稳定链路定位引擎**：分块与定位引擎支持 `paddleocr` 与 `model_native`。选用 `model_native` 时，由多模态大模型原生分析版面与作答区域并输出 `layoutBlocks`，生成首轮定位索引图，完全绕过 PaddleOCR 外部服务与 Bos Token；下游首轮判定、按需复核、评分点审验和后端计分权威保持完全一致。

## 6. 代码规范

- TypeScript `strict`；ESM——NodeNext 侧（server/electron）import 带 `.js` 后缀，前端 Bundler 侧可省略。
- **共享单点维护**：主题色/字体栈/白名单/图片上限 → `shared/uiConstants.ts`；流水线事件类型文案与色调 → `shared/pipelineEvents.ts`（新增事件类型只改这一处）；IPC 通道与桥类型 → `shared/electron.ts`；领域类型 → `shared/types.ts`。禁止在多个文件复制同值常量。
- **控制流**：禁止 magic string 错误（如 `"__PIPELINE_STOPPED__"`），用带 `code` 的错误类（参考 `PipelineInterruptError`、`StaleAnswerError`）。
- **错误消息**：面向用户的中文、可审计（说明停在哪一步、为什么、怎么办）。
- **日志**：模型调用记录走 `systemLog`（`recordModelCall`），操作级日志走 `logEvent`/`logProgress`；日志里不得出现密钥与图片内容。
- **异步取消**：长任务用 `beginOperation` 获得 `operationId`，配合 `AbortController` 与 `throwIfOperationCancelled`；批改完成/失败记得释放 modelCalls（`releaseOperationModelCalls`，幂等）。
- **前端**：巨型文件（DesktopApp.tsx / App.tsx）改动前先用 `rg` 精确定位；可复用的纯函数与常量优先抽到 `shared/` 或独立模块以便测试。
- **评分引擎变更必须同步文档与流程图**：凡修改 `server/gradingEngine.ts`、`server/workflows.ts`、`server/largeQuestionGrading.ts`，或修改评分/复核判定、计分权威、批改阶段顺序时，Codex 必须在同一变更中更新本文件中受影响的业务说明，并同步更新桌面端 `src/DesktopApp.tsx` 的 `CurrentGradingFlow` 流程图及必要样式。流程图必须按实际调用链反映 PaddleOCR、教师模型、按需复核、后端重算和提交边界；完成后至少运行相关计分/工作流测试、类型检查和构建验证。
- **System Prompt 按实际步骤控制**：教师模型提示词配置必须挂在 `modelRoutes` 的实际业务路由上，不得新增无法对应调用链的全局“泛化提示词”。当前生效的内置步骤提示词统一维护在 `shared/modelPrompts.ts`，服务端实际调用和教师模型设置页必须读取同一来源；页面要展示内置基线，空值使用代码内置提示词，追加模式保留现有角色、证据和 JSON 约束，替换模式必须明确标记高风险；系统追加的 LaTeX 安全协议不可被配置覆盖。涉及提示词调用链或路由配置时，同步维护教师模型设置页与 `CurrentGradingFlow` 的步骤说明，并补充服务端生效测试。

## 7. 测试规范

- **新逻辑必须补 vitest 测试**，至少覆盖边界与失败路径；涉及计分/审验逻辑时，`server/gradingEngine.test.ts` 与 `server/workflows.test.ts` 全量回归。
- 本地存储相关测试用临时目录 + 动态 `import("./historyStore.js")`（模块级读 `APP_DATA_DIR`），参考 `server/historyStore.test.ts` 的 `withTempStore` 模式。
- 前端两大文件（App/DesktopApp）无组件测试——不要为它们硬写组件测试；把可测逻辑下沉后测试。
- 运行：`npx vitest run`；提交前保证全绿。

## 8. Git 规范

- 提交信息：`<type>: <摘要>`，type ∈ `fix|feat|refactor|chore|docs|test|release`；摘要中英皆可，写明"为什么"。
- 工作树有未提交改动时先 `git status` 确认范围；大改前打备份 tag（如 `backup-<日期>`），备份提交消息以 `backup:` 开头。
- 绝不提交：`.data/`、`dist*/`、`release*/`、`node_modules/`、`tmp/`、`*.log`、`*.tsbuildinfo`、`deepseek-harness-app/`。
- 不要修改 `hi.docx` 类无关文件；无关文件发现后删除并从暂存区排除。

## 9. 常见陷阱速查

- **模型调用报 `Unexpected token '<'`**：模型 Base URL 缺 `/v1` 路径，请求命中网站首页 HTML。修复是配置改为 `https://host/v1`，不是代码问题。
- **查看运行中实例日志**：开发模式下 API token 由 `scripts/run-dev.mjs` 随机生成，无法直连；走 Vite 代理（`http://127.0.0.1:<web端口>/api/logs`）免 token。历史模型调用详情在 `.data/history.json` 的 `records[].modelCalls`。
- **`localhost:5173` 类硬编码**：打包版没有 Vite 端口，链接必须用同源相对路径。
- **睿芽云真实页**：无独立"下一份"控件；只能在逐小问分值、满分和总分都匹配时写入，提交后等待页面自动换卷。普通"保存成功/提交成功"弹窗不是批次完成证据。
- **zhixue 模拟页**（`src/ZhixueMockPage.tsx`）：已对齐"未保存时下一份禁用"；改模拟页时保持该约束，否则流水线回归测试失真。
- **双前端现状**：不要重新启用 `main.tsx` 里的 Web 版入口；`App.tsx` 删除前必须先把 `ResultDetail`/`ModelCallDetails`/`ModelCallHistory` 抽离并改 DesktopApp 引用。
