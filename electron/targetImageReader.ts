import type { Session } from "electron";
import { MAX_IMAGE_BYTES } from "../shared/uiConstants.js";

type CachedImageReader = () => Promise<Buffer>;

export type TargetImageReadResult = {
  bytes: Buffer;
  source: "electron.resource-cache" | "electron.session-fetch";
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function assertImageBytes(bytes: Buffer) {
  if (!bytes.byteLength) throw new Error("提取出的答卷图片为空");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("答卷图片超过 25 MB 安全上限");
}

async function fetchImageBytes(session: Pick<Session, "fetch">, resourceUrl: URL, documentUrl: URL) {
  const response = await session.fetch(resourceUrl.href, {
    credentials: "include",
    referrer: documentUrl.href,
    referrerPolicy: "strict-origin-when-cross-origin",
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    }
  });
  if (!response.ok) throw new Error(`图片网络请求返回 ${response.status}`);

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error("答卷图片超过 25 MB 安全上限");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  assertImageBytes(bytes);
  return bytes;
}

/**
 * Page.getResourceContent only sees resources registered in a frame's resource
 * tree. Some target sites display an image that is not exposed there, so use
 * the same persistent Electron session as a network fallback.
 */
export async function readTargetImageBytes(
  session: Pick<Session, "fetch">,
  resourceUrl: URL,
  documentUrl: URL,
  readCached: CachedImageReader
): Promise<TargetImageReadResult> {
  let cacheError: unknown;
  try {
    const bytes = await readCached();
    assertImageBytes(bytes);
    return { bytes, source: "electron.resource-cache" };
  } catch (error) {
    cacheError = error;
  }

  try {
    return {
      bytes: await fetchImageBytes(session, resourceUrl, documentUrl),
      source: "electron.session-fetch"
    };
  } catch (networkError) {
    throw new Error(
      `读取答卷图片失败：页面资源缓存读取失败（${errorMessage(cacheError)}）；会话网络读取失败（${errorMessage(networkError)}）`
    );
  }
}
