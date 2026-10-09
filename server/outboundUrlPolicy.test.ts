import { describe, expect, it } from "vitest";
import { assertSafeModelBaseUrl, assertSafePublicHttpsUrl } from "./outboundUrlPolicy.js";

describe("model endpoint URL policy", () => {
  it("does not resolve or reject private and synthetic target addresses", async () => {
    let lookupCalls = 0;
    await expect(assertSafeModelBaseUrl("https://models.example/v1", async () => {
      lookupCalls += 1;
      return [
        { address: "203.0.113.10", family: 4 },
        { address: "192.168.1.20", family: 4 }
      ];
    })).resolves.toMatchObject({ hostname: "models.example" });
    await expect(assertSafePublicHttpsUrl("https://ocr.example/api/jobs", async () => {
      lookupCalls += 1;
      return [{ address: "198.18.42.7", family: 4 }];
    })).resolves.toMatchObject({ hostname: "ocr.example" });
    expect(lookupCalls).toBe(0);
  });

  it("accepts HTTP endpoints and rejects credentials or unsupported schemes", async () => {
    await expect(assertSafeModelBaseUrl("http://127.0.0.1:8000/v1")).resolves.toMatchObject({ protocol: "http:" });
    await expect(assertSafeModelBaseUrl("https://user:secret@example.com/v1")).rejects.toThrow("用户名或密码");
    await expect(assertSafeModelBaseUrl("ws://models.example/v1")).rejects.toThrow("HTTP 或 HTTPS");
  });
});
