import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { decodeSafeLatexTokens } from "../shared/formulaProtocol";
import { systemLogScopeLabels } from "../shared/uiConstants";
import type { ModelCallHistoryEntry, ModelCallLogDetails, SystemLogEntry } from "../shared/types";
import { MathText } from "./Formula";

type JsonRecord = Record<string, unknown>;

const MODEL_STEP_LABELS: Record<string, string> = {
  rubric_structure_vision: "评分标准识别",
  rubric_structure_text: "评分标准识别",
  rubric_refinement: "评分标准完善",
  large_question_answer_triage: "大题答案核验",
  large_question_responses_agent: "大题视觉批改",
  large_question_visual_review: "整页视觉复核",
  large_question_point_review: "评分点审验",
  small_question_reconstruction: "小题作答还原",
  small_question_grading_vision: "小题视觉评分",
  small_question_grading_text: "小题文字评分",
  legacy_direct_visual_grading: "视觉批改",
  legacy_evidence_extraction: "证据提取",
  legacy_final_answer: "最终答案判定",
  legacy_process_review: "过程审验",
  legacy_unreadable_review: "不可读复核",
  legacy_numeric_review: "数值复核"
};

const LOG_DETAIL_LABELS: Record<string, string> = {
  reason: "原因",
  error: "错误",
  previousStep: "上一阶段",
  label: "任务",
  questionType: "题型",
  provider: "服务",
  model: "模型",
  routeKey: "链路",
  gradingMode: "批改模式",
  largeQuestionWorkflow: "大题流程",
  imageCount: "图片",
  questionImages: "题目图",
  referenceImages: "参考图",
  studentImages: "答卷图",
  cropImageCount: "局部图",
  blockCount: "区块",
  verifiedBlockCount: "已核验区块",
  lineCount: "转录行",
  lines: "转录行",
  answers: "答案数",
  correct: "正确",
  incorrect: "不一致",
  uncertain: "不确定",
  decisions: "评分点",
  deductions: "扣分项",
  reviewReasons: "复核原因",
  localReviewItems: "视觉复核项",
  pointReviewTargets: "小分审验小问",
  score: "得分",
  maxScore: "满分",
  modelCalls: "模型调用",
  durationMs: "耗时",
  count: "数量",
  source: "来源",
  mode: "模式",
  workflow: "流程",
  gradingPipeline: "批改链路",
  recordCount: "记录",
  subquestionCount: "小问"
};

const LOG_DETAIL_KEYS = Object.keys(LOG_DETAIL_LABELS);
const MAX_RESULT_PREVIEW_ITEMS = 12;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function stringField(value: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const text = scalarText(value[key]);
    if (text?.trim()) return text;
  }
  return "";
}

function numberField(value: JsonRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key] as number;
  }
  return undefined;
}

