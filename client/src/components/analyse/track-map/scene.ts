import { DEFAULT_CANVAS_PIXEL_AREA, syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
type SceneCommand =
  | { kind: "stroke" | "fill"; path: Path2D; bounds: Bounds; color: string; alpha: number; width: number; cap: CanvasLineCap; join: CanvasLineJoin; dash: number[] }
  | { kind: "text"; text: string; x: number; y: number; bounds: Bounds; color: string; alpha: number; font: string; align: CanvasTextAlign; baseline: CanvasTextBaseline };

export class SceneBuilder {
  private raster: HTMLCanvasElement | null = null;
  private rasterWidth = 0;
  private rasterHeight = 0;
  private commands: SceneCommand[] = [];
  // Every prepared path starts with beginPath; this declaration emits no allocation.
  declare private path: Path2D;
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  strokeStyle: CanvasRenderingContext2D["strokeStyle"] = "var(--track-outline)";
  fillStyle: CanvasRenderingContext2D["fillStyle"] = "var(--track-label-text)";
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  lineJoin: CanvasLineJoin = "miter";
  globalAlpha = 1;
  font = "var(--font-weight-bold) var(--text-app-micro) var(--font-mono)";
  textAlign: CanvasTextAlign = "start";
  textBaseline: CanvasTextBaseline = "alphabetic";
  private dash: number[] = [];

  private readonly metrics: CanvasRenderingContext2D;
  constructor(metrics: CanvasRenderingContext2D, previousScene?: SceneBuilder | null) {
    this.metrics = metrics;
    this.raster = previousScene?.raster ?? null;
    this.rasterWidth = previousScene?.rasterWidth ?? 0;
    this.rasterHeight = previousScene?.rasterHeight ?? 0;
  }
  beginPath(): void {
    this.path = new Path2D();
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
  }
  moveTo(x: number, y: number): void {
    this.path.moveTo(x, y);
    this.extendBounds(x, y);
  }
  lineTo(x: number, y: number): void {
    this.path.lineTo(x, y);
    this.extendBounds(x, y);
  }
  closePath(): void {
    this.path.closePath();
  }
  arc(x: number, y: number, radius: number, start: number, end: number): void {
    this.path.arc(x, y, radius, start, end);
    this.extendBounds(x - radius, y - radius);
    this.extendBounds(x + radius, y + radius);
  }
  roundRect(x: number, y: number, width: number, height: number, radii?: number | DOMPointInit | (number | DOMPointInit)[]): void {
    this.path.roundRect(x, y, width, height, radii);
    this.extendBounds(x, y);
    this.extendBounds(x + width, y + height);
  }
  setLineDash(dash: number[]): void {
    this.dash = dash;
  }
  measureText(text: string): TextMetrics {
    this.metrics.font = this.font;
    return this.metrics.measureText(text);
  }
  stroke(): void {
    this.record("stroke");
  }
  fill(): void {
    this.record("fill");
  }
  fillText(text: string, x: number, y: number): void {
    this.metrics.font = this.font;
    const width = this.metrics.measureText(text).width;
    const left = this.textAlign === "center" ? x - width / 2 : this.textAlign === "right" || this.textAlign === "end" ? x - width : x;
    this.commands.push({
      kind: "text",
      text,
      x,
      y,
      bounds: { minX: left - 2, maxX: left + width + 2, minY: y - 64, maxY: y + 16 },
      color: String(this.fillStyle),
      alpha: this.globalAlpha,
      font: this.font,
      align: this.textAlign,
      baseline: this.textBaseline,
    });
  }
  private extendBounds(x: number, y: number): void {
    this.minX = Math.min(this.minX, x);
    this.minY = Math.min(this.minY, y);
    this.maxX = Math.max(this.maxX, x);
    this.maxY = Math.max(this.maxY, y);
  }
  private record(kind: "stroke" | "fill"): void {
    if (this.minX === Infinity) return;
    const pad = kind === "stroke" ? this.lineWidth * 10 + 2 : 2;
    this.commands.push({
      kind,
      path: this.path,
      bounds: { minX: this.minX - pad, minY: this.minY - pad, maxX: this.maxX + pad, maxY: this.maxY + pad },
      color: String(kind === "stroke" ? this.strokeStyle : this.fillStyle),
      alpha: this.globalAlpha,
      width: this.lineWidth,
      cap: this.lineCap,
      join: this.lineJoin,
      dash: this.dash,
    });
  }
  cacheNativeRaster(width: number, height: number, dpr: number): void {
    const reusable = this.raster;
    this.raster = null;
    this.rasterWidth = 0;
    this.rasterHeight = 0;
    const backingWidth = Math.floor(width * dpr);
    const backingHeight = Math.floor(height * dpr);
    // Admit raster only at requested display density; vector fallback must never be undersampled.
    if (backingWidth < 1 || backingHeight < 1 || backingWidth * backingHeight > DEFAULT_CANVAS_PIXEL_AREA) return;
    const canvas = reusable ?? document.createElement("canvas");
    syncCanvasSize(canvas, width, height, dpr, false);
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) return;
    const ctx = getSemanticCanvasContext(canvas);
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    this.render(ctx, 0, 0, width, height);
    this.raster = canvas;
    this.rasterWidth = width;
    this.rasterHeight = height;
  }
  renderView(ctx: CanvasRenderingContext2D, minX: number, minY: number, maxX: number, maxY: number): void {
    if (this.raster) ctx.drawImage(this.raster, 0, 0, this.raster.width, this.raster.height, 0, 0, this.rasterWidth, this.rasterHeight);
    else this.render(ctx, minX, minY, maxX, maxY);
  }
  render(ctx: CanvasRenderingContext2D, minX: number, minY: number, maxX: number, maxY: number, scaleX = 1, scaleY = 1): void {
    const save = ctx.save;
    // Context bridge binds methods on access; cache bound methods once, not once per command.
    const restore = ctx.restore;
    const stroke = ctx.stroke;
    const fill = ctx.fill;
    const fillText = ctx.fillText;
    const setLineDash = ctx.setLineDash;
    let alpha = -1;
    let lineWidth = -1;
    let lineCap: CanvasLineCap | null = null;
    let lineJoin: CanvasLineJoin | null = null;
    let strokeColor: string | null = null;
    let fillColor: string | null = null;
    let font: string | null = null;
    let align: CanvasTextAlign | null = null;
    let baseline: CanvasTextBaseline | null = null;
    let dash: number[] | null = null;
    save();
    for (const command of this.commands) {
      const b = command.bounds;
      if (b.maxX * scaleX < minX || b.minX * scaleX > maxX || b.maxY * scaleY < minY || b.minY * scaleY > maxY) continue;
      if (alpha !== command.alpha) {
        ctx.globalAlpha = command.alpha;
        alpha = command.alpha;
      }
      if (command.kind === "text") {
        if (fillColor !== command.color) {
          ctx.fillStyle = command.color;
          fillColor = command.color;
        }
        if (font !== command.font) {
          ctx.font = command.font;
          font = command.font;
        }
        if (align !== command.align) {
          ctx.textAlign = command.align;
          align = command.align;
        }
        if (baseline !== command.baseline) {
          ctx.textBaseline = command.baseline;
          baseline = command.baseline;
        }
        fillText(command.text, command.x, command.y);
      } else {
        if (lineWidth !== command.width) {
          ctx.lineWidth = command.width;
          lineWidth = command.width;
        }
        if (lineCap !== command.cap) {
          ctx.lineCap = command.cap;
          lineCap = command.cap;
        }
        if (lineJoin !== command.join) {
          ctx.lineJoin = command.join;
          lineJoin = command.join;
        }
        if (command.kind === "stroke") {
          if (strokeColor !== command.color) {
            ctx.strokeStyle = command.color;
            strokeColor = command.color;
          }
          let sameDash = dash === command.dash;
          if (!sameDash && dash && dash.length === command.dash.length) {
            sameDash = true;
            for (let i = 0; i < dash.length; i++)
              if (dash[i] !== command.dash[i]) {
                sameDash = false;
                break;
              }
          }
          if (!sameDash) {
            setLineDash(command.dash);
            dash = command.dash;
          }
          stroke(command.path);
        } else {
          if (fillColor !== command.color) {
            ctx.fillStyle = command.color;
            fillColor = command.color;
          }
          fill(command.path);
        }
      }
    }
    restore();
  }
}
