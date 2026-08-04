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
import {
  CORE_STORYBOOK_SNAPSHOT_CASES,
  REUSABLE_UI_SNAPSHOT_CASES,
  STORYBOOK_SNAPSHOT_CASES,
} from "../../client/src/stories/snapshot-cases";
import {
  RESPONSIVE_INTERACTION_CASES,
  RESPONSIVE_PAGES,
  RESPONSIVE_SCREENSHOT_COUNT,
  RESPONSIVE_VIEWPORTS,
} from "../../playwright/responsive-screenshot-cases";
import type { ScreenshotDiff } from "../../scripts/ui/collect-screenshot-diffs";
import { writeUiDiffReport } from "../../scripts/ui/local-ui-diff";

const tempDirs: string[] = [];
const repoRoot = resolve(import.meta.dir, "../..");

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
    const reusableUiSnapshot = readFileSync(
      join(repoRoot, "client/src/stories/reusable-ui.snapshot.ts"),
      "utf8",
    );
    const responsiveConfig = readFileSync(
      join(repoRoot, "playwright/playwright.config.ts"),
      "utf8",
    );
    const responsiveWorkflow = readFileSync(
      join(repoRoot, ".github/workflows/pr-screenshots.yml"),
      "utf8",
    );
    const devLauncher = readFileSync(
      join(repoRoot, "playwright/start-dev-server.ts"),
      "utf8",
    );
    const productionLauncher = readFileSync(
      join(repoRoot, "playwright/start-server.ts"),
      "utf8",
    );
    const seedHelper = readFileSync(
      join(repoRoot, "playwright/seed-screenshot-data.ts"),
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
    expect(screenshotCases).toContain('{ name: "fm23-analyse", path: "/fm23/analyse" }');
    expect(screenshotCases).toContain('{ name: "acc-setups", path: "/acc/setups" }');
    expect(screenshotCases).toContain('name: "iracing-track-detail"');
    expect(screenshotCases).toContain('path: "/iracing/tracks/18/info"');
    expect(screenshotCases).toContain('name: "iracing-seeded-laps"');
    expect(screenshotCases).toContain('name: "f125-experiment-detail"');
    expect(screenshotCases).toContain('name: "f125-experiment-review"');
    expect(screenshotCases).toContain('name: "ac-evo-live"');
    expect(screenshotCases).toContain('name: "nav-drawer-open"');
    expect(screenshotCases).toContain('name: "settings-modal"');
    expect(screenshotCases).toContain('name: "settings-language-menu"');
    expect(screenshotCases).toContain('name: "analyse-actions-menu"');
    expect(screenshots).toContain("RESPONSIVE_INTERACTION_CASES");
    expect(responsiveConfig).toContain("RACEIQ_APP_ROOT");
    expect(responsiveConfig).toContain("PW_SCREENSHOT_ONLY");
    expect(responsiveConfig).toContain("PW_SCREENSHOT_WORKERS");
    expect(responsiveConfig).toContain("fullyParallel: PARALLEL_SCREENSHOT_RUN");
    expect(responsiveWorkflow).toContain('- "playwright/**"');
    expect(responsiveWorkflow).toContain('PW_SEED_SCREENSHOTS: "1"');
    expect(devLauncher).toContain("seedScreenshotData(repoDir, dir)");
    expect(productionLauncher).toContain("seedScreenshotData(repoDir, dir)");
    expect(seedHelper).toContain('process.env.PW_SEED_SCREENSHOTS !== "1"');
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
    expect(reusableUiSnapshot).toContain("REUSABLE_UI_SNAPSHOT_CASES");
    expect(packageJson.scripts["ui:diff"]).toBe("bun scripts/ui/local-ui-diff.ts");
    expect(packageJson.scripts["ui:diff:storybook"]).toBe("bun scripts/ui/local-ui-diff.ts --storybook-only");
    expect(packageJson.scripts["test:screenshots"]).toContain("PW_SEED_SCREENSHOTS=1");
    expect(gitignore).toContain(".ui-diff/");
  });

  test("requires every Storybook baseline in the bounded manifest", () => {
    const manifest = STORYBOOK_SNAPSHOT_CASES.map((entry) => entry.outputName).sort();
    const committed = readdirSync(
      join(repoRoot, "client/src/stories/__snapshots__"),
    )
      .filter((entry) => entry.startsWith("snapshot-") && entry.endsWith(".png"))
      .sort();

    expect(committed).toEqual(manifest);
  });

  test("keeps screenshot coverage bounded to high-value visual states", () => {
    expect(RESPONSIVE_VIEWPORTS).toHaveLength(3);
    expect(RESPONSIVE_PAGES).toHaveLength(51);
    expect(RESPONSIVE_INTERACTION_CASES).toHaveLength(4);
    expect(RESPONSIVE_SCREENSHOT_COUNT).toBe(97);
    expect(CORE_STORYBOOK_SNAPSHOT_CASES).toHaveLength(8);
    expect(REUSABLE_UI_SNAPSHOT_CASES).toHaveLength(9);
    expect(STORYBOOK_SNAPSHOT_CASES).toHaveLength(17);
    expect(RESPONSIVE_SCREENSHOT_COUNT + STORYBOOK_SNAPSHOT_CASES.length).toBe(114);
  });
});
