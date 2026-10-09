# 小题独立批改链路实施方案（Luna 执行版）

> 目标仓库：`F:\ChatGPT\改卷系统`  
> 执行模型：Luna  
> 文档性质：实施规格，不代表已完成  
> 交付目标：建立“小题独立分流 + PaddleOCR + GPT 作答还原 + GPT 评分”第一版，同时保持现有大题链路行为不变。

## 0. 给执行模型的总指令

你正在修改一个已有大量业务逻辑和未提交改动的 Electron/React/Express 项目。开始前完整阅读根目录 `AGENTS.md`，执行 `git status --short`，逐个检查任务涉及文件的当前内容和 diff。保留用户已有修改，不得 reset、checkout、覆盖或顺手重构无关代码，不得提交或推送 Git。

本任务属于核心业务链路变更。先调查真实调用路径，再按本方案做最小实现；必须补充失败路径和历史数据兼容测试。禁止使用 TODO、占位返回、假 OCR 结果或吞异常冒充完成。

用户消息中出现过的 PaddleOCR Token 已经暴露，视为不可用密钥，不得使用。为便于本机临时联调，允许使用新的明文 Token，但仅限以下运行时入口：

- 环境变量 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`；
- 未跟踪的 `.data/paddleocr.token` 本机文件，环境变量优先。

Token 不得写入代码、测试夹具、文档、日志、命令输出或 `.env.example`；文档和错误示例统一写作 `[REDACTED_SECRET]`。`.data/` 已被 Git 忽略。没有新 Token 时仍要完成实现与 mock 测试，但必须把“未执行真实 PaddleOCR 联调”列为未验证事项。

## 1. 已确认的产品规则

### 1.1 题型与历史兼容

- 评分标准增加题型：`large`（大题）或 `small`（小题）。
- 新建评分标准时必须显式选择“大题 / 小题”，默认选“大题”。
- 历史评分标准没有题型字段时，读取后统一迁移为 `large`。
- 题型决定后续批改链路；不得再由全局模型配置中的 `gradingMode` 覆盖小题分流。
- 评分标准保存后题型不可修改。如需更换题型，必须新建评分标准。
- 初版小题评分标准的导入、结构化和计分规则与大题一致，但两类配置/提示词必须独立存放，后续能单独调整小题而不影响大题。

### 1.2 大题链路保持不变

现有大题继续使用当前链路：

- `vision_direct` 或 `evidence_pipeline` 由现有全局配置决定。
- 教师模型确认最终答案 `correct` 的小问仍无条件满分。
- 过程评分点仍审验，但不得降低最终答案正确小问的得分。
- `unreadable`、`uncertain`、缺失审验结果等仍标记 `needs_review`，保存低置信证据供历史记录检查和回批；只要后端已生成有效确定分数，正式网页流水线不因该标记暂停，写分/提交自身失败仍按安全规则暂停。
- 不得修改 `gradingEngine.ts` 中既有计分不变量，除非只是为新链路传入现有引擎所需的数据。

### 1.3 小题链路固定流程

```text
学生作答原图
   ↓
PaddleOCR-VL（原始 JSONL 完整保存）
   ↓
GPT 作答还原（学生原图 + OCR；禁止题目/答案/评分标准）
   ↓
GPT 小题评分（题目/题图 + 还原作答 + 参考答案/图 + 评分标准；禁止学生原图）
   ↓
现有后端计分引擎重算分数
   ↓
