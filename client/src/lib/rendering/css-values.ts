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

function referencedRootVariablesAreReady(value: string): boolean {
  const variableNames = Array.from(value.matchAll(/var\(\s*(--[\w-]+)/g), (match) => match[1]);
  if (variableNames.length === 0) return true;

  const rootStyle = getComputedStyle(document.documentElement);
  return variableNames.every((variableName) => rootStyle.getPropertyValue(variableName).trim().length > 0);
}

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

/** Resolve a CSS color for a main-thread imperative renderer. */
export function resolveCssColor(color: string): string {
  if (!color.includes("var(") && !color.includes("color-mix(")) return color;

  ensureThemeObserver();
  const cached = resolvedColorCache.get(color);
  if (cached) return cached;
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return color;
  // Storybook can mount React before its theme stylesheet has finished
  // resolving. In that window, a probe reports the browser's inherited black
  // fallback. Never cache that transient value; the next renderer pass must
  // retry once the root variables exist.
  if (!referencedRootVariablesAreReady(color)) return color;

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

/** Resolve a CSS font shorthand for Canvas or a chart library. */
export function resolveCssFont(font: string): string {
  if (!font.includes("var(")) return font;

  ensureThemeObserver();
  const cached = resolvedFontCache.get(font);
  if (cached) return cached;
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return font;
  if (!referencedRootVariablesAreReady(font)) return font;

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
