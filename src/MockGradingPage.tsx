import { useMemo, useState } from "react";

type MockAnswer = {
  id: string;
  label: string;
  lines: string[];
  accent: string;
  maxScore?: number;
  kind?: "normal" | "missing-image" | "missing-score" | "missing-submit" | "missing-next";
  crossedOutLines?: number[];
  blurredLines?: number[];
};

const standardAnswers: MockAnswer[] = [
  {
    id: "mock-001",
    label: "答卷 001",
    lines: ["mgR = 1/2mv²", "N - mg = mv² / R", "N = 3mg"],
    accent: "#dceee5"
  },
  {
    id: "mock-002",
    label: "答卷 002",
    lines: ["mgR = 1/2mv²", "N - mg = mv² / R", "N = 2mg"],
    accent: "#e8e1f2"
  },
  {
    id: "mock-003",
    label: "答卷 003",
    lines: ["mgR = 1/2mv²", "N - mg = mv² / R", "N = ?mg"],
    accent: "#f5e6cf"
  },
  {
    id: "mock-004",
    label: "答卷 004",
    lines: ["mgR = 1/2mv²", "N - mg = mv² / R", "N = 3mg（方向：向上）"],
    accent: "#dce8f1"
  },
  {
    id: "mock-005",
    label: "答卷 005",
    lines: ["mgR = 1/2mv²", "N - mg = mv² / R", "N = 3mg"],
    accent: "#f0dcdc"
  }
];

const complexAnswers: MockAnswer[] = [
  {
    id: "case-a01", label: "学生 A01 · 替代解法且最终正确", maxScore: 18, accent: "#dceee5", crossedOutLines: [2], blurredLines: [10],
    lines: ["(1) W重 = ΔEk = 1/2 mvB²", "mg×3.20 = 1/2 mvB²，vB=8.0 m/s", "NB + mg = mvB²/R", "NB - mg = mvB²/R = 45 N，压力向下", "(2) mgh = 2mgR + 1/2 mvC²", "vC²=32；NC + mg = mvC²/R", "NC=15 N>0，能通过C点", "(3) NC=0，vC²=gR，hmin=5R/2=2.00m", "(4) v²=2g[h' - R(1-cosθ)]", "N=0，v²=-gRcosθ，cosθ=-5/6", "θ=146.4°，v=2.58 m/s"]
  },
  {
    id: "case-a02", label: "学生 A02 · 符号错误与关键模糊", maxScore: 18, accent: "#f4e7ce", blurredLines: [9, 10],
    lines: ["(1) mgh=1/2 mvB²，vB=8", "NB-mg=mvB²/R，NB=45", "压力向下", "(2) vC²=vB²-4gR=32", "NC - mg = mvC²/R", "NC=25 N，能通过C点", "(3) N=0，vC²=gR，hmin=5R/2=2.00m", "(4) v²=2g[h' - R(1-cosθ)]", "v²=-gRcosθ", "cosθ=-□/6", "θ≈14□.□°，v≈2.□8m/s"]
  },
  {
    id: "case-a03", label: "学生 A03 · 多处错解与大面积涂改", maxScore: 18, accent: "#eee1e5", crossedOutLines: [6, 7], blurredLines: [8, 9],
    lines: ["(1) mgh=1/2 mvB²，vB=8m/s", "NB + mg = mvB²/R，NB=35N", "(2) vC²=64-4×10×0.8=48", "NC+mg=mvC²/R，NC=25N，可通过", "(3) 临界时 vC=0", "mgh=2mgR，hmin=1.6m", "(4) N=0，v²=？", "cosθ=-?/?", "θ=1□□°", "v=□.□□m/s"]
  }
];

const recoveryAnswers: MockAnswer[] = [
  complexAnswers[0],
  { id: "recovery-002", label: "学生 B02 · 图片缺失", lines: [], accent: "#f1e4df", kind: "missing-image" },
  complexAnswers[1],
  { id: "recovery-004", label: "学生 B04 · 评分框异常", lines: ["N = 2mg"], accent: "#f5e6cf", kind: "missing-score" },
  complexAnswers[2]
];

