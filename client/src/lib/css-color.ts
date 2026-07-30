const resolvedColorCache = new Map<string, string>();
const resolvedFontCache = new Map<string, string>();
type Canvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const semanticCanvasContexts = new WeakMap<Canvas2DContext, Canvas2DContext>();
let themeObserverInstalled = false;

/** Clear imperative-renderer values after changing theme variables programmatically. */
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

/**
 * Resolve a semantic CSS color for imperative renderers such as Canvas and
 * Three.js. Global theme selectors belong on documentElement. DOM/SVG callers
 * should use the CSS variable directly.
 */
export function resolveCssColor(color: string): string {
  if (!color.includes("var(") && !color.includes("color-mix(")) return color;

  ensureThemeObserver();
  const cached = resolvedColorCache.get(color);
  if (cached) return cached;
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return color;

  const probe = document.createElement("span");
  probe.style.color = color;
  probe.style.position = "absolute";
  probe.style.pointerEvents = "none";
  probe.style.visibility = "hidden";
  document.documentElement.appendChild(probe);
  const resolved = getComputedStyle(probe).color.trim();
  probe.remove();

  if (resolved) {
    resolvedColorCache.set(color, resolved);
    return resolved;
  }
  return color;
}

/**
 * Resolve the CSS-variable font shorthand used by Canvas and chart libraries.
 * DOM and SVG callers should continue to use the theme variables directly.
 */
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

/**
 * Canvas does not resolve CSS custom properties in color or font assignments.
 * This adapter keeps imperative drawing code on the same semantic CSS
 * contract as DOM and SVG renderers.
 */
export function getSemanticCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null;
export function getSemanticCanvasContext(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D | null;
export function getSemanticCanvasContext(canvas: HTMLCanvasElement | OffscreenCanvas): Canvas2DContext | null {
  const context = canvas.getContext("2d") as Canvas2DContext | null;
  if (!context) return null;

  const cached = semanticCanvasContexts.get(context);
  if (cached) return cached;

  const semanticContext = new Proxy(context, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      let nextValue = value;
      if (typeof value === "string") {
        if (property === "fillStyle" || property === "strokeStyle" || property === "shadowColor") {
          nextValue = resolveCssColor(value);
        } else if (property === "font") {
          nextValue = resolveCssFont(value);
        }
      }
      return Reflect.set(target, property, nextValue, target);
    },
  });

  semanticCanvasContexts.set(context, semanticContext);
  return semanticContext;
}
