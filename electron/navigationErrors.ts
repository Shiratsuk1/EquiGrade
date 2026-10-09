export function isAbortedNavigationError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const details = error as { code?: unknown; errno?: unknown; message?: unknown };
  return details.code === "ERR_ABORTED"
    || details.errno === -3
    || (typeof details.message === "string" && /\bERR_ABORTED\b/.test(details.message));
}
