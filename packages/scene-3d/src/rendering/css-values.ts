/**
 * DOM-backed CSS value resolution for main-thread imperative renderers.
 *
 * Use this bridge only when an API such as Canvas, uPlot, Three.js, or image
 * export cannot consume CSS custom properties directly. DOM and SVG callers
 * should keep using the theme variables in CSS. This module intentionally
 * depends on document/getComputedStyle and is not available in workers.
 */
const resolvedColorCache = new Map<string, string>();
const resolvedFontCache = new Map<string, string>();
let themeObserverInstalled = false;
let colorContext: CanvasRenderingContext2D | null = null;

/** Clear resolved renderer values after changing theme variables programmatically. */
export function invalidateCssValueCaches(): void {
  resolvedColorCache.clear();
  resolvedFontCache.clear();
}

function ensureThemeObserver(): void {
  if (themeObserverInstalled || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  const observer = new MutationObserver(invalidateCssValueCaches);
  const options: MutationObserverInit = { attributes: true, attributeFilter: ["class", "data-theme", "style"] };
  observer.observe(document.documentElement, options);
  if (document.body) observer.observe(document.body, options);
  themeObserverInstalled = true;
}

function readRendererColor(color: string): string {
  const variable = /^var\((--[\w-]+)\)$/.exec(color);
  if (variable) {
    const token = getComputedStyle(document.documentElement).getPropertyValue(variable[1]!).trim();
    if (/^#[0-9a-f]{6}$/i.test(token)) {
      const rgb = Number.parseInt(token.slice(1), 16);
      return `rgb(${rgb >>> 16}, ${(rgb >>> 8) & 255}, ${rgb & 255})`;
    }
    if (/^oklch\([\d.\s%/+-]+\)$/i.test(token) && typeof CSS !== "undefined" && CSS.supports("color", token)) return token;
  }
  const probe = document.createElement("span");
  probe.style.color = color;
  probe.style.position = "absolute";
  probe.style.pointerEvents = "none";
  probe.style.visibility = "hidden";
  document.documentElement.appendChild(probe);
  const resolved = getComputedStyle(probe).color.trim();
  probe.remove();
  return resolved;
}

/** Resolve a CSS color for a main-thread imperative renderer. */
export function resolveCssColor(color: string): string {
  if (!color.includes("var(") && !color.includes("color-mix(")) return color;

  ensureThemeObserver();
  const cached = resolvedColorCache.get(color);
  if (cached) return cached;
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return color;

  const resolved = readRendererColor(color);

  if (resolved) {
    // Three.Color does not parse every CSS Color 4 format (for example oklch
    // returned by Tailwind variables). Rasterize through the browser's CSS
    // engine, then hand Three.js an rgb/rgba string it can parse.
    if (/^rgb\(\d+, \d+, \d+\)$/.test(resolved)) {
      resolvedColorCache.set(color, resolved);
      return resolved;
    }
    if (!colorContext || colorContext.canvas?.ownerDocument !== document) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      colorContext = canvas.getContext("2d", { willReadFrequently: true });
    }
    const context = colorContext;
    if (context) {
      context.fillStyle = "rgb(1, 2, 3)";
      const sentinel = context.fillStyle;
      context.fillStyle = resolved;
      if (context.fillStyle !== sentinel && typeof context.getImageData === "function") {
        context.clearRect(0, 0, 1, 1);
        context.fillRect(0, 0, 1, 1);
        const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
        const normalized = alpha === 255 ? `rgb(${red}, ${green}, ${blue})` : `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
        resolvedColorCache.set(color, normalized);
        return normalized;
      }
    }
    resolvedColorCache.set(color, resolved);
    return resolved;
  }
  return color;
}

/** Resolve a CSS font shorthand for Canvas or a chart library. */
export function resolveCssFont(font: string): string {
  if (!font.includes("var(")) return font;

  ensureThemeObserver();
  const cached = resolvedFontCache.get(font);
  if (cached) return cached;
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return font;

  const probe = document.createElement("span");
  probe.style.font = font;
  probe.style.position = "absolute";
  probe.style.pointerEvents = "none";
  probe.style.visibility = "hidden";
  document.documentElement.appendChild(probe);
  const resolved = getComputedStyle(probe).font.trim();
  probe.remove();

  if (resolved) {
    resolvedFontCache.set(font, resolved);
    return resolved;
  }
  return font;
}

/** Interpolate CSS-owned endpoints without hard-coding their RGB values. */
export function mixCssColors(from: string, to: string, amount: number): string {
  const t = Math.min(1, Math.max(0, amount));
  // Continuous telemetry can contain thousands of distinct values. Quantizing
  // to one-percent steps keeps the resolver cache bounded without a visible
  // change in the rendered gradient.
  const toPercent = Math.round(t * 100);
  return resolveCssColor(`color-mix(in srgb, ${from} ${100 - toPercent}%, ${to} ${toPercent}%)`);
}
