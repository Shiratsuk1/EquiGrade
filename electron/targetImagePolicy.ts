const ZHIXUE_ANSWER_IMAGE_HOSTS = new Set([
  "zhixue-sc.oss-cn-hangzhou.aliyuncs.com"
]);

function isZhixueHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "zhixue.com" || normalized.endsWith(".zhixue.com");
}

export function assertAllowedImageResource(resourceUrl: URL, documentUrl: URL) {
  if (resourceUrl.origin === documentUrl.origin) return;

  const isTrustedZhixueDocument = documentUrl.protocol === "https:" && isZhixueHost(documentUrl.hostname);
  const isTrustedZhixueResource = resourceUrl.protocol === "https:" && (
    isZhixueHost(resourceUrl.hostname)
    || ZHIXUE_ANSWER_IMAGE_HOSTS.has(resourceUrl.hostname.toLowerCase())
  );
  if (!isTrustedZhixueDocument || !isTrustedZhixueResource) {
    throw new Error("答卷图片必须与当前阅卷页面同源或来自受信任的智学网域名");
  }
}
