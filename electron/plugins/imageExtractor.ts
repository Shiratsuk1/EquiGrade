import { ipcRenderer } from "electron";

export type AnswerImageContext = {
  card: HTMLElement | null;
  image: HTMLImageElement | null;
};

export type ExtractedImage = {
  dataUrl: string;
  mimeType: string;
  sha256: string;
  source: string;
  bytes: number;
};

type ImageCandidate = {
  source: string;
  url: string;
};

type RemoteImageResult = ExtractedImage;

function normalizeUrl(value: string | undefined, baseUrl = document.baseURI) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:image/") || trimmed.startsWith("blob:")) return trimmed;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return null;
  }
}

function addCandidate(candidates: ImageCandidate[], source: string, value: string | undefined, baseUrl: string) {
  const url = normalizeUrl(value, baseUrl);
  if (!url || candidates.some((candidate) => candidate.url === url)) return;
  candidates.push({ source, url });
}

function srcSetUrls(value: string | undefined) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function collectImageCandidates(context: AnswerImageContext) {
  const candidates: ImageCandidate[] = [];
  const scope: ParentNode = context.card ?? document;
  const image = context.image;
  const baseUrl = image?.ownerDocument.baseURI ?? context.card?.ownerDocument.baseURI ?? document.baseURI;
  if (image) {
    addCandidate(candidates, "img.currentSrc", image.currentSrc, baseUrl);
    addCandidate(candidates, "img.src", image.src, baseUrl);
    addCandidate(candidates, "img.data-src", image.dataset.src, baseUrl);
    addCandidate(candidates, "img.data-original", image.dataset.original, baseUrl);
    addCandidate(candidates, "img.data-image", image.dataset.image, baseUrl);
    srcSetUrls(image.getAttribute("srcset") ?? undefined).forEach((url) => addCandidate(candidates, "img.srcset", url, baseUrl));
    image.parentElement?.querySelectorAll<HTMLSourceElement>("source").forEach((source) => {
      srcSetUrls(source.srcset).forEach((url) => addCandidate(candidates, "picture.source", url, baseUrl));
    });
  }

  scope.querySelectorAll<HTMLElement>("[data-answer-image],[data-image],[data-src]").forEach((element) => {
    addCandidate(candidates, `${element.tagName.toLowerCase()}.data-image`, element.dataset.image, baseUrl);
    addCandidate(candidates, `${element.tagName.toLowerCase()}.data-src`, element.dataset.src, baseUrl);
  });

  scope.querySelectorAll<HTMLElement>("[style*='background']").forEach((element) => {
    const background = getComputedStyle(element).backgroundImage;
    for (const match of background.matchAll(/url\(["']?(.*?)["']?\)/g)) {
      addCandidate(candidates, `${element.tagName.toLowerCase()}.background-image`, match[1], baseUrl);
    }
  });
  return candidates;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("答卷图片转换失败"));
    reader.readAsDataURL(blob);
  });
}

async function canvasToBlob(canvas: HTMLCanvasElement) {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("答卷图片无法转换为 PNG")), "image/png");
  });
}

async function rasterizeSvg(dataUrl: string) {
  const image = new Image();
  image.decoding = "async";
  image.src = dataUrl;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("SVG 答卷图片无法渲染"));
  });
  const width = image.naturalWidth || 900;
  const height = image.naturalHeight || 1200;
  const scale = Math.min(1, 1800 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建答卷图片转换画布");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas);
}

async function imageElementToBlob(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width || 900;
  canvas.height = image.naturalHeight || image.height || 1200;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建答卷图片转换画布");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas);
}

async function candidateToBlob(candidate: ImageCandidate, image: HTMLImageElement | null) {
  try {
    const response = await fetch(candidate.url, { credentials: "include" });
    if (!response.ok) throw new Error(`图片请求返回 ${response.status}`);
    return await response.blob();
  } catch (error) {
    if (image && candidate.url === normalizeUrl(image.currentSrc || image.src)) {
      try {
        return await imageElementToBlob(image);
      } catch {
        // Some sites prevent canvas extraction; continue to the next source.
      }
    }
    throw error;
  }
}

async function extractRemoteImage(candidate: ImageCandidate, context: AnswerImageContext) {
  if (!/^https?:/i.test(candidate.url)) return null;
  const documentUrl = context.image?.ownerDocument.location.href
    ?? context.card?.ownerDocument.location.href
    ?? window.location.href;
  const result = await ipcRenderer.invoke("pipeline:read-target-image", {
    url: candidate.url,
    documentUrl
  }) as RemoteImageResult;
  if (!result?.dataUrl?.startsWith("data:image/") || !/^[a-f0-9]{64}$/i.test(result.sha256) || result.bytes <= 0) {
    throw new Error("主进程返回的答卷图片无效");
  }
  return { ...result, source: `electron.network:${candidate.source}` };
}

async function sha256Bytes(bytes: Uint8Array) {
  try {
    if (window.crypto?.subtle) {
      const digest = await window.crypto.subtle.digest("SHA-256", bytes as BufferSource);
      return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Non-secure HTTP pages use the isolated Electron main-process fallback.
  }
  return String(await ipcRenderer.invoke("pipeline:sha256", { bytes: Array.from(bytes) }));
}

export async function extractAnswerImage(context: AnswerImageContext): Promise<ExtractedImage> {
  const candidates = collectImageCandidates(context);
  for (const candidate of candidates) {
    try {
      let blob = await candidateToBlob(candidate, context.image);
      const sourceMimeType = blob.type.toLowerCase();
      if (sourceMimeType === "image/svg+xml" || sourceMimeType === "image/svg") {
        blob = await rasterizeSvg(await blobToDataUrl(blob));
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.length) throw new Error("提取出的答卷图片为空");
      return {
        dataUrl: await blobToDataUrl(blob),
        mimeType: blob.type || "image/png",
        sha256: await sha256Bytes(bytes),
        source: candidate.source,
        bytes: bytes.byteLength
      };
    } catch {
      try {
        const remote = await extractRemoteImage(candidate, context);
        if (remote) return remote;
      } catch {
        // A target site may expose the same image through several channels.
      }
    }
  }

  const canvas = (context.card ?? document).querySelector<HTMLCanvasElement>("canvas");
  if (canvas) {
    const blob = await canvasToBlob(canvas);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      dataUrl: await blobToDataUrl(blob),
      mimeType: "image/png",
      sha256: await sha256Bytes(bytes),
      source: "canvas.toBlob",
      bytes: bytes.byteLength
    };
  }
  throw new Error("未找到可提取的学生作答图片");
}
