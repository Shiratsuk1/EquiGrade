import { useEffect, useState } from "react";
import { MathText } from "./Formula";
import { ScorePointGuidance } from "./ScorePointGuidance";
import { authorizedFetch } from "./api";

type PipelineEvent = {
  type?: string;
  timestamp?: string;
  score?: number;
  maxScore?: number;
  reason?: string;
  pageKey?: string;
  sourcePageKey?: string;
  consecutiveFailures?: number;
};

type PipelineBridge = {
  getTemplateContext?: () => Promise<TemplateContext>;
  getPipelineEvents?: () => Promise<PipelineEvent[]>;
  onPipelineEvent?: (callback: (event: PipelineEvent) => void) => () => void;
};

type TemplateContext = {
  title?: string;
  questionText?: string;
  rubric?: {
    title?: string;
    totalScore?: number;
    subquestions?: Array<{
      id: string;
      title: string;
      maxScore: number;
      scorePoints?: Array<{ id: string; title: string; description: string; score: number; expected: string; commonResponses?: string[]; alternativeMethods?: string[]; acceptedEquivalents?: string[] }>;
    }>;
  };
};

type ConsoleState = {
  state: "idle" | "running" | "paused" | "completed";
  processed: number;
  failed: number;
  consecutiveFailures: number;
  current: string;
  message: string;
  lastScore: string;
  events: PipelineEvent[];
};

const initialState: ConsoleState = {
  state: "idle",
  processed: 0,
  failed: 0,
  consecutiveFailures: 0,
  current: "等待答卷",
  message: "可在右侧目标页启动自动批改",
  lastScore: "-- / --",
  events: []
};

function eventLabel(event: PipelineEvent) {
  switch (event.type) {
    case "pipeline_started": return "流水线已启动";
    case "image_extracted": return `已提取答卷 ${event.sourcePageKey || event.pageKey || "当前页"}`;
    case "page_completed": return `已提交 ${event.score ?? "--"} / ${event.maxScore ?? "--"}`;
    case "page_failed": return `答卷失败：${event.reason || "未知原因"}`;
    case "pipeline_completed": return "本批次已完成";
    case "pipeline_completed_after_skip": return "跳过异常答卷后批次完成";
    case "pipeline_paused": return `流水线已暂停：${event.reason || "需要处理异常"}`;
    case "pipeline_paused_stale_answer": return "流水线已暂停：检测到模型等待期间答卷发生切换";
    default: return event.type || "流水线事件";
  }
}

function applyEvent(previous: ConsoleState, event: PipelineEvent): ConsoleState {
  const next: ConsoleState = {
    ...previous,
    events: [...previous.events, event].slice(-8)
  };
  switch (event.type) {
    case "pipeline_started":
      return { ...initialState, state: "running", message: "正在处理当前答卷", events: [event] };
    case "image_extracted":
      return { ...next, state: "running", current: event.sourcePageKey || event.pageKey || "当前答卷", message: "答卷图片已提取，正在请求教师模型" };
    case "page_completed":
      return { ...next, state: "running", processed: previous.processed + 1, consecutiveFailures: 0, current: event.sourcePageKey || event.pageKey || "当前答卷", lastScore: `${event.score ?? "--"} / ${event.maxScore ?? "--"}`, message: "分数已写入并提交，正在进入下一份" };
    case "page_failed":
      return { ...next, state: "running", failed: previous.failed + 1, consecutiveFailures: event.consecutiveFailures ?? previous.consecutiveFailures + 1, current: event.sourcePageKey || event.pageKey || "当前答卷", message: event.reason || "当前答卷失败，正在跳过" };
    case "pipeline_completed":
    case "pipeline_completed_after_skip":
      return { ...next, state: "completed", current: "本批次答卷", message: event.type === "pipeline_completed_after_skip" ? "跳过异常答卷后，本批次已完成" : "本批次答卷已全部提交" };
    case "pipeline_paused":
      return { ...next, state: "paused", consecutiveFailures: event.consecutiveFailures ?? previous.consecutiveFailures, message: event.reason || "流水线已暂停" };
    case "pipeline_paused_stale_answer":
      return { ...next, state: "paused", message: "检测到模型等待期间答卷发生切换，已停止写分" };
    default:
      return next;
  }
}

function restoreEvents(events: PipelineEvent[]) {
  return events.reduce(applyEvent, initialState);
}

function bridge(): PipelineBridge | undefined {
  return (window as Window & { electronHost?: PipelineBridge }).electronHost;
}

async function loadTemplateContext(host: PipelineBridge) {
  const fetchTemplate = async () => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);
    try {
      // Keep the fallback same-origin: Vite proxies /api in development and the
      // packaged app serves the API from the same local origin.
      const response = await authorizedFetch("/api/pipeline/fixture", { signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `评分模板接口返回 ${response.status}`);
      return body as TemplateContext;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("评分模板接口连接超时，请确认本地 API 8788 正在运行");
      }
      throw error instanceof Error ? error : new Error("评分模板接口连接失败");
    } finally {
      window.clearTimeout(timeoutId);
    }
  };
  const request = host.getTemplateContext ? host.getTemplateContext() : fetchTemplate();
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("评分模板读取超时，请确认本地 API 8788 正在运行")), 8000);
  });
  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    // A stale or unavailable preload bridge should not leave the console loading forever.
    if (host.getTemplateContext) return await fetchTemplate();
    throw error;
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

