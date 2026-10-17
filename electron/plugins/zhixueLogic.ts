import type { ScoreWritePayload } from "./types.js";

export type ZhixueScoreField = {
  id: string;
  maxScore?: number;
};

export type ZhixueScorePlan = {
  source: "total";
  values: number[];
};

const EPSILON = 1e-6;

function closeEnough(left: number, right: number) {
  return Math.abs(left - right) <= EPSILON;
}

function validScore(score: number, maxScore: number) {
  return Number.isFinite(score) && Number.isFinite(maxScore) && score >= 0 && score <= maxScore + EPSILON;
}

export function matchesZhixueUrl(url: URL) {
  const hostname = url.hostname.toLowerCase();
  const isLocalMock = url.protocol === "http:"
    && (hostname === "localhost" || hostname === "127.0.0.1")
    && url.pathname.startsWith("/zhixue-mock");
  if (isLocalMock) return true;
  const isZhixue = hostname === "zhixue.com" || hostname.endsWith(".zhixue.com");
  if (url.protocol !== "https:" || !isZhixue) return false;
  return true;
}

export function buildZhixueScorePlan(payload: ScoreWritePayload, fields: ZhixueScoreField[]): ZhixueScorePlan {
  if (!validScore(payload.score, payload.maxScore)) throw new Error("教师模型返回的总分超出有效范围");
  if (fields.length !== 1) throw new Error(`智学网总分模式要求且只允许一个分数框，当前识别到 ${fields.length} 个`);
  const fieldMax = fields[0].maxScore;
  if (fieldMax !== undefined && !closeEnough(fieldMax, payload.maxScore)) {
    throw new Error(`智学网总分框满分 ${fieldMax} 与评分模板满分 ${payload.maxScore} 不一致`);
  }
  return { source: "total", values: [payload.score] };
}

export function parseMarkingProgress(text: string): { completed: number; total: number } | undefined {
  const match = text.match(
    /(?:初评)?已阅量\s*(\d+)\s*\/\s*任务量\s*(\d+)|(?:初评)?已阅量\s*\/\s*任务量[^\d]*(\d+)\s*\/\s*(\d+)/
  );
  if (!match) return undefined;
  return { completed: Number(match[1] ?? match[3]), total: Number(match[2] ?? match[4]) };
}

const ZHIXUE_STATIC_UI_PATTERNS = [
  /static\.zhixue\.com\/webmarking\//i,
  /static\.zhixue\.com\/static-/i,
  /cdn-oss-hz\.zhixue\.com/i,
  /[/._-]intellTip(?:\.[a-f0-9]+)?\.(?:png|jpe?g|webp|gif|svg)/i,
  /[/._-]guide(?:\.[a-f0-9]+)?\.(?:png|jpe?g|webp|gif|svg)/i,
  /aigrade-guide/i,
  /emptyImg-[a-zA-Z0-9_-]+\.png/i,
  /oss_banner\//i,
  /geetest\.com/i,
  /\/(?:home|homework|topic|target|monitor|zxhelp)\.png/i
];

