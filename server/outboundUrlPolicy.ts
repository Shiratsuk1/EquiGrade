import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type LookupAddress = { address: string; family: number };
type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

function ipv4Number(address: string) {
  return address.split(".").reduce((value, part) => (value * 256) + Number(part), 0) >>> 0;
}

function inIpv4Range(address: string, network: string, prefix: number) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

export function isForbiddenNetworkAddress(value: string) {
  const address = value.toLowerCase().split("%")[0];
  if (isIP(address) === 4) {
    const ranges: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
      ["192.0.2.0", 24], ["192.88.99.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
    ];
    return ranges.some(([network, prefix]) => inIpv4Range(address, network, prefix));
  }
  if (isIP(address) === 6) {
    const mappedIpv4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4) return isForbiddenNetworkAddress(mappedIpv4);
    return address === "::" || address === "::1"
      || address.startsWith("fc") || address.startsWith("fd")
      || /^fe[89a-f]/.test(address)
      || address.startsWith("2001:db8")
      || address.startsWith("ff");
  }
  return true;
}

async function systemLookup(hostname: string) {
  return await lookup(hostname, { all: true, verbatim: true });
}

export async function assertSafeModelBaseUrl(value: string, resolveAll: LookupAll = systemLookup) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("模型服务地址不能包含用户名或密码");
  const allowPrivate = process.env.HENGZHUN_ALLOW_PRIVATE_MODEL_ENDPOINTS === "1";
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new Error("模型服务地址必须使用 HTTPS；本地模型需显式启用可信私网端点模式");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    if (!allowPrivate) throw new Error("模型服务地址不能指向本机或本地网络");
  }
  if (process.env.NODE_ENV === "test" && hostname.endsWith(".test")) return url;
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolveAll(hostname);
  if (!addresses.length) throw new Error("模型服务域名没有可用的网络地址");
  if (!allowPrivate && addresses.some((item) => isForbiddenNetworkAddress(item.address))) {
    throw new Error("模型服务地址解析到回环、私网、链路本地或其他受限网络");
  }
  return url;
}
