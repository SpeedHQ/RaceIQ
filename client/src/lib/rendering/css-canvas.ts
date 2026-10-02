import { resolveCssColor, resolveCssFont } from "./css-values";

const semanticCanvasContexts = new WeakMap<CanvasRenderingContext2D, CanvasRenderingContext2D>();

/**
 * Return a main-thread HTML Canvas context that resolves theme-owned colors
 * and fonts at the imperative rendering boundary.
 *
 * OffscreenCanvas is deliberately unsupported: a worker has no document or
 * getComputedStyle, so worker rendering must receive already-resolved values.
 * A detached HTMLCanvasElement can be used for main-thread buffered drawing.
 */
export function getSemanticCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const context = canvas.getContext("2d");
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