export function isZhixueStaticUiImageUrl(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return ZHIXUE_STATIC_UI_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export type ZhixueDomQueryScope = {
  querySelector: (selector: string) => Element | null;
};

export function isZhixuePromptOrLoading(
  doc: ZhixueDomQueryScope,
  isElementRendered: (el: Element) => boolean
): string | undefined {
  const tipContainer = doc.querySelector("#img_Tip, #imgBoxTip");
  const continueBtn = doc.querySelector("#continueMark");
  const waitBtn = doc.querySelector("#waitMark");
  if ((tipContainer && isElementRendered(tipContainer))
    || (continueBtn && isElementRendered(continueBtn))
    || (waitBtn && isElementRendered(waitBtn))) {
    return "智学网正在搜集定标试卷，尚未加载有效学生答卷";
  }

  const loading = doc.querySelector("#img_loading, .img_loading");
  if (loading && isElementRendered(loading)) {
    return "智学网学生作答原图正在加载中";
  }

  const errorTip = doc.querySelector(".img-tip-div");
  if (errorTip && isElementRendered(errorTip)) {
    return "智学网答卷图片显示失败，请在网页中刷新重试";
  }

  const realContainer = doc.querySelector("#img_containter, #img_container");
  if (realContainer && !isElementRendered(realContainer)) {
    return "智学网学生作答区域当前处于隐藏状态，尚未就绪";
  }

  return undefined;
}

const ZHIXUE_EXCELLENT_SELECTORS = [
  "[data-tool='you']",
  "[data-tool='excellent']",
  "[data-tool='star']",
  "[data-type='you']",
  "[data-type='excellent']",
  "[data-type='good']",
  "[data-name='优']",
  "[data-name='优秀']",
  "[title='优']",
  "[title='优秀']",
  "[title='优秀试卷']",
  "[title='优秀卷']",
  "[title='标记优秀']",
  "[title='典型试卷']",
  "[title='典型卷']",
  "[title*='优']",
  "[aria-label='优']",
  "[aria-label*='优']",
  ".tool-you",
  ".tool_you",
  ".mark-you",
  ".marking-you",
  ".btn-you",
  ".btn-star",
  ".btn-excellent",
  ".icon-you",
  ".icon-star"
];

export function findZhixueExcellentControl(
  doc: {
    querySelector: (selector: string) => Element | null;
    querySelectorAll?: (selector: string) => NodeListOf<Element> | Element[];
  },
  isElementRendered?: (el: Element) => boolean
): HTMLElement | null {
  const rendered = (el: Element) => (isElementRendered ? isElementRendered(el) : true);

  // 1. 优先使用已知的属性与类名选择器
  for (const selector of ZHIXUE_EXCELLENT_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el && rendered(el)) return el as HTMLElement;
  }

  if (typeof doc.querySelectorAll !== "function") return null;

  // 2. 文本内容精确匹配（“优”或“优秀”）
  const candidates = Array.from(doc.querySelectorAll("button, a, [role='button'], li, .tool, .tool-item, [class*='tool'], span, div, i"));
  for (const el of candidates) {
    if (!rendered(el)) continue;
    const text = el.textContent?.trim();
    const title = el.getAttribute("title")?.trim();
    if (text === "优" || text === "优秀" || title === "优" || title === "优秀") {
      const clickable = (el as HTMLElement).closest?.("button, a, li, [role='button'], [class*='tool'], .tool-item") ?? el;
      return clickable as HTMLElement;
    }
  }

  // 3. 结构上下文推断：在包含“清空”或“错”的工具栏中定位“优”（智学网截图上 [错] [★优] [✓] [✗] [○] [TA] [清空]）
  const clearEl = candidates.find((el) => el.textContent?.trim() === "清空" && rendered(el));
  if (clearEl) {
    const toolbar = (clearEl as HTMLElement).closest?.(".marking_tools, .tool_content, .tools, .toolbar, [class*='tool'], ul, div");
    if (toolbar) {
      const star = toolbar.querySelector("[class*='star'], [class*='xing'], svg, .icon-star");
      if (star && rendered(star)) {
        return ((star as HTMLElement).closest?.("button, a, li, [role='button']") ?? star) as HTMLElement;
      }
      const children = Array.from(toolbar.children).filter((c) => rendered(c));
      if (children.length >= 3) {
        const firstText = children[0].textContent?.trim() || children[0].getAttribute("title")?.trim();
        if (firstText === "错") {
          return children[1] as HTMLElement;
        }
      }
    }
  }

  return null;
}

export function isZhixueExcellentControlActive(control: Element): boolean {
  const activeClassPattern = /\b(active|selected|checked|is-active|is-checked|on)\b/i;
  if (activeClassPattern.test(control.className || "")) return true;
  if (control.getAttribute("aria-pressed") === "true" || control.getAttribute("aria-checked") === "true") return true;

  const parent = control.parentElement;
  if (parent && activeClassPattern.test(parent.className || "")) return true;

  return false;
}