completed / needs_review
```

小题不读取全局 `gradingMode` 来选择别的流程，固定走这条独立链路。

### 1.4 两阶段信息隔离

第一阶段“作答还原”只能接收：

- 学生作答原图；
- PaddleOCR Markdown/结构化识别内容；
- 与忠实转录有关的系统指令。

第一阶段严禁接收或在 prompt 中出现：

- 题目文字、题目图片；
- 标准答案、参考答案图片；
- 评分标准 JSON；
- 小问的正确答案、评分点要求或分值。

第二阶段“评分”可以接收：

- 题目文字及题目图片；
- 第一步的结构化作答还原；
- 参考答案文字及参考答案图片；
- 当前锁定版本的评分标准 JSON。

第二阶段不得再次接收学生作答原图。学生作答的唯一输入必须是第一阶段的还原结果，避免评分阶段绕过 OCR/还原链路或重新脑补字迹。

## 2. 数据模型设计

### 2.1 题型

在 `shared/types.ts` 增加：

```ts
export const QUESTION_TYPES = ["large", "small"] as const;
export type QuestionType = typeof QUESTION_TYPES[number];
```

`Rubric` 增加必填字段：

```ts
questionType: QuestionType;
```

不要长期把它设计成可选字段。历史兼容应在存储读取/Schema 解析边界完成，而不是让整个业务层反复处理 `undefined`。

`GradingTemplateSummary` 增加 `questionType`，由模板当前 rubric 派生。`GradingTemplateDetail.rubric.questionType` 必须始终存在。

### 2.2 历史数据迁移

在 `server/historyStore.ts` 的数据库读取边界增加纯函数迁移：

- `template.rubric.questionType ??= "large"`；
- 每条 `record.rubricSnapshot` 缺失时也补为 `large`；
- 不改变历史版本、分数或其他字段；
- 迁移可以只在内存中归一化，不要求启动时强制重写 `.data/history.json`；后续正常写入时自然保存新字段。

为迁移函数补测试，使用临时 `APP_DATA_DIR`，真实 `.data/` 只读且不得作为测试输入。

### 2.3 OCR 审计数据

在 `GradingResult` 增加可选审计字段，建议结构：

```ts
interface PaddleOcrAudit {
  provider: "paddleocr";
  model: string;
  jobId: string;
  rawJsonl: string;
  markdownText: string;
  durationMs: number;
}

