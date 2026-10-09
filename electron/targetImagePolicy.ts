import { isZhixueStaticUiImageUrl } from "./plugins/zhixueLogic.js";

const ZHIXUE_ANSWER_IMAGE_HOSTS = new Set([
  "zhixue-sc.oss-cn-hangzhou.aliyuncs.com"
]);
const RUIYA_ANSWER_IMAGE_HOSTS = new Set([
  "alimarkpic.onlyets.com",
  // 睿芽云 v6 阅卷页的答卷扫描图实际存放在该阿里云 OSS 桶（无 CORS 头，必须走主进程读取）。
  "ry-mark.oss-cn-beijing.aliyuncs.com"
]);

function isZhixueHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "zhixue.com" || normalized.endsWith(".zhixue.com");
}

function isRuiyaHost(hostname: string) {
  return hostname.toLowerCase() === "ruiya.onlyets.com";
}

export function assertAllowedImageResource(resourceUrl: URL, documentUrl: URL) {
  if (isZhixueStaticUiImageUrl(resourceUrl.href)) {
    throw new Error("答卷图片不能是智学网系统内置的静态提示或界面图片");
  }

  if (resourceUrl.origin === documentUrl.origin) return;

  const isTrustedZhixueDocument = documentUrl.protocol === "https:" && isZhixueHost(documentUrl.hostname);
  const isTrustedRuiyaDocument = documentUrl.protocol === "https:" && isRuiyaHost(documentUrl.hostname);
  const isTrustedZhixueResource = resourceUrl.protocol === "https:" && (
    isZhixueHost(resourceUrl.hostname)
    || ZHIXUE_ANSWER_IMAGE_HOSTS.has(resourceUrl.hostname.toLowerCase())
  );
  const isTrustedRuiyaResource = resourceUrl.protocol === "https:" && (
    isRuiyaHost(resourceUrl.hostname)
    || RUIYA_ANSWER_IMAGE_HOSTS.has(resourceUrl.hostname.toLowerCase())
  );
  if ((!isTrustedZhixueDocument || !isTrustedZhixueResource)
    && (!isTrustedRuiyaDocument || !isTrustedRuiyaResource)) {
    throw new Error("答卷图片必须与当前阅卷页面同源或来自受信任的智学网或睿芽云域名");
  }
}
