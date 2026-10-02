// Keeps frequently-redrawn overlays below 16 MiB of RGBA backing pixels each
// while retaining full 2x rendering on typical analyse panes.
const MAX_CANVAS_DPR = 2;
const DEFAULT_CANVAS_PIXEL_AREA = 4_000_000;

function getClampedScale(width: number, height: number, dpr: number, maxDpr: number, maxPixelArea: number): number {
  const requestedDpr = Number.isFinite(dpr) ? Math.max(0, dpr) : 1;
  const dprLimit = Number.isFinite(maxDpr) ? Math.max(0, maxDpr) : MAX_CANVAS_DPR;
  const area = Math.max(1, width * height);
  return Math.min(requestedDpr, dprLimit, Math.sqrt(maxPixelArea / area));
}

export function syncCanvasSize(canvas: HTMLCanvasElement, width: number, height: number, requestedDpr = 1, setStyle = true, maxDpr = MAX_CANVAS_DPR, maxPixelArea = DEFAULT_CANVAS_PIXEL_AREA): void {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const pixelAreaLimit = Number.isFinite(maxPixelArea) ? Math.max(1, Math.floor(maxPixelArea)) : DEFAULT_CANVAS_PIXEL_AREA;
  const scale = getClampedScale(safeWidth, safeHeight, requestedDpr, maxDpr, pixelAreaLimit);
  let backingWidth = Math.max(1, Math.floor(safeWidth * scale));
  let backingHeight = Math.max(1, Math.floor(safeHeight * scale));
  if (backingWidth * backingHeight > pixelAreaLimit) {
    if (backingWidth >= backingHeight) backingWidth = Math.max(1, Math.floor(pixelAreaLimit / backingHeight));
    else backingHeight = Math.max(1, Math.floor(pixelAreaLimit / backingWidth));
  }

  if (setStyle) {
    const targetStyleWidth = `${safeWidth}px`;
    const targetStyleHeight = `${safeHeight}px`;
    if (canvas.style.width !== targetStyleWidth || canvas.style.height !== targetStyleHeight) {
      canvas.style.width = targetStyleWidth;
      canvas.style.height = targetStyleHeight;
    }
  }
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
}
