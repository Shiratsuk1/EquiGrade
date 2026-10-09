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
  return url.pathname.startsWith("/htm-container-web/") || url.pathname.startsWith("/webmarking/");
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

  const realContainer = doc.querySelector("#img_containter");
  if (realContainer && !isElementRendered(realContainer)) {
    return "智学网学生作答区域当前处于隐藏状态，尚未就绪";
  }

  return undefined;
}
