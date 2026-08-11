import { afterEach, describe, expect, test } from "bun:test";
import { resolveCssColor } from "../src/lib/rendering/css-values";

describe("CSS renderer color resolution", () => {
  const originalDocument = globalThis.document;
  const originalGetComputedStyle = globalThis.getComputedStyle;

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalGetComputedStyle;
  });

  test("normalizes browser color formats Three.js cannot parse", () => {
    const probe = { style: {}, remove() {} };
    const canvasContext = {
      _fillStyle: "#010203",
      clearRect() {},
      fillRect() {},
      getImageData() {
        return { data: new Uint8ClampedArray([251, 191, 36, 255]) };
      },
    };
    Object.defineProperty(canvasContext, "fillStyle", {
      get() {
        return this._fillStyle;
      },
      set(value: string) {
        this._fillStyle = value;
      },
    });

    globalThis.document = {
      createElement(tag: string) {
        if (tag === "canvas") return { getContext: () => canvasContext };
        return probe;
      },
      documentElement: { appendChild() {} },
      body: null,
    } as never;
    globalThis.getComputedStyle = (() => ({ color: "oklch(0.8 0.15 85)" })) as never;

    expect(resolveCssColor("var(--test-oklch-color)")).toBe("rgb(251, 191, 36)");
  });
});
