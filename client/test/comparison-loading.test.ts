import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PointerLoadingIndicator } from "../src/components/PointerLoadingIndicator";
import { ComparisonLoadStatus } from "../src/components/comparison/LapComparison";
import { m } from "../src/paraglide/messages";

describe("comparison loading state", () => {
  test("does not show loading status over an already loaded comparison", () => {
    const markup = renderToStaticMarkup(createElement(ComparisonLoadStatus, { loading: true, error: null, hasComparison: true }));
    expect(markup).toBe("");
  });

  test("shows loading status while the initial comparison is pending", () => {
    const markup = renderToStaticMarkup(createElement(ComparisonLoadStatus, { loading: true, error: null, hasComparison: false }));
    expect(markup).toContain(m.compare_loading());
  });
  test("renders reusable page-level loading indicator next to actual pointer", () => {
    const markup = renderToStaticMarkup(
      createElement(PointerLoadingIndicator, { loading: true, position: { x: 420, y: 160 }, label: "Fetching higher-fidelity datapoints" }),
    );
    expect(markup).toContain("pointer-loading-indicator");
    expect(markup).toContain("fixed");
    expect(markup).toContain("left:432px");
    expect(markup).toContain("Fetching higher-fidelity datapoints");
    expect(markup).toContain("top:148px");
  });
});