function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json|JSON)?\s*/, "").replace(/\s*```$/, "").trim();
}

function jsonSegments(value: string): string[] {
  const segments: string[] = [];
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{" && value[start] !== "[") continue;
    const opening = value[start];
    const closing = opening === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = start; cursor < value.length; cursor += 1) {
      const character = value[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === opening) depth += 1;
      else if (character === closing) {
        depth -= 1;
        if (depth === 0) {
          segments.push(value.slice(start, cursor + 1));
          break;
        }
      }
    }
  }
  return segments;
}

function parseJsonText(value: string): unknown | null {
  const candidates = [stripCodeFence(value), ...jsonSegments(value)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // The provider may wrap the JSON in a short prose or markdown prefix.
    }
  }
  return null;
}

function collectResponseText(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResponseText(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ["text", "output_text"]) {
    if (typeof value[key] === "string") output.push(value[key] as string);
  }
  for (const key of ["content", "message", "output"]) {
    if (value[key] !== undefined) collectResponseText(value[key], output);
  }
}

function responseTextCandidates(details: ModelCallLogDetails): string[] {
  const candidates: string[] = [];
  if (details.response?.content) candidates.push(details.response.content);
  if (details.response?.raw) {
    const parsed = parseJsonText(details.response.raw);
    const extracted: string[] = [];
    if (isRecord(parsed)) {
      if (Array.isArray(parsed.choices)) {
        for (const choice of parsed.choices) collectResponseText(choice, extracted);
      }
      collectResponseText(parsed.output_text, extracted);
      collectResponseText(parsed.output, extracted);
    }
    candidates.push(...extracted, details.response.raw);
  }
  return [...new Set(candidates)];
}

/** Extracts the provider's structured result without exposing its transport envelope. */
export function extractStructuredModelResult(details: ModelCallLogDetails): unknown | null {
  for (const candidate of responseTextCandidates(details)) {
    const parsed = parseJsonText(candidate);
    if (parsed === null) continue;
    if (isRecord(parsed) && (Array.isArray(parsed.choices) || Array.isArray(parsed.output))) continue;
    return decodeSafeLatexTokens(parsed);
  }
  return null;
}

function formatLogDetailValue(value: unknown, key?: string): string | null {
  if (typeof value === "boolean") return value ? "是" : "否";
  const scalar = scalarText(value);
  if (scalar !== null) {
    if (key === "routeKey") return MODEL_STEP_LABELS[scalar] ?? scalar.replace(/[_-]+/g, " ");
    if (key === "questionType") return scalar === "small" ? "小题" : scalar === "large" ? "大题" : scalar;
    if (key === "largeQuestionWorkflow") return scalar === "responses_agent" ? "Responses Agent" : scalar === "staged" ? "稳定分阶段" : scalar;
    if (key === "gradingMode") return scalar === "vision_direct" ? "视觉直批" : scalar;
    return scalar;
  }
  if (!Array.isArray(value)) return null;
  const items = value.map(scalarText).filter((item): item is string => item !== null && item.trim().length > 0);
  if (!items.length) return null;
  return items.length > 8 ? `${items.slice(0, 8).join("、")} 等 ${items.length} 项` : items.join("、");
}

export function logScopeLabel(scope: SystemLogEntry["scope"]): string {
  return systemLogScopeLabels[scope] ?? scope;
}

export function logStatusLabel(status: SystemLogEntry["status"]): string {
  const labels: Record<SystemLogEntry["status"], string> = {
    started: "开始",
    progress: "进行中",
    completed: "完成",
    failed: "失败"
  };
  return labels[status];
}

function displayableLogDetails(details?: Record<string, unknown>): Array<{ key: string; label: string; value: string }> {
  if (!details) return [];
  return LOG_DETAIL_KEYS.flatMap((key) => {
    const value = formatLogDetailValue(details[key], key);
    return value === null || !value.trim() ? [] : [{ key, label: LOG_DETAIL_LABELS[key], value }];
  });
}

export function LogDetailsSummary({ details }: { details?: Record<string, unknown> }) {
  const fields = displayableLogDetails(details);
  if (!fields.length) return null;
  return <div className="log-detail-summary">
    {fields.map((field) => <div className="log-detail-chip" key={field.key}>
      <span>{field.label}</span>
      <MathText value={field.value} formulaByDefault />
    </div>)}
  </div>;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    correct: "正确",
    incorrect: "不一致",
    missing: "未作答",
    uncertain: "不确定",
    satisfied: "满足",
    not_satisfied: "未满足",
    not_present: "未发现",
    unreadable: "不可读",
    insufficient_evidence: "证据不足",
    clear: "清晰",
    review: "待复核",
    completed: "完成",
    failed: "失败",
    agree: "一致",
    conflict: "有冲突"
  };
  return labels[status] ?? status;
}

function statusClass(status: string): string {
  return status.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function ResultValue({ value }: { value: unknown }) {
  const text = scalarText(value);
  if (text === null || !text.trim()) return null;
  return <MathText value={text} formulaByDefault />;
}

function ResultField({ label, value }: { label: string; value: unknown }) {
  const text = scalarText(value);
  if (text === null || !text.trim()) return null;
  return <div className="model-result-field"><span>{label}</span><div><ResultValue value={text} /></div></div>;
}

function ResultItem({ item, kind }: { item: JsonRecord; kind: "answer" | "decision" | "review" | "deduction" }) {
  const id = stringField(item, "subquestionId", "pointId", "pointKey", "ruleId", "reviewId", "review_id", "id") || "结果";
  const status = stringField(item, "status", "certainty", "verdict");
  const awardedScore = numberField(item, "awardedScore", "score", "deductedScore");
  const maxScore = numberField(item, "maxScore");
  const scoreText = awardedScore !== undefined
    ? maxScore !== undefined ? `${awardedScore}/${maxScore} 分` : `${awardedScore} 分`
    : "";
  const title = kind === "answer" ? `小问 ${id}` : kind === "decision" ? `评分点 ${id}` : id;
  return <article className={`model-result-item ${status ? statusClass(status) : ""}`}>
    <header><strong>{title}</strong>{status && <span className={`model-result-status ${statusClass(status)}`}>{statusLabel(status)}</span>}{scoreText && <b>{scoreText}</b>}{typeof item.confidence === "number" && <small>置信度 {Math.round(item.confidence * 100)}%</small>}</header>
    <div className="model-result-fields">
      {kind === "answer" && <>
        <ResultField label="学生答案" value={item.studentAnswer} />
        <ResultField label="参考答案" value={item.referenceAnswer} />
      </>}
      {kind === "review" && <ResultField label="复核结果" value={item.result} />}
      <ResultField label="卷面证据" value={item.evidenceQuote} />
      <ResultField label="说明" value={item.reason} />
    </div>
  </article>;
}

function ResultSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <section className="model-result-section"><div className="model-result-section-heading"><strong>{title}</strong><span>{count} 项</span></div>{children}</section>;
}

function LimitedResultList({ items, render }: { items: JsonRecord[]; render: (item: JsonRecord, index: number) => ReactNode }) {
  const visible = items.slice(0, MAX_RESULT_PREVIEW_ITEMS);
  const remaining = items.slice(MAX_RESULT_PREVIEW_ITEMS);
  return <>
    {visible.map((item, index) => <div key={index}>{render(item, index)}</div>)}
    {remaining.length > 0 && <details className="model-result-more"><summary>查看其余 {remaining.length} 项</summary>{remaining.map((item, index) => <div key={index}>{render(item, index + visible.length)}</div>)}</details>}
  </>;
}

function transcriptionLines(result: JsonRecord): JsonRecord[] {
  const transcription = isRecord(result.transcription) ? result.transcription : undefined;
  if (recordArray(transcription?.lines).length > 0) return recordArray(transcription?.lines);
  if (recordArray(result.lines).length > 0) return recordArray(result.lines);
  const evidence = isRecord(result.evidence) ? result.evidence : undefined;
  return recordArray(evidence?.lines);
}

function transcriptionLineView(line: JsonRecord, index: number) {
  const text = stringField(line, "latex", "text") || "[空白]";
  const id = stringField(line, "id", "blockId") || `行 ${index + 1}`;
  const status = stringField(line, "status");
  return <article className={`model-transcription-line ${status ? statusClass(status) : ""}`}>
    <span>{id}</span><div><MathText value={text} formulaByDefault /></div>{status && <small>{statusLabel(status)}</small>}
  </article>;
}

function overviewFields(result: JsonRecord): Array<{ label: string; value: string }> {
  const fields: Array<{ key: string; label: string }> = [
    { key: "title", label: "标题" },
    { key: "questionType", label: "题型" },
    { key: "totalScore", label: "总分" },
    { key: "status", label: "状态" }
  ];
  return fields.flatMap(({ key, label }) => {
    const value = scalarText(result[key]);
    return value?.trim() ? [{ label, value }] : [];
  }).concat(
    typeof result.review_required === "boolean"
      ? [{ label: "复核", value: result.review_required ? "需要复核" : "无需复核" }]
      : []
  );
}

function nestedRecords(items: JsonRecord[], key: string): JsonRecord[] {
  return items.flatMap((item) => recordArray(item[key]));
}

function compactPointDecisions(result: JsonRecord): JsonRecord[] {
  const pointJudgements = isRecord(result.pointJudgements) ? result.pointJudgements : undefined;
  if (!pointJudgements) return [];
  const satisfied = recordArray(pointJudgements.satisfied).map((item) => ({ ...item, pointId: item.pointKey ?? item.pointId, status: "satisfied" }));
  const notSatisfied = recordArray(pointJudgements.notSatisfied).map((item) => ({ ...item, pointId: item.pointKey ?? item.pointId, status: "not_satisfied" }));
  const unreadable = recordArray(pointJudgements.unreadable).map((item) => ({ ...item, pointId: item.pointKey ?? item.pointId, status: "unreadable" }));
  const notPresent = Array.isArray(pointJudgements.notPresent)
    ? pointJudgements.notPresent.map((item) => ({ pointId: scalarText(item) ?? "结果", status: "not_present" }))
    : [];
  return [...satisfied, ...notSatisfied, ...notPresent, ...unreadable];
}

function resultReviewItems(result: JsonRecord): JsonRecord[] {
  return recordArray(result.review_items ?? result.reviewItems);
}

function resultDeductions(result: JsonRecord, reviews: JsonRecord[]): JsonRecord[] {
  return [...recordArray(result.appliedDeductions), ...nestedRecords(reviews, "appliedDeductions")];
}

function resultDecisions(result: JsonRecord, reviews: JsonRecord[]): JsonRecord[] {
  const direct = recordArray(result.decisions);
  if (direct.length) return direct;
  const nested = nestedRecords(reviews, "decisions");
  return nested.length ? nested : compactPointDecisions(result);
}

export function ModelResultSummary({ result }: { result: unknown }) {
  if (!isRecord(result)) {
    const text = scalarText(result);
    return <div className="model-result-summary"><p className="model-result-empty">{text || "未提取到可展示的结构化结果"}</p></div>;
  }
  const finalAnswerJudgements = recordArray(result.finalAnswerJudgements);
  const answers = finalAnswerJudgements.length ? finalAnswerJudgements : recordArray(result.answers);
  const reviews = recordArray(result.reviews);
  const decisions = resultDecisions(result, reviews);
  const deductions = resultDeductions(result, reviews);
  const lines = transcriptionLines(result);
  const reviewItems = resultReviewItems(result);
  const reviewResults = reviews.filter((item) => Boolean(stringField(item, "result", "certainty")));
  const rawBasis = result.final_basis ?? result.finalBasis;
  const basis = Array.isArray(rawBasis)
    ? rawBasis.map((item: unknown) => scalarText(item)).filter((item): item is string => Boolean(item?.trim()))
    : [];
  const overview = overviewFields(result);
  const hasSections = overview.length > 0 || answers.length > 0 || decisions.length > 0 || deductions.length > 0 || reviewResults.length > 0 || lines.length > 0 || reviewItems.length > 0 || basis.length > 0;
  return <div className="model-result-summary">
    {overview.length > 0 && <div className="model-result-overview">{overview.map((field) => <div key={field.label}><span>{field.label}</span><ResultValue value={field.value} /></div>)}</div>}
    {answers.length > 0 && <ResultSection title="最终答案判断" count={answers.length}><LimitedResultList items={answers} render={(item) => <ResultItem item={item} kind="answer" />} /></ResultSection>}
    {decisions.length > 0 && <ResultSection title="评分点判定" count={decisions.length}><LimitedResultList items={decisions} render={(item) => <ResultItem item={item} kind="decision" />} /></ResultSection>}
    {deductions.length > 0 && <ResultSection title="扣分记录" count={deductions.length}><LimitedResultList items={deductions} render={(item) => <ResultItem item={item} kind="deduction" />} /></ResultSection>}
    {reviewResults.length > 0 && <ResultSection title="视觉复核结果" count={reviewResults.length}><LimitedResultList items={reviewResults} render={(item) => <ResultItem item={item} kind="review" />} /></ResultSection>}
    {reviewItems.length > 0 && <ResultSection title="复核事项" count={reviewItems.length}><LimitedResultList items={reviewItems} render={(item) => <ResultItem item={item} kind="review" />} /></ResultSection>}
    {basis.length > 0 && <ResultSection title="最终采用依据" count={basis.length}><ul className="model-result-basis">{basis.map((item, index) => <li key={index}><MathText value={item} formulaByDefault /></li>)}</ul></ResultSection>}
    {lines.length > 0 && <ResultSection title="卷面转录" count={lines.length}><LimitedResultList items={lines} render={transcriptionLineView} /></ResultSection>}
    {!hasSections && <p className="model-result-empty">已收到结构化返回，但没有可展示的摘要字段；原始内容仍保留在技术信息中。</p>}
  </div>;
}

function modelStepLabel(details: ModelCallLogDetails): string {
  return MODEL_STEP_LABELS[details.routeKey ?? ""] ?? MODEL_STEP_LABELS[details.schemaName] ?? details.schemaName.replace(/[_-]+/g, " ");
}

function modelOutputLabel(details: ModelCallLogDetails): string {
  if (details.outputMode.startsWith("responses")) return "Responses";
  return details.request.responseFormat ? "严格结构化" : "结构化";
}

function TechnicalDetails({ details }: { details: ModelCallLogDetails }) {
  const response = details.response;
  return <details className="model-call-technical">
    <summary>查看技术信息（Prompt 与原始响应）</summary>
    <div className="model-call-technical-note">日志默认只展示已提取的有效结果；原始调用仍保留用于审计，严格 JSON Schema 框架不在此处展开。</div>
    <div className="model-call-payload-grid">
      <div className="model-call-payload"><strong>System Prompt</strong><pre>{details.request.systemPrompt}</pre></div>
      <div className="model-call-payload"><strong>User Prompt</strong><pre>{details.request.userPrompt}</pre></div>
    </div>
    <div className="model-call-payload"><strong>模型原始 HTTP 返回</strong><pre>{response?.raw || "请求未收到 HTTP 响应。"}</pre></div>
    {response?.content && <div className="model-call-payload"><strong>提取出的模型正文</strong><pre>{response.content}</pre></div>}
  </details>;
}

export function ModelCallDetails({ details, compact = false }: { details: ModelCallLogDetails; compact?: boolean }) {
  const result = extractStructuredModelResult(details);
  const response = details.response;
  return <div className={`model-call-details ${compact ? "compact" : ""}`}>
    <div className="model-call-meta">
      {details.callId && <span>调用：<b>{details.callId.slice(0, 8)}</b></span>}
      <span>阶段：<b>{modelStepLabel(details)}</b></span>
      <span>模型：<b>{details.model}</b></span>
      <span>协议：<b>{modelOutputLabel(details)}</b></span>
      {details.durationMs !== undefined && <span>耗时：<b>{details.durationMs} ms</b></span>}
      {response && <span>HTTP：<b>{response.status}</b></span>}
      {details.request.images.length > 0 && <span>输入图：<b>{details.request.images.length} 张</b></span>}
      {(details.attempt > 1 || details.maxAttempts > 1) && <span>尝试：<b>{details.attempt}/{details.maxAttempts}</b></span>}
      {details.errorClass && <span>失败分类：<b>{details.errorClass}</b></span>}
      {details.usage && <span>Token：<b>{[details.usage.promptTokens !== undefined ? `入 ${details.usage.promptTokens}` : "", details.usage.completionTokens !== undefined ? `出 ${details.usage.completionTokens}` : "", details.usage.reasoningTokens !== undefined ? `推理 ${details.usage.reasoningTokens}` : ""].filter(Boolean).join(" / ")}</b></span>}
    </div>
    {details.error && <div className="model-call-error"><AlertTriangle size={14} />{details.error}</div>}
    <ModelResultSummary result={result} />
    <TechnicalDetails details={details} />
  </div>;
}

export function ModelCallHistory({ calls }: { calls: ModelCallHistoryEntry[] }) {
  return <section className="model-call-history">
    <div className="model-call-history-heading"><div><strong>本题模型调用摘要</strong></div><span>{calls.length} 次 · 原始内容已保留</span></div>
    {calls.length > 0 ? calls.map((call, index) => <article key={call.id} className={`model-call-history-entry ${call.level}`}>
      <div><span>调用 {index + 1}</span><strong>{call.message}</strong><small>{new Date(call.timestamp).toLocaleString("zh-CN", { hour12: false })} · {modelStepLabel(call.details)}</small></div>
      <ModelCallDetails details={call.details} />
    </article>) : <div className="model-call-history-empty">该历史记录创建时尚未保存模型调用原始数据。</div>}
  </section>;
}