export default function ElectronPipelineConsole() {
  const [summary, setSummary] = useState<ConsoleState>(initialState);
  const [template, setTemplate] = useState<TemplateContext | null>(null);
  const [templateError, setTemplateError] = useState("");

  useEffect(() => {
    const host = bridge();
    const onEvent = (event: PipelineEvent) => setSummary((previous) => applyEvent(previous, event));
    const unsubscribe = host?.onPipelineEvent?.(onEvent);
    void host?.getPipelineEvents?.().then((events) => setSummary(restoreEvents(events)));
    void loadTemplateContext(host || {}).then(setTemplate).catch((error: unknown) => {
      setTemplateError(error instanceof Error ? error.message : "评分模板读取失败");
    });
    return unsubscribe;
  }, []);

  const stateLabel = summary.state === "running" ? "运行中" : summary.state === "paused" ? "已暂停" : summary.state === "completed" ? "已完成" : "待机";
  return (
    <main className="electron-console" aria-label="Electron 自动改卷流水线控制台">
      <header className="electron-console-header">
        <div>
          <p className="electron-console-kicker">衡准 · 本地工作台</p>
          <h1>自动改卷工作台</h1>
          <p className="electron-console-subtitle">Electron 流水线控制台</p>
        </div>
        <span className="electron-console-badge">本机运行</span>
      </header>

      <section className="electron-console-panel electron-console-template-panel">
        <div className="electron-console-section-heading"><div><span className="electron-console-index">01</span><div><h2>当前批改模板</h2><p>{template?.title || "正在读取评分标准"}</p></div></div><span className="electron-console-template-score">满分 {template?.rubric?.totalScore ?? "--"}</span></div>
        {templateError ? <p className="electron-console-load-error">{templateError}</p> : template ? <div className="electron-console-template-content">
          <div className="electron-console-material"><h3>题目原文</h3><div className="electron-console-question"><MathText value={template.questionText || "暂无题目原文"} formulaByDefault /></div></div>
          <div className="electron-console-material"><h3>评分标准</h3><div className="electron-console-rubric-list">
            {(template.rubric?.subquestions || []).map((question) => <details key={question.id} open><summary><strong>{question.id} {question.title}</strong><span>{question.maxScore} 分</span></summary><ol>{(question.scorePoints || []).map((point) => <li key={point.id}><div><b>{point.id}</b><span>{point.title}</span></div><MathText value={point.description || point.expected} formulaByDefault /><ScorePointGuidance point={point} /><em>{point.score} 分</em></li>)}</ol></details>)}
          </div></div>
        </div> : <div className="electron-console-template-loading">正在读取题目与评分标准…</div>}
      </section>

      <section className="electron-console-panel electron-console-status-panel">
        <div className="electron-console-section-heading">
          <div><span className="electron-console-index">02</span><div><h2>运行状态</h2><p>实时接收右侧目标页的流水线事件。</p></div></div>
          <span className="electron-console-state">{stateLabel}</span>
        </div>
        <div className="electron-console-status">
          <span className={`electron-console-status-dot ${summary.state}`} />
          <div><strong>{summary.current}</strong><p>{summary.message}</p></div>
        </div>
        <div className="electron-console-live-grid">
          <article><span>已提交</span><strong>{summary.processed}</strong></article>
          <article><span>失败/跳过</span><strong>{summary.failed}</strong></article>
          <article><span>最近得分</span><strong>{summary.lastScore}</strong></article>
        </div>
      </section>

      <section className="electron-console-panel">
        <div className="electron-console-section-heading"><div><span className="electron-console-index">03</span><div><h2>流水线范围</h2><p>当前 Electron 会话使用固定的本地测试入口。</p></div></div></div>
        <div className="electron-console-lock"><span className="electron-console-lock-mark">测试</span><div><strong>内置评分标准仅用于流水线测试</strong><p>目标页：右侧嵌入的 `/zhixue-mock` 智学网专用模拟阅卷页面。</p></div></div>
        <p className="electron-console-note">右侧页面保留现有目标页悬浮控件；跳过、异常记录和连续三次失败暂停仍由目标页脚本负责。</p>
      </section>

      <section className="electron-console-panel electron-console-activity-panel">
        <div className="electron-console-section-heading"><div><span className="electron-console-index">04</span><div><h2>最新动态</h2><p>仅显示本次会话摘要，完整日志请打开日志页。</p></div></div></div>
        <ol className="electron-console-activity-list">
          {summary.events.length === 0 ? <li>等待右侧目标页加载并启动流水线</li> : summary.events.slice().reverse().map((event, index) => <li key={`${event.timestamp || "event"}-${index}`}>{eventLabel(event)}</li>)}
        </ol>
      </section>

      <section className="electron-console-panel electron-console-links-panel">
        <div className="electron-console-section-heading"><div><span className="electron-console-index">05</span><div><h2>完整记录</h2><p>历史结果和运行日志在本地网页端查看。</p></div></div></div>
        <nav className="electron-console-links" aria-label="结果查看入口">
          <a href="http://localhost:5173/history" target="_blank" rel="noreferrer">打开历史记录</a>
          <a href="http://localhost:5173/logs" target="_blank" rel="noreferrer">打开运行日志</a>
        </nav>
      </section>
    </main>
  );
}
