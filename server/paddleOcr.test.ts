import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OperationCancelledError } from "./systemLog.js";
import { extractPaddleOcrLayoutMetadata, extractPaddleOcrMarkdown, runPaddleOcr } from "./paddleOcr.js";

    const fetchMock = vi.fn<typeof fetch>();

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function submitResponse(jobId = "job-1"): Response {
  return response({ data: { jobId } });
}

function pendingResponse(): Response {
  return response({ data: { state: "pending" } });
}

function doneResponse(jsonUrl = "https://result.test/job-1.jsonl"): Response {
  return response({ data: { state: "done", resultUrl: { jsonUrl } } });
}

function resultJsonl(...texts: string[]): string {
  return texts.map((text) => JSON.stringify({
    result: { layoutParsingResults: [{ markdown: { text } }] }
  })).join("\n") + "\n";
}

describe("PaddleOCR client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN", "unit-test-token");
    vi.stubEnv("PADDLEOCR_JOB_URL", "https://ocr.test/api/v2/ocr/jobs");
    vi.stubEnv("HENGZHUN_MODEL_PROXY_URL", "http://127.0.0.1:7897");
    vi.stubEnv("PADDLEOCR_MODEL", "PaddleOCR-VL-1.6");
    vi.stubEnv("PADDLEOCR_POLL_INTERVAL_MS", "0");
    vi.stubEnv("PADDLEOCR_TIMEOUT_MS", "1000");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("submits, polls pending/running/done, downloads complete JSONL, and extracts Markdown", async () => {
    const rawJsonl = resultJsonl("第一页\nx=2", "第二页\nv=3m/s");
    fetchMock
      .mockResolvedValueOnce(submitResponse("job-42"))
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(response({ data: { state: "running" } }))
      .mockResolvedValueOnce(doneResponse("https://result.test/job-42.jsonl"))
      .mockResolvedValueOnce(new Response(rawJsonl, { status: 200 }));

    const imageBuffer = Buffer.from("student-answer");
    const audit = await runPaddleOcr({
      imageBuffer,
      mimeType: "image/png",
      fileName: "answer.png"
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const submitInit = fetchMock.mock.calls[0]?.[1];
    expect(submitInit?.method).toBe("POST");
    expect(submitInit?.headers).toMatchObject({ Accept: "application/json" });
    expect(submitInit?.body).toBeInstanceOf(FormData);
    const form = submitInit?.body as FormData;
    expect(form.get("model")).toBe("PaddleOCR-VL-1.6");
    expect(form.get("optionalPayload")).toBe(JSON.stringify({
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      useChartRecognition: false
    }));
    const uploadedFile = form.get("file");
    expect(uploadedFile).toBeInstanceOf(Blob);
    expect(await (uploadedFile as Blob).text()).toBe(imageBuffer.toString());
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://ocr.test/api/v2/ocr/jobs/job-42");
    expect(fetchMock.mock.calls[3]?.[0]).toBe("https://ocr.test/api/v2/ocr/jobs/job-42");
    expect(fetchMock.mock.calls[4]?.[0]).toBe("https://result.test/job-42.jsonl");
    expect(audit).toMatchObject({
      provider: "paddleocr",
      model: "PaddleOCR-VL-1.6",
      jobId: "job-42",
      rawJsonl,
      markdownText: "第一页\nx=2\n\n第二页\nv=3m/s"
    });
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(requestInit.dispatcher).toBeDefined();
  });

  it("merges Markdown from multiple JSONL records and layout results", () => {
    const rawJsonl = [
      JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: "第 1 页" } }, { markdown: { text: "第 1 页下半段" } }] } }),
      JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: "第 2 页" } }] } })
    ].join("\n");

    expect(extractPaddleOcrMarkdown(rawJsonl)).toBe("第 1 页\n\n第 1 页下半段\n\n第 2 页");
  });

  it("extracts image dimensions and stable block metadata from layout_det_res.boxes", () => {
    const rawJsonl = JSON.stringify({
      result: {
        dataInfo: { width: 1106, height: 1422 },
        layoutParsingResults: [{
          prunedResult: {
            layout_det_res: {
              boxes: [
                { label: "inline_formula", score: 0.93, coordinate: [100, 220, 420, 280], order: 2, polygon_points: [[100, 220], [420, 220], [420, 280], [100, 280]] },
                { label: "header", score: 0.99, coordinate: [20, 10, 100, 40], order: 0, polygon_points: [[20, 10], [100, 10], [100, 40], [20, 40]] },
                { label: "table", score: 0.88, coordinate: [40, 60, 1000, 1400], order: 1, polygon_points: [] },
                { label: "invalid", score: 0.2, coordinate: [1, 2, 1, 3], order: 3, polygon_points: [] }
              ]
            }
          },
          markdown: { text: "公式" }
        }]
      }
    });

    const metadata = extractPaddleOcrLayoutMetadata(rawJsonl);
    expect(metadata).toMatchObject({ imageWidth: 1106, imageHeight: 1422 });
    expect(metadata.layoutBlocks).toHaveLength(3);
    expect(metadata.layoutBlocks.map((block) => block.blockId)).toEqual(["block-00", "block-01", "block-02"]);
    expect(metadata.layoutBlocks[0]).toMatchObject({ label: "header", order: 0, coordinate: [20, 10, 100, 40] });
    expect(metadata.layoutBlocks[1]).toMatchObject({ label: "table", order: 1 });
    expect(metadata.layoutBlocks[2]).toMatchObject({ label: "inline_formula", order: 2, polygonPoints: [[100, 220], [420, 220], [420, 280], [100, 280]] });
  });

  it("supports the top-level layout_det_res fallback and skips malformed boxes", () => {
    const rawJsonl = JSON.stringify({
      result: {
        dataInfo: { width: 575, height: 738 },
        layout_det_res: {
          boxes: [
            { label: "image", score: "0.7", coordinate: [0, 0, 50, 50], order: "4", polygon_points: [{ x: 0, y: 0 }, { x: 50, y: 50 }] },
            { label: "broken", coordinate: [0, 0, "not-a-number", 50] }
          ]
        },
        layoutParsingResults: [{ markdown: { text: "图" } }]
      }
    });

    expect(extractPaddleOcrLayoutMetadata(rawJsonl).layoutBlocks).toEqual([expect.objectContaining({
      blockId: "block-00",
      label: "image",
      score: 0.7,
      order: 4,
      polygonPoints: [[0, 0], [50, 50]]
    })]);
  });

  it("rejects a missing token before making a request", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "paddleocr-missing-token-test-"));
    try {
      vi.stubEnv("APP_DATA_DIR", dataDirectory);
      vi.stubEnv("PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN", "");

      await expect(runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" }))
        .rejects.toMatchObject({ code: "missing_token" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("reads a local ignored token file when the environment variable is absent", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "paddleocr-token-test-"));
    try {
      vi.stubEnv("APP_DATA_DIR", dataDirectory);
      vi.stubEnv("PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN", "");
      const rawJsonl = resultJsonl("OCR from local token file");
      await writeFile(path.join(dataDirectory, "paddleocr.token"), "local-file-token\n", "utf8");
      fetchMock
        .mockResolvedValueOnce(submitResponse("job-local-file"))
        .mockResolvedValueOnce(doneResponse("https://result.test/job-local-file.jsonl"))
        .mockResolvedValueOnce(new Response(rawJsonl, { status: 200 }));

      const audit = await runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" });
      expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization)
        .toBe("Bearer local-file-token");
      expect(audit.markdownText).toBe("OCR from local token file");
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("allows private and synthetic OCR endpoints when requests use the proxy", async () => {
    vi.stubEnv("PADDLEOCR_JOB_URL", "https://198.18.42.7/api/v2/ocr/jobs");
    const rawJsonl = resultJsonl("OCR through proxy");
    fetchMock
      .mockResolvedValueOnce(submitResponse("proxy-job"))
      .mockResolvedValueOnce(doneResponse("https://198.18.42.7/result/proxy-job.jsonl"))
      .mockResolvedValueOnce(new Response(rawJsonl, { status: 200 }));

    const audit = await runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" });

    expect(audit.jobId).toBe("proxy-job");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown }).dispatcher).toBeDefined();
  });

  it("reports submit HTTP errors", async () => {
    fetchMock.mockResolvedValueOnce(response("request denied", 401));

    await expect(runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" }))
      .rejects.toMatchObject({ code: "http_error" });
  });

  it("reports non-JSON submit responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 200 }));

    await expect(runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" }))
      .rejects.toMatchObject({ code: "invalid_json" });
  });

  it("reports a missing job ID", async () => {
    fetchMock.mockResolvedValueOnce(response({ data: {} }));

    await expect(runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" }))
      .rejects.toMatchObject({ code: "missing_job_id" });
  });

  it("reports failed and unknown task states", async () => {
    fetchMock
      .mockResolvedValueOnce(submitResponse())
      .mockResolvedValueOnce(response({ data: { state: "failed", errorMsg: "服务端拒绝文件" } }));
    await expect(runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" }))
      .rejects.toMatchObject({ code: "failed" });

    fetchMock
      .mockResolvedValueOnce(submitResponse("job-unknown"))
      .mockResolvedValueOnce(response({ data: { state: "queued" } }));
    await expect(runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" }))
      .rejects.toMatchObject({ code: "unknown_status" });
  });

  it("reports a missing result URL and empty JSONL", async () => {
    fetchMock
      .mockResolvedValueOnce(submitResponse())
      .mockResolvedValueOnce(response({ data: { state: "done", resultUrl: {} } }));
    await expect(runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" }))
      .rejects.toMatchObject({ code: "missing_result_url" });

    fetchMock
      .mockResolvedValueOnce(submitResponse("job-empty"))
      .mockResolvedValueOnce(doneResponse("https://result.test/job-empty.jsonl"))
      .mockResolvedValueOnce(new Response("\n", { status: 200 }));
    await expect(runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" }))
      .rejects.toMatchObject({ code: "empty_result" });
  });

  it("times out while polling", async () => {
    vi.stubEnv("PADDLEOCR_POLL_INTERVAL_MS", "50");
    vi.stubEnv("PADDLEOCR_TIMEOUT_MS", "10");
    fetchMock
      .mockResolvedValueOnce(submitResponse())
      .mockResolvedValueOnce(pendingResponse());

    await expect(runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" }))
      .rejects.toMatchObject({ code: "timeout" });
  });

  it("propagates caller cancellation during polling", async () => {
    vi.stubEnv("PADDLEOCR_POLL_INTERVAL_MS", "500");
    const controller = new AbortController();
    fetchMock
      .mockResolvedValueOnce(submitResponse())
      .mockResolvedValueOnce(pendingResponse());

    const promise = runPaddleOcr({
      imageBuffer: Buffer.from("image"),
      mimeType: "image/png",
      signal: controller.signal
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("retries on transient HTTP 502 error and succeeds on subsequent attempt", async () => {
    const rawJsonl = resultJsonl("OCR after transient retry");
    fetchMock
      .mockResolvedValueOnce(response("Bad Gateway", 502))
      .mockResolvedValueOnce(submitResponse("job-retry"))
      .mockResolvedValueOnce(doneResponse("https://result.test/job-retry.jsonl"))
      .mockResolvedValueOnce(new Response(rawJsonl, { status: 200 }));

    const audit = await runPaddleOcr({ imageBuffer: Buffer.from("image"), mimeType: "image/png" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(audit.jobId).toBe("job-retry");
    expect(audit.markdownText).toBe("OCR after transient retry");
  });
});
