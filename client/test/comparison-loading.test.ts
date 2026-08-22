import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TelemetryChart, CursorLoadingIndicator } from "../src/components/TelemetryChart";
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
  test("renders cursor loading indicator while detail metrics are fetching", () => {
    const markup = renderToStaticMarkup(createElement(CursorLoadingIndicator, { loading: true, left: 120 }));
    expect(markup).toContain("compare-cursor-loading");
    expect(markup).toContain("Loading detailed metrics");
  });
});
