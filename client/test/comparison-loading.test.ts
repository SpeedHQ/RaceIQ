import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComparisonLoadStatus } from "../src/components/LapComparison";
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
});
