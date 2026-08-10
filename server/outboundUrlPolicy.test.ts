import { describe, expect, it } from "vitest";
import { assertSafeModelBaseUrl, isForbiddenNetworkAddress } from "./outboundUrlPolicy.js";

describe("model endpoint network policy", () => {
  it("rejects loopback, private, link-local, and mapped addresses", () => {
    expect(isForbiddenNetworkAddress("127.0.0.1")).toBe(true);
    expect(isForbiddenNetworkAddress("10.2.3.4")).toBe(true);
    expect(isForbiddenNetworkAddress("169.254.169.254")).toBe(true);
    expect(isForbiddenNetworkAddress("::1")).toBe(true);
    expect(isForbiddenNetworkAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isForbiddenNetworkAddress("8.8.8.8")).toBe(false);
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    await expect(assertSafeModelBaseUrl("https://models.example/v1", async () => [
      { address: "203.0.113.10", family: 4 },
      { address: "192.168.1.20", family: 4 }
    ])).rejects.toThrow("受限网络");
  });

  it("rejects credentials and insecure public endpoints", async () => {
    await expect(assertSafeModelBaseUrl("https://user:secret@example.com/v1")).rejects.toThrow("用户名或密码");
    await expect(assertSafeModelBaseUrl("http://8.8.8.8/v1")).rejects.toThrow("HTTPS");
  });
});
