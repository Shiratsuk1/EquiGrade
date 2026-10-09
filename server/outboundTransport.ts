import { ProxyAgent } from "undici";
import type { Dispatcher } from "undici";

export const MODEL_PROXY_ENV = "HENGZHUN_MODEL_PROXY_URL";
/** 本地智联默认直连；仅显式配置 HTTP(S) 地址时才启用代理。 */
export const DEFAULT_OUTBOUND_PROXY_URL: string | undefined = undefined;

const proxyAgents = new Map<string, Dispatcher>();

function configuredProxyUrl(): string | undefined {
  const configured = process.env[MODEL_PROXY_ENV];
  if (configured === undefined) return DEFAULT_OUTBOUND_PROXY_URL;
  const value = configured.trim();
  if (!value || value.toLowerCase() === "direct") return undefined;
  return value;
}

/**
 * 返回统一的外呼代理连接器。目标地址由代理解析和连接，因此本机不应
 * 先对目标域名做 DNS/IP 私网判断；代理地址本身仍要求是 HTTP(S) URL。
 */
export function getOutboundProxyDispatcher(): Dispatcher | undefined {
  const rawProxyUrl = configuredProxyUrl();
  if (!rawProxyUrl) return undefined;

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(rawProxyUrl);
  } catch {
    throw new Error(`${MODEL_PROXY_ENV} 配置无效：必须是 HTTP(S) 代理地址，或设置为 direct`);
  }
  if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
    throw new Error(`${MODEL_PROXY_ENV} 配置无效：必须使用 HTTP 或 HTTPS 代理`);
  }

  const cacheKey = proxyUrl.toString();
  const cached = proxyAgents.get(cacheKey);
  if (cached) return cached;
  try {
    const dispatcher = new ProxyAgent(cacheKey);
    proxyAgents.set(cacheKey, dispatcher);
    return dispatcher;
  } catch {
    throw new Error(`${MODEL_PROXY_ENV} 配置无效：无法创建代理连接器`);
  }
}
