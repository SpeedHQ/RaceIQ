import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORYBOOK_SNAPSHOT_CASES } from "client/src/stories/snapshot-cases";
import type { ScreenshotDiff } from "@raceiq/tooling/ui/collect-screenshot-diffs";
import { writeUiDiffReport } from "@raceiq/tooling/ui/local-ui-diff";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-ui-diff-report-"));
  tempDirs.push(dir);
  return dir;
}

function change(status: ScreenshotDiff["status"], relativePath: string, pixelRatio: number, prefix = "responsive"): ScreenshotDiff {
  const stem = `${status}--${prefix}--${relativePath.replaceAll("/", "--").replace(".png", "")}`;
  return {
    status,
    prefix,
    relativePath,
    stem,
    width: 390,
    height: 844,
    differingPixels: status === "changed" ? 390 : null,
    pixelRatio,
    beforeFile: `${stem}-before.png`,
    afterFile: `${stem}-after.png`,
    diffFile: `${stem}-diff.png`,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local UI diff report", () => {
  test("writes machine-readable counts and a filterable visual gallery", async () => {
    const reportDir = makeTempDir();
    const reportPath = await writeUiDiffReport(
      reportDir,
      {
        generatedAt: "2026-07-30T12:00:00.000Z",
        baseRef: "origin/main",
        baseSha: "1111111111111111111111111111111111111111",
        currentSha: "2222222222222222222222222222222222222222",
        dirtyFiles: [" M client/src/App.tsx"],
        partial: false,
        errors: [],
      },
      [
        change("changed", "mobile/home.png", 0.125),
        change("added", "tablet/new-page.png", 1),
        change("removed", "desktop/old-page.png", 1),
        change("changed", "snapshot-F1LiveDashboard.png", 0.05, "storybook"),
      ],
    );

    const report = JSON.parse(readFileSync(join(reportDir, "report.json"), "utf8"));
    expect(report.counts).toEqual({ total: 4, changed: 2, added: 1, removed: 1 });
    expect(report.changes[0].beforePath).toBe("images/changed--responsive--mobile--home-before.png");
    expect(report.changes.map((entry: { viewport: string }) => entry.viewport)).toEqual(["mobile", "tablet", "desktop", "storybook"]);

    const html = readFileSync(reportPath, "utf8");
    expect(html).toContain("RaceIQ local UI diff");
    expect(html).toContain('id="search"');
    expect(html).toContain('id="status"');
    expect(html).toContain('id="viewport"');
    expect(html).toContain("Overlay comparison");
    expect(html).toContain("12.50% pixels changed");
    expect(html).toContain("1 dirty path");
  });

  test("marks incomplete runs and escapes capture errors", async () => {
    const reportDir = makeTempDir();
    const reportPath = await writeUiDiffReport(
      reportDir,
      {
        generatedAt: "2026-07-30T12:00:00.000Z",
        baseRef: "origin/main",
        baseSha: null,
        currentSha: null,
        dirtyFiles: [],
        partial: true,
        errors: ["capture failed: <server unavailable>"],
      },
      [],
    );

    const html = readFileSync(reportPath, "utf8");
    expect(html).toContain("Partial comparison");
    expect(html).toContain("capture failed: &lt;server unavailable&gt;");
    expect(html).toContain("No comparable differences collected");
    expect(html).not.toContain("capture failed: <server unavailable>");
  });


  test("keeps generated Storybook outputs unique and bounded by the manifest", () => {
    const outputs = STORYBOOK_SNAPSHOT_CASES.map((entry) => entry.outputName);

    expect(new Set(outputs).size).toBe(outputs.length);
    expect(outputs.every((output) => /^snapshot-[A-Za-z0-9-]+\.png$/.test(output))).toBeTrue();
  });

});
