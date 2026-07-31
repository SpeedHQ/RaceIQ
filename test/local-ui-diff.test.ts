import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ScreenshotDiff } from "../scripts/collect-screenshot-diffs";
import { writeUiDiffReport } from "../scripts/local-ui-diff";
import { STORYBOOK_SNAPSHOT_CASES } from "../client/src/stories/snapshot-cases";

const tempDirs: string[] = [];
const repoRoot = resolve(import.meta.dir, "..");

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-ui-diff-report-"));
  tempDirs.push(dir);
  return dir;
}

function change(
  status: ScreenshotDiff["status"],
  relativePath: string,
  pixelRatio: number,
  prefix = "responsive",
): ScreenshotDiff {
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
    expect(report.changes[0].beforePath).toBe(
      "images/changed--responsive--mobile--home-before.png",
    );
    expect(
      report.changes.map((entry: { viewport: string }) => entry.viewport),
    ).toEqual(["mobile", "tablet", "desktop", "storybook"]);

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

  test("keeps capture paths configurable while preserving existing defaults", () => {
    const screenshots = readFileSync(
      join(repoRoot, "playwright/mobile-responsive.spec.ts"),
      "utf8",
    );
    const screenshotCases = readFileSync(
      join(repoRoot, "playwright/responsive-screenshot-cases.ts"),
      "utf8",
    );
    const runner = readFileSync(join(repoRoot, "scripts/local-ui-diff.ts"), "utf8");
    const snapshotCases = readFileSync(
      join(repoRoot, "client/src/stories/snapshot-cases.ts"),
      "utf8",
    );
    const dashboardSnapshots = readFileSync(
      join(repoRoot, "client/src/stories/dashboards.snapshot.ts"),
      "utf8",
    );
    const themeSnapshot = readFileSync(
      join(repoRoot, "client/src/stories/theme.snapshot.ts"),
      "utf8",
    );
    const responsiveConfig = readFileSync(
      join(repoRoot, "playwright/playwright.config.ts"),
      "utf8",
    );
    const storybookConfig = readFileSync(
      join(repoRoot, "client/playwright.config.ts"),
      "utf8",
    );
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");

    expect(screenshots).toContain(
      'process.env.RACEIQ_SCREENSHOT_DIR ?? "./screenshots/mobile"',
    );
    expect(screenshots).toContain("RESPONSIVE_VIEWPORTS");
    expect(screenshotCases).toContain('{ name: "mobile", width: 390, height: 844 }');
    expect(screenshotCases).toContain('{ name: "home", path: "/" }');
    expect(screenshotCases).toContain('name: "nav-drawer-open"');
    expect(screenshotCases).toContain('name: "settings-modal"');
    expect(screenshots).toContain("RESPONSIVE_INTERACTION_CASES");
    expect(runner).toContain('Bun.which("node")');
    expect(runner).toContain('"--project=mobile-screenshots"');
    expect(runner).toContain('"dashboards.snapshot.ts"');
    expect(runner).toContain('"theme.snapshot.ts"');
    expect(runner).toContain('prefix: "storybook"');
    expect(responsiveConfig).toContain("RACEIQ_APP_ROOT");
    expect(responsiveConfig).toContain("PW_SCREENSHOT_ONLY");
    expect(storybookConfig).toContain("RACEIQ_STORYBOOK_ROOT");
    expect(storybookConfig).toContain("RACEIQ_SNAPSHOT_DIR");
    expect(
      existsSync(join(repoRoot, "scripts/chromium-cdp.ts")),
    ).toBeFalse();
    expect(snapshotCases).toContain('outputName: "snapshot-F1LiveDashboard.png"');
    expect(snapshotCases).toContain(
      'outputName: "snapshot-theme-semantic-states.png"',
    );
    expect(dashboardSnapshots).toContain("DASHBOARD_SNAPSHOT_CASES");
    expect(themeSnapshot).toContain("THEME_SNAPSHOT_CASE");
    expect(packageJson.scripts["ui:diff"]).toBe("bun scripts/local-ui-diff.ts");
    expect(gitignore).toContain(".ui-diff/");
  });

  test("shares the complete committed Storybook screenshot inventory", () => {
    const manifest = STORYBOOK_SNAPSHOT_CASES.map((entry) => entry.outputName).sort();
    const committed = readdirSync(
      join(repoRoot, "client/src/stories/__snapshots__"),
    )
      .filter((entry) => entry.startsWith("snapshot-") && entry.endsWith(".png"))
      .sort();

    expect(manifest).toEqual(committed);
  });
});
