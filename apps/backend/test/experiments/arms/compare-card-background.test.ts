import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LAP_COMPARISON_SOURCE = readFileSync(resolve(ROOT_DIR, "test/experiments/arms/client/src/components/comparison/ComparisonCharts"), "utf8");

test("compare graph cards keep borders without gray backgrounds", () => {
  const graphCardClasses = [...LAP_COMPARISON_SOURCE.matchAll(/className="([^"]*rounded-lg border border-app-border p-1[^"]*)"/g)].map((match) => match[1]);

  expect(graphCardClasses.length).toBeGreaterThanOrEqual(4);
  expect(graphCardClasses.every((classes) => !classes.includes("bg-app-surface"))).toBe(true);
});