ocrAudit?: PaddleOcrAudit;
gradingPipeline?: "large_question" | "small_question_ocr";
```

第一版允许把完整 `rawJsonl` 随 `GradingResult` 保存进现有历史记录，以降低跨模块改造风险。不得截断、只保留 Markdown 或只保留模型还原结果。日志只能记录 `jobId`、模型、字节数、耗时等元数据，绝不能记录 `rawJsonl`、学生图片或 Token。

如果实际返回的单页 JSONL 大到明显影响 `history.json` 或历史 API，再停止并报告，不要未经确认扩展成新的资产存储系统。

### 2.4 作答还原契约

在 `server/schemas.ts` 新建独立 Schema，不复用带 `subquestionId` 的最终答案 Schema。建议：

```ts
interface StudentAnswerReconstruction {
  lines: AnswerLine[];
  ambiguities: Array<{
    lineId?: string;
    reason: string;
    scoreImpact: "none" | "possible" | "certain";
  }>;
  status: "clear" | "review";
  reviewReasons: string[];
}
```

此阶段不知道题目和小问 ID，因此不得要求模型把答案强行映射到 rubric 小问。`lines[].region` 应尽可能使用原图像素坐标，涂改内容标为 `crossed_out`，无法确认的字/数字/符号标为 `uncertain` 并给出候选。

### 2.5 小题评分输出契约

新增 `smallQuestionGradeSchema`，返回：

- `finalAnswerJudgements`；
- `decisions`；
- `appliedDeductions`；
- `teacherCommentary`。

评分输出中的所有 `evidenceLineIds` 只能引用还原结果已有行 ID。后端继续过滤未知/重复的小问、评分点和扣分规则，并由 `calculateGrade` 汇总；不得采用模型返回的总分。

## 3. PaddleOCR 服务

新增 `server/paddleOcr.ts`，用 Node/TypeScript 的 `fetch`、`FormData` 和 `Blob` 实现，不要在生产链路启动 Python，也不要新增 `requests` 运行时依赖。仓库中的 `scripts/test-paddleocr-vl.py` 只能作为接口行为参考。

### 3.1 固定默认值

```text
Job URL: https://paddleocr.aistudio-app.com/api/v2/ocr/jobs
Model: PaddleOCR-VL-1.6
Token env: PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN
```

允许以下非密钥环境变量覆盖：

- `PADDLEOCR_JOB_URL`；
- `PADDLEOCR_MODEL`；
- `PADDLEOCR_POLL_INTERVAL_MS`，默认 5000；
- `PADDLEOCR_TIMEOUT_MS`，默认 600000。

`.env.example` 只添加空值和说明，不能出现任何真实 Token。本机也可以将新的联调 Token 单独保存到未跟踪的 `.data/paddleocr.token`，运行时读取后不得写入日志或结果文本。

### 3.2 调用流程

1. 检查 Token；缺失时抛出中文可操作错误。
2. 使用 multipart 上传当前学生图片：
   - `model`；
   - `optionalPayload` JSON 字符串；
   - `file`。
3. 读取 `data.jobId`。
4. 每 5 秒查询 `GET /jobs/{jobId}`。
5. `pending/running` 继续等待；`failed` 抛出 API 返回的可读原因；未知状态拒绝继续。
6. `done` 后读取 `data.resultUrl.jsonUrl`。
7. 下载并完整保存 JSONL；解析其中 `layoutParsingResults[].markdown.text` 合并为 OCR Markdown。

### 3.3 安全和可靠性

- 接受当前 grading operation 的 `AbortSignal`，提交、轮询等待和下载均支持取消。
- 总超时后抛出明确错误，不无限轮询。
- 对 Job URL 和结果 URL 执行 HTTPS/安全出站校验；可复用现有出站 URL 安全能力，不能允许访问回环、私网或本地文件。
- 不记录 Authorization header，不在错误消息中拼接请求 headers。
- HTTP 非 2xx、非 JSON、缺少 `jobId`、未知状态、空 JSONL 都要有独立失败测试。
- OCR 失败不得降级到现有大题链路，也不得继续评分。让现有流水线失败/重试/暂停策略接管。

## 4. 评分标准创建与题型分流

### 4.1 UI

在 `src/DesktopApp.tsx` 的 `TemplateCreatePage` 中，于材料输入框上方增加题型选择：

- 大题：说明“沿用现有教师模型批改链路”；
- 小题：说明“PaddleOCR → GPT 作答还原 → GPT 小题评分”。

行为：

- 默认大题；
- 生成评分标准前可切换；
- 已生成草稿后切换题型时，清空 rubric 草稿、JSON 编辑状态和 refine 提示，但保留题目/参考材料；
- 保存后在模板列表、模板详情和任务选择处显示“大题/小题”标签；
- 不增加 Token 输入框，Token 仍只来自环境变量。

UI 属于低风险修改，只做直接 smoke check，不为巨型 `DesktopApp.tsx` 强写组件测试。

### 4.2 API 与 Schema

`POST /api/rubrics/structure` 接收 `questionType`。后端使用 zod 校验，并将用户选择的题型强制写入最终 rubric；不能信任模型自行返回的题型。

`rubricSchema` 和 `rubricJsonSchema` 都加入题型字段。历史输入通过存储迁移变为 `large`。

`PUT /api/templates/:id/rubric` 保存修改前读取现有模板并比较题型，不一致时拒绝，错误信息说明“题型保存后不可修改，请新建评分标准”。

### 4.3 独立评分标准规则配置

新增一个小型服务端模块，例如 `server/rubricWorkflowPolicies.ts`：

```ts
export const LARGE_QUESTION_RUBRIC_POLICY = { ... };
export const SMALL_QUESTION_RUBRIC_POLICY = { ... };
```

初版两份内容一致，但必须是两个独立对象/提示词入口。不要让小题简单调用大题函数且无法单独修改。共同的 Schema 校验、分值合计检查和保存代码仍应复用，避免复制业务基础设施。

`structureRubric` 根据 `questionType` 选择 policy，最终仍调用相同的结构校验。`refineRubric` 必须保持原题型，模型若修改题型则拒绝。

## 5. 小题批改工作流

在 `server/workflows.ts` 内保留现有 `gradeStudentAnswer` 入口，最前面根据 `input.rubric.questionType` 分流：

```ts
if (input.rubric.questionType === "small") {
  return gradeSmallQuestion(...);
}
return existingLargeQuestionFlow(...);
```

不要改动所有调用方；手动上传、生产流水线、历史重判都通过同一入口自然获得题型分流。

### 5.1 阶段 A：PaddleOCR

- 调用独立 `runPaddleOcr`。
- 操作日志记录开始、完成、失败状态及非敏感元数据。
- 原始 JSONL 保留在内存并进入最终 `ocrAudit`。

### 5.2 阶段 B：GPT 作答还原

调用视觉模型，输入严格限制为：

- `[学生作答原图]`；
- PaddleOCR Markdown；
- 忠实转录系统指令。

系统指令必须明确：

- 只还原学生实际写了什么；
- 不解题、不评分；
- 不猜题目、答案或评分标准；
- 原图优先于 OCR，但模糊处不能脑补；
- 涂改、覆盖、模糊数字、符号和上下标必须显式标记。

测试必须检查这一调用的 prompt/system/images：不能包含 `input.questionText`、`input.referenceText`、`JSON.stringify(input.rubric)`、题目图片或参考答案图片。

### 5.3 阶段 C：GPT 小题评分

评分阶段输入：

- 题目文字；
- 题目图片（如有）；
- `StudentAnswerReconstruction`；
- 参考答案文字；
- 参考答案图片（如有）；
- 当前 rubric JSON。

评分阶段不得包含学生原图。若存在题目/参考图片则使用视觉模型，否则可使用文本模型；无论选择哪个模型，学生答案都只能来自还原结果。

评分规则初版复制大题当前规则：

- 数学等价、物理意义、单位、方向和合理舍入由模型判断；
- 每个小问必须有一条 `finalAnswerJudgement`；
- 每个评分点必须有一条 decision；
- 最终答案 `correct` 时该小问满分，过程审验仅用于审计；
- 最终答案不正确、缺失或不确定时按评分点和扣分规则计分；
- 未知 ID、重复 ID、无效证据引用由本地过滤/降级为复核，不得直接信任。

### 5.4 阶段 D：本地汇总与 REVIEW

把还原行转换为现有 `AnswerEvidence`，再调用 `calculateGrade`。最终结果增加：

```ts
gradingPipeline: "small_question_ocr"
ocrAudit: paddleResult
```

以下任一情况必须把结果设为 `needs_review`，不受普通 unreadable 分值阈值放宽：

- reconstruction.status 为 `review`；
- 关键数字、公式、单位、方向或涂改结果无法确认；
- `ambiguities[].scoreImpact` 为 `possible` 或 `certain`；
- 最终答案为 `uncertain`；
- 评分点为 `unreadable`；
- 模型遗漏小问/评分点，或证据引用无效；
- 评分阶段调用失败。

OCR API 本身失败时整次 grading 失败，不产生可提交分数。不要把网络故障伪装成人工复核的 0 分结果。

### 5.5 历史重判

`/api/templates/:templateId/regrade` 继续读取历史学生原图和当次 rubric snapshot。若 snapshot 为小题，则重新执行 OCR、还原和评分，生成新的 `ocrAudit` 和结果记录；原记录、原 OCR 审计和原模型调用不覆盖。

## 6. 建议修改文件范围

优先只修改/新增以下文件：

- `shared/types.ts`
- `server/schemas.ts`
- `server/workflows.ts`
- `server/historyStore.ts`
- `server/index.ts`
- `server/paddleOcr.ts`（新增）
- `server/paddleOcr.test.ts`（新增）
- `server/rubricWorkflowPolicies.ts`（新增，可按实际最小设计调整名称）
- `server/workflows.test.ts`
- `server/historyStore.test.ts`
- `src/DesktopApp.tsx`
- `src/desktop.css`
- `.env.example`
- `README.md`（只补充小题链路与环境变量，不改无关章节）

不要修改 Electron 站点适配器、防串卷检查或网页写分逻辑，除非类型检查证明共享类型必须同步；小题输出仍使用现有 `GradingResult` 和 score 回填路径。

## 7. 必须补充的测试

### 7.1 Schema 与迁移

- 新 rubric 接受 `large/small`，拒绝其他值。
- 历史 rubric/快照缺失题型时迁移为 `large`。
- 新建小题 rubric 后 summary/detail 均返回 `small`。
- 保存后尝试修改题型被拒绝。
- `refineRubric` 不能改变题型。

### 7.2 PaddleOCR 客户端

使用 mock `fetch` 覆盖：

- submit → pending → running → done → 下载 JSONL；
- Markdown 正确从多行 JSONL、多页结果合并；
- Token 缺失；
- HTTP 非 2xx；
- 非 JSON；
- 缺少 jobId；
- failed 状态；
- 未知状态；
- 超时；
- AbortSignal 取消；
- 空 JSONL。

测试断言不得打印 Authorization 值。

### 7.3 小题工作流

mock `runPaddleOcr` 与 `callStructured`，至少覆盖：

- 小题固定走 OCR → 还原 → 评分，且不进入现有大题直批函数；
- 大题调用次数和现有行为保持不变；
- 还原阶段没有题目、参考答案、rubric 或参考图片；
- 评分阶段没有学生原图；
- 清晰正确答案由后端重算满分；
- 错误答案按评分点获得部分分；
- 模糊关键数字强制 `needs_review`；
- OCR 失败时不调用任何 GPT；
- 还原失败时不调用评分；
- 评分失败时不生成可提交结果；
- OCR 原始 JSONL 完整写入历史记录；
- 小题历史重判重新执行 OCR 且保留原结果。

不要让单元测试访问真实 PaddleOCR 或真实模型服务。

## 8. 验证顺序

完成代码后按风险匹配执行：

```powershell
npx tsc -b
npx tsc -p tsconfig.server.json
npx tsc -p tsconfig.electron.json
npx vitest run server/paddleOcr.test.ts server/historyStore.test.ts server/workflows.test.ts server/gradingEngine.test.ts
npx vitest run
npm run build
```

若没有新的有效 PaddleOCR Token：

- 不执行真实 API 请求；
- 报告“mock 测试通过，真实 PaddleOCR 联调未验证”；
- 不把静态类型检查或 mock 测试描述为真实链路成功。

若用户后来在环境变量中提供了新 Token，可额外使用一张不含隐私的本地测试图执行一次只读 smoke test。真实联调至少要证明：任务提交、轮询完成、JSONL 下载、Markdown 提取；仍不能据此声称网页端自动写分/提交已端到端通过。

## 9. 验收标准

全部满足才可报告完成：

- 新建评分标准页面能选择大题/小题，并保存到真实模板数据。
- 旧模板无需人工迁移即可显示为大题且继续正常批改。
- 大题的模型调用顺序、计分结果和现有测试不回归。
- 小题真实入口只走独立 OCR/还原/评分链路。
- 第一阶段确实没有标准答案和评分标准信息。
- 第二阶段确实没有学生原图。
- OCR 原始 JSONL 能从保存的历史记录中查到，不只剩 Markdown。
- 模糊、涂改不明和关键数字不明均进入人工复核。
- OCR/模型故障不会产生可自动提交的猜测分数。
- 后端仍是总分权威，模型总分不被采用。
- 防串卷 `pageKey/pageToken/imageHash` 和网页写分安全逻辑未被绕过。
- 相关类型检查、核心测试和全量测试通过；未执行的真实外部联调明确列出。

## 10. 交付回复格式

完成后只需简要报告：

1. 修改了哪些模块以及最终数据流；
2. 执行了哪些类型检查、测试和构建，给出真实结果；
3. 是否完成真实 PaddleOCR 联调；
4. 仍存在的限制或未验证事项；
5. 明确声明未提交/未推送 Git（除非用户另有要求）。

不要仅汇报“代码已写完”；必须以测试结果和实际调用边界作为证据。
