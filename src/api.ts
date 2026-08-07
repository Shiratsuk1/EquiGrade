export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败：${response.status}`);
  return body as T;
}

export async function uploadDocument(file: File): Promise<{ fileName: string; text: string }> {
  const data = new FormData();
  data.append("file", file);
  return api("/api/documents/extract", { method: "POST", body: data });
}