const pauseAnswers: MockAnswer[] = [
  { id: "pause-001", label: "学生 C01 · 图片缺失", lines: [], accent: "#f1e4df", kind: "missing-image" },
  { id: "pause-002", label: "学生 C02 · 评分框缺失", lines: ["N = 2mg"], accent: "#eee4f4", kind: "missing-score" },
  { id: "pause-003", label: "学生 C03 · 提交按钮缺失", lines: ["N = 3mg"], accent: "#e9e5d9", kind: "missing-submit" },
  complexAnswers[0]
];

function answersForScenario(scenario: string) {
  if (scenario === "recovery") return recoveryAnswers;
  if (scenario === "pause") return pauseAnswers;
  if (scenario === "standard") return standardAnswers;
  return complexAnswers;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function answerImage(answer: MockAnswer) {
  const lines = [
    "高中物理 · 竖直圆轨道综合题",
    "竖直圆轨道综合题 · 满分18分",
    ...answer.lines,
    "学生手写答卷模拟图"
  ];
  const answerLineY = answer.lines.map((_line, index) => 270 + index * 112);
  const answerMarkup = answer.lines.map((line, index) => `
    <g ${answer.blurredLines?.includes(index) ? 'filter="url(#softBlur)"' : ""} opacity="${answer.blurredLines?.includes(index) ? ".68" : "1"}">
      <text x="86" y="${answerLineY[index]}" font-size="29" font-style="italic">${escapeXml(line)}</text>
      <path d="M86 ${answerLineY[index] + 25} C210 ${answerLineY[index] + 11} 340 ${answerLineY[index] + 32} 610 ${answerLineY[index] + 17}" fill="none" stroke="#2c6752" stroke-width="3" opacity=".7"/>
    </g>
    ${answer.crossedOutLines?.includes(index) ? `<path d="M72 ${answerLineY[index] - 25} L760 ${answerLineY[index] + 12} M90 ${answerLineY[index] + 10} L720 ${answerLineY[index] - 32}" stroke="#a44d44" stroke-width="5" opacity=".78"/>` : ""}
  `).join("");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="1750" viewBox="0 0 900 1750">
      <defs><filter id="softBlur"><feGaussianBlur stdDeviation="2.4"/></filter></defs>
      <rect width="900" height="1750" fill="#fffdf8"/>
      <rect x="32" y="32" width="836" height="1686" rx="4" fill="${answer.accent}" opacity=".5"/>
      <path d="M70 190H830M70 360H830M70 530H830M70 700H830M70 870H830M70 1040H830M70 1210H830M70 1380H830M70 1550H830" stroke="#d6ded9" stroke-width="2"/>
      <g fill="#25302c" font-family="Arial,Microsoft YaHei,sans-serif">
        <text x="70" y="110" font-size="27">${escapeXml(lines[0])}</text>
        <text x="70" y="170" font-size="22">${escapeXml(lines[1])}</text>
        ${answerMarkup}
        <text x="70" y="1660" font-size="18" fill="#65736c">${escapeXml(lines.at(-1) ?? "")} · ${escapeXml(answer.label)}</text>
      </g>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export default function MockGradingPage() {
  const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "complex";
  const mockAnswers = answersForScenario(scenario);
  const [index, setIndex] = useState(0);
  const [score, setScore] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [batchComplete, setBatchComplete] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const answer = mockAnswers[index];
  const imageUrl = useMemo(() => answerImage(answer), [answer]);
  const scenarioLabel = scenario === "pause" ? "连续失败暂停" : scenario === "recovery" ? "异常跳过恢复" : scenario === "standard" ? "基础五份" : "综合复杂批次";

  const submit = () => {
    if (!score.trim()) return;
    setSubmitted(true);
    setEvents((previous) => [`${answer.label} 已提交 ${score} 分`, ...previous].slice(0, 8));
  };

  const next = () => {
    if (index >= mockAnswers.length - 1) {
      setBatchComplete(true);
      setEvents((previous) => ["本批次已完成", ...previous].slice(0, 8));
      return;
    }
    setIndex((value) => value + 1);
    setScore("");
    setSubmitted(false);
    setEvents((previous) => [`已进入 ${mockAnswers[index + 1].label}`, ...previous].slice(0, 8));
  };

  const previous = () => {
    if (index <= 0) return;
    setIndex((value) => value - 1);
    setScore("");
    setSubmitted(false);
    setEvents((current) => [`已返回 ${mockAnswers[index - 1].label}`, ...current].slice(0, 8));
  };

  if (batchComplete) {
    return <div className="mock-site-shell" data-grading-batch-complete>
      <header className="mock-site-header">
        <div><span className="mock-site-eyebrow">在线阅卷系统 · 测试站点</span><h1>竖直圆轨道综合题</h1></div>
        <span className="mock-site-progress">批次完成 · {scenarioLabel}</span>
      </header>
      <main className="mock-site-complete">
        <strong>本批次答卷已全部提交</strong>
        <span>测试网页等待下一轮加载。</span>
      </main>
    </div>;
  }

  return <div className="mock-site-shell" data-grading-batch-id="vertical-circle-fixture-01">
    <header className="mock-site-header">
      <div>
        <span className="mock-site-eyebrow">在线阅卷系统 · 测试站点</span>
        <h1>竖直圆轨道综合题</h1>
      </div>
      <div className="mock-site-header-meta">
        <span>第 1 题 · 满分 {answer.maxScore ?? 8} 分 · {scenarioLabel}</span>
        <b>{index + 1} / {mockAnswers.length}</b>
      </div>
    </header>
    <div className="mock-site-toolbar">
      <span>阅卷批次：2026 春季物理模拟卷 · {scenarioLabel}</span>
      <label className="mock-scenario-picker">测试场景
        <select value={scenario} onChange={(event) => { window.location.href = `/mock-grading?embedded=1&scenario=${event.target.value}`; }}>
          <option value="complex">综合复杂批次</option>
          <option value="recovery">异常跳过恢复</option>
          <option value="pause">连续失败暂停</option>
          <option value="standard">基础五份</option>
        </select>
      </label>
      <span>当前学生：{answer.label}</span>
      <i className={submitted ? "mock-state submitted" : "mock-state"}>{submitted ? "已提交" : "待批改"}</i>
    </div>
    <main className="mock-site-main">
      <section className="mock-paper" data-grading-answer-card data-page-key={answer.id} data-grading-state={submitted ? "submitted" : "pending"}>
        <div className="mock-paper-heading">
          <div><strong>学生作答图片</strong><span>图片由测试网站提供，网页不包含预设分数</span></div>
          <span className="mock-paper-source">图像阅卷</span>
        </div>
        <div className="mock-image-frame">
          {answer.kind === "missing-image" ? <div className="mock-image-missing">测试场景：该答卷未提供可识别图片</div> : <picture data-grading-answer-media>
            <source type="image/svg+xml" srcSet={imageUrl} />
            <img data-grading-answer-image src={imageUrl} alt={`${answer.label} 学生作答图片`} />
          </picture>}
        </div>
      </section>
      <aside className="mock-score-panel">
        <span className="mock-panel-label">当前小题得分</span>
        {answer.kind === "missing-score" ? <div className="mock-control-missing">测试场景：评分输入框缺失</div> : <div className="mock-score-input"><input data-grading-score type="number" min="0" max={answer.maxScore ?? 8} value={score} onChange={(event) => setScore(event.target.value)} placeholder="输入分数" /><span>/ {answer.maxScore ?? 8}</span></div>}
        {answer.kind !== "missing-submit" && <button data-grading-submit className="mock-submit" disabled={!score.trim() || submitted} onClick={submit}>{submitted ? "已提交" : "提交分数"}</button>}
        <button data-grading-previous className="mock-next" disabled={index <= 0} onClick={previous}>上一份答卷</button>
        {answer.kind !== "missing-next" && <button data-grading-next className="mock-next" onClick={next}>{index >= mockAnswers.length - 1 ? "完成本批次" : "下一份答卷"}</button>}
        <div className="mock-events"><strong>网页操作记录</strong>{events.length ? events.map((event, eventIndex) => <span key={`${event}-${eventIndex}`}>{event}</span>) : <span>等待阅卷程序操作</span>}</div>
      </aside>
    </main>
  </div>;
}
