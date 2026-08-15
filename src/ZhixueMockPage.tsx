import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

type ZhixueMockCase = {
  id: string;
  studentId: string;
  label: string;
  questionLabel: string;
  maxScore: number;
  lines: string[];
  imageDataUrl?: string;
};

type ImportedCase = Partial<ZhixueMockCase> & {
  answerLines?: unknown;
  image?: unknown;
};

const DEFAULT_CASES: ZhixueMockCase[] = [
  {
    id: "zx-test-001",
    studentId: "模拟学生 001",
    label: "模拟学生 001",
    questionLabel: "第 16 题 · 竖直圆轨道综合题",
    maxScore: 18,
    lines: [
      "(1) mgh=1/2 mvB²，vB=8.0 m/s",
      "NB-mg=mvB²/R，NB=45 N，方向竖直向下",
      "(2) vC²=vB²-4gR=32 m²/s²",
      "NC+mg=mvC²/R，NC=15 N>0，能通过C点",
      "(3) 临界：NC=0，vC²=gR，hmin=5R/2=2.00 m",
      "(4) v²=2g[h'-R(1-cosθ)]，脱离时 N=0",
      "v²=-gRcosθ，cosθ=-5/6，θ=146.4°，v=2.58 m/s"
    ]
  },
  {
    id: "zx-test-002",
    studentId: "模拟学生 002",
    label: "模拟学生 002",
    questionLabel: "第 16 题 · 竖直圆轨道综合题",
    maxScore: 18,
    lines: [
      "(1) mgh=1/2 mvB²，vB=8.0 m/s",
      "NB-mg=mvB²/R，NB=45 N",
      "(2) vC²=vB²-4gR=32，NC+mg=mvC²/R",
      "NC=15 N>0，能通过C点",
      "(3) 恰好通过时 NC=0，hmin=2.00 m",
      "(4) v²=2g[h'-R(1-cosθ)]，N=0 时 v²=-gRcosθ",
      "cosθ=-2/3，θ=131.8°，v≈2.3 m/s"
    ]
  },
  {
    id: "zx-test-003",
    studentId: "模拟学生 003",
    label: "模拟学生 003",
    questionLabel: "第 16 题 · 竖直圆轨道综合题",
    maxScore: 18,
    lines: [
      "(1) mgh=1/2 mvB²，vB=8 m/s",
      "NB+mg=mvB²/R，NB=35 N",
      "(2) vC²=64-4×10×0.8=48",
      "NC+mg=mvC²/R，NC=25 N，能通过",
      "(3) 临界时 vC=0，mgh=2mgR，hmin=1.6 m",
      "(4) N=0，v²=-gRcosθ",
      "cosθ=-1/2，θ=120°，v=2 m/s"
    ]
  },
  {
    id: "zx-test-004",
    studentId: "模拟学生 004",
    label: "模拟学生 004",
    questionLabel: "第 16 题 · 竖直圆轨道综合题",
    maxScore: 18,
    lines: [
      "(1) W合=ΔEk，mgh=1/2 mvB²，vB=√(2gh)=8.0 m/s",
      "N-mg=mvB²/R=40 N，N=45 N，压力向下",
      "(2) 从A到C：mg(h-2R)=1/2 mvC²，vC²=32",
      "NC+mg=mvC²/R，NC=15 N>0，能通过C点",
      "(3) mghmin=mg·2R+1/2 mgR，hmin=2.00 m",
      "(4) v²=2g[h'-R(1-cosθ)]",
      "脱离条件 v²=-gRcosθ，cosθ=-5/6，θ=146.4°，v=2.58 m/s"
    ]
  }
];

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function generatedImage(testCase: ZhixueMockCase) {
  const rows = testCase.lines.map((line, index) => {
    const y = 270 + index * 145;
    return `<text x="90" y="${y}" font-size="34" font-style="italic">${escapeXml(line)}</text><path d="M88 ${y + 25} C260 ${y + 8} 470 ${y + 32} 790 ${y + 15}" fill="none" stroke="#326b58" stroke-width="3" opacity=".7"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1500" viewBox="0 0 960 1500"><rect width="960" height="1500" fill="#fffdf7"/><rect x="30" y="30" width="900" height="1440" rx="8" fill="#edf6f1"/><path d="M75 190H885M75 360H885M75 530H885M75 700H885M75 870H885M75 1040H885M75 1210H885M75 1380H885" stroke="#d2e0d9" stroke-width="2"/><g fill="#24312b" font-family="Arial,Microsoft YaHei,sans-serif"><text x="78" y="105" font-size="28">高中物理 · ${escapeXml(testCase.questionLabel)}</text><text x="78" y="160" font-size="22">智学网本地模拟答卷 · ${escapeXml(testCase.studentId)}</text>${rows}<text x="78" y="1430" font-size="18" fill="#64756c">仅用于插件控件和图像提取测试</text></g></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function asString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeImportedCase(value: ImportedCase, index: number): ZhixueMockCase {
  const lines = Array.isArray(value.lines)
    ? value.lines.filter((line): line is string => typeof line === "string").map((line) => line.trim()).filter(Boolean)
    : Array.isArray(value.answerLines)
      ? value.answerLines.filter((line): line is string => typeof line === "string").map((line) => line.trim()).filter(Boolean)
      : [];
  const maxScore = Number(value.maxScore);
  const id = asString(value.id, `imported-${String(index + 1).padStart(3, "0")}`);
  const studentId = asString(value.studentId, asString(value.label, `模拟学生 ${String(index + 1).padStart(3, "0")}`));
  return {
    id,
    studentId,
    label: asString(value.label, studentId),
    questionLabel: asString(value.questionLabel, "第 16 题 · 本地导入测试题"),
    maxScore: Number.isFinite(maxScore) && maxScore > 0 ? maxScore : 18,
    lines: lines.length ? lines : ["已导入答卷图片", "请在 JSON 中补充 lines 或 imageDataUrl"],
    imageDataUrl: typeof value.imageDataUrl === "string" && value.imageDataUrl.startsWith("data:image/")
      ? value.imageDataUrl
      : typeof value.image === "string" && value.image.startsWith("data:image/")
        ? value.image
        : undefined
  };
}

function parseImportedCases(value: unknown) {
  const source = Array.isArray(value) ? value : (value && typeof value === "object" && Array.isArray((value as { cases?: unknown }).cases) ? (value as { cases: unknown[] }).cases : []);
  const cases = source.filter((item): item is ImportedCase => Boolean(item && typeof item === "object")).map(normalizeImportedCase);
  if (!cases.length) throw new Error("测试用例文件中没有可用的 cases 数组");
  return cases;
}

function downloadCases(cases: ZhixueMockCase[]) {
  const payload = JSON.stringify({ version: 1, site: "zhixue-mock", cases }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "zhixue-mock-test-cases.json";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

export default function ZhixueMockPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "智学网 · 个人阅卷（本地模拟）";
    return () => { document.title = previousTitle; };
  }, []);
  const [cases, setCases] = useState<ZhixueMockCase[]>(DEFAULT_CASES);
  const [index, setIndex] = useState(0);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<string[]>([]);
  const [autoSubmit, setAutoSubmit] = useState(false);
  const [importMessage, setImportMessage] = useState("内置 4 份测试答卷");
  const [batchComplete, setBatchComplete] = useState(false);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const current = cases[index] ?? cases[0];
  const currentScore = current ? scores[current.id] ?? "" : "";
  const currentSubmitted = Boolean(current && submitted.has(current.id));
  const imageUrl = useMemo(() => current?.imageDataUrl || (current ? generatedImage(current) : ""), [current]);
  const progressText = `初评已阅量 ${submitted.size} / 任务量 ${cases.length}`;

  const addEvent = (message: string) => setEvents((previous) => [message, ...previous].slice(0, 8));
  const showToast = (text: string) => {
    setToast({ key: Date.now(), text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };
  const selectCase = (nextIndex: number) => {
    if (!cases.length) return;
    const safeIndex = Math.max(0, Math.min(cases.length - 1, nextIndex));
    setIndex(safeIndex);
    setBatchComplete(false);
    addEvent(`已切换到 ${cases[safeIndex].label}`);
  };
  const saveScore = () => {
    if (!current || !currentScore.trim()) return;
    if (autoSubmit) {
      addEvent("自动提交已开启，模拟页面拒绝手动保存");
      return;
    }
    setSubmitted((previous) => new Set(previous).add(current.id));
    showToast("保存成功");
    addEvent(`${current.label} 保存成功 · ${currentScore} 分`);
  };
  const onImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const parsed = parseImportedCases(JSON.parse(await file.text()));
      setCases(parsed);
      setIndex(0);
      setScores({});
      setSubmitted(new Set());
      setBatchComplete(false);
      setImportMessage(`已导入 ${parsed.length} 份测试答卷`);
      setEvents([`已加载测试用例文件：${file.name}`]);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "测试用例导入失败");
    }
  };
  const next = () => {
    if (index >= cases.length - 1) {
      setBatchComplete(true);
      addEvent("任务量已全部完成");
      return;
    }
    selectCase(index + 1);
  };
  const previous = () => selectCase(index - 1);

  if (!current) return <main className="zx-mock-empty">没有可用的本地测试用例。</main>;

  return <div className="zx-mock-shell" data-zx-mock-site data-zx-scenario="local-import">
    {toast && <div className="el-message el-message--success" data-mock-toast key={toast.key}><div className="el-message__content">{toast.text}</div></div>}
    <header className="zx-mock-topbar">
      <div className="zx-mock-brand"><span className="zx-mock-logo">知</span><div><strong>智学网</strong><small>个人阅卷 · 本地模拟站</small></div></div>
      <div className="zx-mock-top-meta"><span>2026 春季物理模拟卷</span><b>模拟账号</b></div>
    </header>
    <div className="zx-mock-toolbar"><span className="zx-mock-breadcrumb">在线阅卷 / 个人阅卷 / {current.questionLabel}</span><span className="zx-mock-safety">本地测试数据，不连接真实智学网</span></div>
    <div className="zx-mock-layout">
      <aside className="zx-mock-sidebar">
        <div className="zx-mock-sidebar-title"><span>批改任务</span><strong>竖直圆轨道综合题</strong></div>
        <div className="zx-mock-progress"><div><span className="nvatool">{batchComplete ? `任务量已全部完成 · ${progressText}` : progressText}</span><b>{Math.round((submitted.size / Math.max(1, cases.length)) * 100)}%</b></div><i><em style={{ width: `${Math.round((submitted.size / Math.max(1, cases.length)) * 100)}%` }} /></i></div>
        <nav className="zx-mock-case-list" aria-label="待批答卷列表">{cases.map((item, itemIndex) => <button key={item.id} className={itemIndex === index ? "active" : ""} onClick={() => selectCase(itemIndex)}><span>{String(itemIndex + 1).padStart(2, "0")}</span><div><strong>{item.label}</strong><small>{submitted.has(item.id) ? "已保存" : "待批改"}</small></div></button>)}</nav>
        <div className="zx-mock-import-box"><strong>测试用例</strong><span>{importMessage}</span><div><button onClick={() => fileRef.current?.click()}>导入 JSON</button><button onClick={() => downloadCases(cases)}>导出</button></div><input ref={fileRef} hidden type="file" accept="application/json,.json" onChange={(event) => void onImport(event)} /></div>
      </aside>
      <main className="zx-mock-main">
        <div className="zx-mock-page-heading"><div><span>当前阅卷页面</span><h1 id="currentTopic">{current.questionLabel}</h1></div><div><b>{index + 1} / {cases.length}</b><small>页面标识由答卷图像和题目生成</small></div></div>
        <div className="zx-mock-workspace">
          <section id="topicImgContent" className="zx-mock-answer" data-page-key={current.id} data-grading-answer-card data-question-title={current.questionLabel}>
            <div className="zx-mock-answer-heading"><div><span>学生答卷原图</span><strong>{current.label}</strong></div><i>原图</i></div>
            <div className="zx-mock-answer-canvas"><div className="score_content"><img className="enhance-definition-bright" data-grading-answer-image src={imageUrl} alt={`${current.label} 作答图片`} /></div></div>
          </section>
          <aside className="zx-mock-score-panel">
            <div className="zx-mock-score-heading"><span>评分操作</span><strong>{currentSubmitted ? "已保存" : "待批改"}</strong></div>
            <div id="scoreareaDiv" className="scorearea">
              <label htmlFor="txt_marking_all">最终总分 <small>满分 {current.maxScore} 分</small></label>
              <div className="zx-mock-score-field"><input id="txt_marking_all" data-grading-score type="number" min="0" max={current.maxScore} value={currentScore} placeholder={`满分 ${current.maxScore} 分`} onChange={(event) => setScores((previous) => ({ ...previous, [current.id]: event.target.value }))} /><span>分</span></div>
              <div className="auto_choose"><button type="button" className={`el-switch ${autoSubmit ? "is-checked" : ""}`} role="switch" aria-checked={autoSubmit} data-auto-submit onClick={() => setAutoSubmit((value) => !value)}><i /></button><span>自动提交</span><small>{autoSubmit ? "开启后模拟页拒绝手动保存" : "关闭"}</small></div>
              <button id="bnt_save" data-grading-submit type="button" disabled={!currentScore.trim() || currentSubmitted || batchComplete} onClick={saveScore}>{currentSubmitted ? "已保存" : "保存分数"}</button>
            </div>
            <div className="zx-mock-page-actions"><a title="上一份" className={index <= 0 ? "unprev" : ""} aria-disabled={index <= 0} href="#previous" onClick={(event) => { event.preventDefault(); if (index > 0) previous(); }}>上一份</a><a title="下一份" data-grading-next className={batchComplete ? "unnext" : ""} aria-disabled={batchComplete} href="#next" onClick={(event) => { event.preventDefault(); if (!batchComplete) next(); }}>下一份</a></div>
            <div className="zx-mock-operation-log"><span>网页操作记录</span>{events.length ? events.map((event, eventIndex) => <p key={`${event}-${eventIndex}`}>{event}</p>) : <p>等待插件或人工操作</p>}</div>
          </aside>
        </div>
        {batchComplete && <div className="zx-mock-complete" data-grading-batch-complete><strong>任务量已全部完成</strong><span>本地模拟站已保留当前页面，方便查看最后一份答卷和操作记录。</span></div>}
      </main>
    </div>
  </div>;
}
