import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const dashboardPath = new URL("../src/components/tunes/review/SessionReviewDashboard.tsx", import.meta.url);

describe("session review toolbar layout", () => {
  test("keeps review tabs inline instead of allocating metadata row", async () => {
    const source = await readFile(dashboardPath, "utf8");

    expect(source).toContain('{sessionLabel && <span className="ml-auto text-xs text-app-text-dim">Showing up to five fastest clean laps.</span>}');
    expect(source).toContain('<div className="ml-auto flex gap-1">');
    expect(source).not.toContain('className="w-fit px-4 py-1 text-xs text-app-text-dim"');
  });
});
