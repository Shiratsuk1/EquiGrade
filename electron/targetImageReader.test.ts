import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import { readTargetImageBytes } from "./targetImageReader.js";

function sessionWithResponse(bytes: Uint8Array, headers = new Map<string, string>()) {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers.get(name) ?? null },
    arrayBuffer: async () => bytes.slice().buffer
  });
  return { session: { fetch } as unknown as Pick<Session, "fetch">, fetch };
}

describe("target image reader", () => {
  it("falls back to the persistent session when CDP has no resource entry", async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { session, fetch } = sessionWithResponse(imageBytes);
    const resourceUrl = new URL("https://alimarkpic.onlyets.com/pic2z/ruiya/answer.png");
    const documentUrl = new URL("https://ruiya.onlyets.com/mark/v6/view/task-token");

    const result = await readTargetImageBytes(
      session,
      resourceUrl,
      documentUrl,
      async () => { throw new Error("No resource with given URL found"); }
    );

    expect(result).toEqual({ bytes: Buffer.from(imageBytes), source: "electron.session-fetch" });
    expect(fetch).toHaveBeenCalledWith(resourceUrl.href, expect.objectContaining({
      credentials: "include",
      referrer: documentUrl.href,
      referrerPolicy: "strict-origin-when-cross-origin"
    }));
  });

  it("uses a cached image without issuing a second network request", async () => {
    const imageBytes = new Uint8Array([1, 2, 3]);
    const { session, fetch } = sessionWithResponse(new Uint8Array([4]));
    const result = await readTargetImageBytes(
      session,
      new URL("https://ruiya.onlyets.com/answer.png"),
      new URL("https://ruiya.onlyets.com/mark/v6/view/task-token"),
      async () => Buffer.from(imageBytes)
    );

    expect(result).toEqual({ bytes: Buffer.from(imageBytes), source: "electron.resource-cache" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a response that exceeds the shared image limit", async () => {
    const { session } = sessionWithResponse(new Uint8Array([1]), new Map([["content-length", String(25 * 1024 * 1024 + 1)]]));

    await expect(readTargetImageBytes(
      session,
      new URL("https://alimarkpic.onlyets.com/answer.png"),
      new URL("https://ruiya.onlyets.com/mark/v6/view/task-token"),
      async () => { throw new Error("No resource with given URL found"); }
    )).rejects.toThrow("答卷图片超过 25 MB 安全上限");
  });
});
