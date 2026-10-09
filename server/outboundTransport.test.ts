import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OUTBOUND_PROXY_URL, getOutboundProxyDispatcher, MODEL_PROXY_ENV } from "./outboundTransport.js";

describe("outbound proxy transport", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("connects directly by default for the local Zhilian model service", () => {
    vi.unstubAllEnvs();
    expect(DEFAULT_OUTBOUND_PROXY_URL).toBeUndefined();
    expect(getOutboundProxyDispatcher()).toBeUndefined();
  });

  it("supports direct mode and custom HTTP(S) proxies", () => {
    vi.stubEnv(MODEL_PROXY_ENV, "direct");
    expect(getOutboundProxyDispatcher()).toBeUndefined();

    vi.stubEnv(MODEL_PROXY_ENV, "http://127.0.0.1:8080");
    const dispatcher = getOutboundProxyDispatcher();
    expect(dispatcher).toBeDefined();
    expect(getOutboundProxyDispatcher()).toBe(dispatcher);
  });

  it("rejects an invalid proxy protocol without exposing proxy details", () => {
    vi.stubEnv(MODEL_PROXY_ENV, "socks5://user:secret@127.0.0.1:1080");
    expect(() => getOutboundProxyDispatcher()).toThrow(`${MODEL_PROXY_ENV} 配置无效`);
    expect(() => getOutboundProxyDispatcher()).toThrow("HTTP 或 HTTPS");
    expect(() => getOutboundProxyDispatcher()).not.toThrow("secret");
  });
});
