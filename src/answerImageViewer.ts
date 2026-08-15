export type ViewerPoint = { x: number; y: number };
export type ViewerSize = { width: number; height: number };

export const IMAGE_VIEWER_MIN_SCALE = 0.25;
export const IMAGE_VIEWER_MAX_SCALE = 4;

export function clampImageScale(value: number, fitScale = IMAGE_VIEWER_MIN_SCALE) {
  const minimum = Math.min(IMAGE_VIEWER_MIN_SCALE, fitScale);
  return Math.min(IMAGE_VIEWER_MAX_SCALE, Math.max(minimum, value));
}

export function calculateImageFitScale(image: ViewerSize, viewport: ViewerSize, padding = 32) {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  return Math.min(1, availableWidth / image.width, availableHeight / image.height);
}

export function clampImageOffset(
  offset: ViewerPoint,
  image: ViewerSize,
  viewport: ViewerSize,
  scale: number
) {
  const maximumX = Math.max(0, (image.width * scale - viewport.width) / 2);
  const maximumY = Math.max(0, (image.height * scale - viewport.height) / 2);
  return {
    x: Math.min(maximumX, Math.max(-maximumX, offset.x)),
    y: Math.min(maximumY, Math.max(-maximumY, offset.y))
  };
}

export function imageOffsetAfterZoom(
  offset: ViewerPoint,
  currentScale: number,
  nextScale: number,
  anchor: ViewerPoint,
  viewport: ViewerSize
) {
  if (currentScale <= 0) return offset;
  const relativeX = anchor.x - viewport.width / 2;
  const relativeY = anchor.y - viewport.height / 2;
  const ratio = nextScale / currentScale;
  return {
    x: relativeX - (relativeX - offset.x) * ratio,
    y: relativeY - (relativeY - offset.y) * ratio
  };
}
