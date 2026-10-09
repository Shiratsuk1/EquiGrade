type LookupAddress = { address: string; family: number };
type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

function validateOutboundUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}不是有效的 URL`);
  }
  if (url.username || url.password) throw new Error(`${label}不能包含用户名或密码`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label}必须使用 HTTP 或 HTTPS`);
  }
  if (!url.hostname) throw new Error(`${label}缺少主机名`);
  return url;
}

/**
 * 校验外部服务地址的 URL 结构。
 *
 * 目标地址可能通过本机代理访问，代理域名也可能在本机解析到私网或
 * 代理专用的合成地址，因此这里不再执行 DNS 解析和网络范围拦截。
 */
export async function assertSafePublicHttpsUrl(
  value: string,
  _resolveAll?: LookupAll
) {
  return validateOutboundUrl(value, "出站地址");
}

export async function assertSafeModelBaseUrl(
  value: string,
  _resolveAll?: LookupAll
) {
  return validateOutboundUrl(value, "模型服务地址");
}
