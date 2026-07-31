#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  collectScreenshotDiffs,
  type ScreenshotDiff,
} from "./collect-screenshot-diffs";

interface CliOptions {
  baseRef: string;
  fetchMain: boolean;
  open: boolean;
  storybookOnly: boolean;
}

export interface UiDiffMetadata {
  generatedAt: string;
  baseRef: string;
  baseSha: string | null;
  currentSha: string | null;
  dirtyFiles: string[];
  partial: boolean;
  errors: string[];
}

interface ReportChange extends ScreenshotDiff {
  viewport: string;
  beforePath: string;
  afterPath: string;
  diffPath: string;
}

function parseArgs(args: string[]): CliOptions {
  let baseRef = "origin/main";
  let fetchMain = true;
  let open = false;
  let storybookOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base") {
      const value = args[index + 1];
      if (!value) throw new Error("--base requires a Git ref");
      baseRef = value;
      fetchMain = false;
      index += 1;
    } else if (arg === "--no-fetch") {
      fetchMain = false;
    } else if (arg === "--open") {
      open = true;
    } else if (arg === "--storybook-only") {
      storybookOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: bun run ui:diff [--base REF] [--no-fetch] [--open] [--storybook-only]",
          "",
          "Requires Node.js to run Playwright.",
          "Use this same-renderer comparison before push; direct client snapshot:test",
          "compares pinned Linux baselines and may expose local font-rasterization noise.",
          "",
          "  --base REF   Compare with an explicit Git ref (default: origin/main)",
          "  --no-fetch   Use the locally known origin/main",
          "  --open       Open the generated HTML report",
          "  --storybook-only  Skip responsive app captures and compare Storybook only",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { baseRef, fetchMain, open, storybookOnly };
}

async function run(
  command: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    quiet?: boolean;
  },
): Promise<string> {
  if (!options.quiet) console.log(`\n> ${command.join(" ")}`);
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: options.quiet ? "pipe" : "inherit",
    stderr: options.quiet ? "pipe" : "inherit",
  });
  const exitCode = await proc.exited;
  const stdout = options.quiet ? await new Response(proc.stdout).text() : "";
  const stderr = options.quiet ? await new Response(proc.stderr).text() : "";
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      `Command failed (${exitCode}): ${command.join(" ")}${detail ? `\n${detail}` : ""}`,
    );
  }
  return stdout.trimEnd();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requireNode(repoRoot: string): Promise<string> {
  const missingNode = () =>
    new Error(
      "Node.js is required for `bun run ui:diff`. Install Node.js, then rerun. " +
        "The Playwright runner cannot use Bun's Node compatibility layer on Windows.",
    );
  const nodePath = [
    Bun.which("node"),
    process.platform === "win32"
      ? "C:\\Program Files\\nodejs\\node.exe"
      : undefined,
  ].find(
    (candidate): candidate is string =>
      Boolean(
        candidate &&
          !candidate.includes("bun-node-") &&
          existsSync(candidate),
      ),
  );
  if (!nodePath) throw missingNode();

  let version: string;
  try {
    version = await run([nodePath, "--version"], {
      cwd: repoRoot,
      quiet: true,
    });
  } catch {
    throw missingNode();
  }
  console.log(`Using Node.js ${version}`);
  return nodePath;
}

function requirePlaywrightCli(repoRoot: string, workspace: "client" | "playwright"): string {
  const candidates = [
    join(repoRoot, workspace, "node_modules", "@playwright", "test", "cli.js"),
    join(repoRoot, "node_modules", "@playwright", "test", "cli.js"),
  ];
  const cli = candidates.find((candidate) => existsSync(candidate));
  if (!cli) throw new Error(`Playwright CLI is missing for ${workspace}; run bun install before UI comparison`);
  return cli;
}

async function removeRuntimeData(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(250);
    }
  }
  console.warn(`Could not remove UI-diff runtime data ${path}: ${errorMessage(lastError)}`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value < 0.001 ? 3 : 2)}%`;
}

function reportChanges(changes: ScreenshotDiff[]): ReportChange[] {
  return changes.map((change) => ({
    ...change,
    viewport:
      change.prefix === "responsive"
        ? change.relativePath.split("/")[0] || "unknown"
        : "storybook",
    beforePath: `images/${change.beforeFile}`,
    afterPath: `images/${change.afterFile}`,
    diffPath: `images/${change.diffFile}`,
  }));
}

export async function writeUiDiffReport(
  reportDir: string,
  metadata: UiDiffMetadata,
  changes: ScreenshotDiff[],
): Promise<string> {
  mkdirSync(reportDir, { recursive: true });
  const prepared = reportChanges(changes);
  const counts = {
    total: prepared.length,
    changed: prepared.filter((change) => change.status === "changed").length,
    added: prepared.filter((change) => change.status === "added").length,
    removed: prepared.filter((change) => change.status === "removed").length,
  };
  const report = { metadata, counts, changes: prepared };
  await Bun.write(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const viewports = [...new Set(prepared.map((change) => change.viewport))].sort();
  const cards = prepared
    .map((change) => {
      const detail =
        change.status === "changed" && change.differingPixels === 0 && change.pixelRatio === 1
          ? "dimensions changed"
          : `${percent(change.pixelRatio)} pixels changed`;
      return `
        <article class="card" data-status="${change.status}" data-viewport="${escapeHtml(change.viewport)}" data-path="${escapeHtml(change.relativePath.toLowerCase())}">
          <header>
            <span class="badge ${change.status}">${change.status}</span>
            <h2>${escapeHtml(change.relativePath)}</h2>
            <span class="detail">${escapeHtml(detail)} · ${change.width}×${change.height}</span>
          </header>
          <div class="triptych">
            <figure><figcaption>Before</figcaption><a href="${escapeHtml(change.beforePath)}"><img src="${escapeHtml(change.beforePath)}" alt="Before ${escapeHtml(change.relativePath)}"></a></figure>
            <figure><figcaption>After</figcaption><a href="${escapeHtml(change.afterPath)}"><img src="${escapeHtml(change.afterPath)}" alt="After ${escapeHtml(change.relativePath)}"></a></figure>
            <figure><figcaption>Diff</figcaption><a href="${escapeHtml(change.diffPath)}"><img src="${escapeHtml(change.diffPath)}" alt="Diff ${escapeHtml(change.relativePath)}"></a></figure>
          </div>
          <details>
            <summary>Overlay comparison</summary>
            <div class="overlay" style="--split: 50%">
              <img src="${escapeHtml(change.beforePath)}" alt="">
              <img class="overlay-after" src="${escapeHtml(change.afterPath)}" alt="">
            </div>
            <input class="split" type="range" min="0" max="100" value="50" aria-label="Before and after split">
          </details>
        </article>`;
    })
    .join("\n");

  const errorPanel =
    metadata.errors.length > 0
      ? `<section class="errors"><h2>Partial comparison</h2><p>Missing captures are not classified as added or removed.</p><ul>${metadata.errors
          .map((error) => `<li><pre>${escapeHtml(error)}</pre></li>`)
          .join("")}</ul></section>`
      : "";
  const emptyState =
    prepared.length === 0
      ? `<section class="empty"><h2>${metadata.partial ? "No comparable differences collected" : "No material UI differences"}</h2><p>${metadata.partial ? "Fix capture errors above, then rerun." : "Current responsive screenshots match baseline within configured tolerance."}</p></section>`
      : "";
  const dirtyLabel =
    metadata.dirtyFiles.length > 0
      ? `${metadata.dirtyFiles.length} dirty path${metadata.dirtyFiles.length === 1 ? "" : "s"}`
      : "clean HEAD";
  const viewportOptions = viewports
    .map((viewport) => `<option value="${escapeHtml(viewport)}">${escapeHtml(viewport)}</option>`)
    .join("");
  const serialisedReport = JSON.stringify(report).replaceAll("<", "\\u003c");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RaceIQ local UI diff</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #090d14; color: #edf2f7; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(1800px, 100%); margin: auto; padding: 24px; }
    .hero { display: flex; flex-wrap: wrap; gap: 20px; align-items: end; justify-content: space-between; margin-bottom: 20px; }
    h1 { margin: 0 0 6px; font-size: clamp(24px, 4vw, 40px); }
    .meta { color: #94a3b8; margin: 3px 0; font-family: ui-monospace, monospace; font-size: 13px; }
    .counts { display: flex; flex-wrap: wrap; gap: 8px; }
    .count, .badge { border-radius: 999px; padding: 6px 10px; background: #172033; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    .controls { position: sticky; top: 0; z-index: 5; display: grid; grid-template-columns: minmax(220px, 1fr) repeat(2, minmax(130px, 220px)); gap: 10px; padding: 12px; margin: 0 0 18px; background: rgb(9 13 20 / 92%); backdrop-filter: blur(10px); border: 1px solid #243047; border-radius: 12px; }
    input, select { width: 100%; border: 1px solid #334155; border-radius: 8px; background: #111827; color: inherit; padding: 9px 11px; }
    .card { border: 1px solid #243047; border-radius: 14px; background: #0f1623; padding: 16px; margin-bottom: 20px; box-shadow: 0 18px 50px rgb(0 0 0 / 18%); }
    .card header { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .card h2 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
    .detail { color: #94a3b8; margin-left: auto; font-size: 12px; }
    .badge { font-weight: 700; padding: 4px 8px; }
    .badge.changed { background: #78350f; color: #fde68a; }
    .badge.added { background: #064e3b; color: #a7f3d0; }
    .badge.removed { background: #7f1d1d; color: #fecaca; }
    .triptych { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    figure { margin: 0; min-width: 0; }
    figcaption { color: #cbd5e1; font-size: 12px; margin: 0 0 6px; }
    figure img, .overlay img { width: 100%; height: auto; display: block; border-radius: 6px; background: #111827; }
    details { margin-top: 12px; }
    summary { cursor: pointer; color: #93c5fd; }
    .overlay { display: grid; position: relative; margin-top: 10px; overflow: hidden; border-radius: 6px; }
    .overlay img { grid-area: 1 / 1; }
    .overlay-after { clip-path: inset(0 calc(100% - var(--split)) 0 0); }
    .split { margin-top: 8px; padding: 0; }
    .errors, .empty { border: 1px solid #7f1d1d; background: #2a1116; border-radius: 12px; padding: 16px; margin-bottom: 18px; }
    .empty { border-color: #1e3a5f; background: #0d1d2f; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0; }
    [hidden] { display: none !important; }
    @media (max-width: 900px) { main { padding: 14px; } .controls { grid-template-columns: 1fr; position: static; } .triptych { grid-template-columns: 1fr; } .detail { margin-left: 0; width: 100%; } }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <h1>RaceIQ local UI diff</h1>
        <p class="meta">Base: ${escapeHtml(metadata.baseRef)} · ${escapeHtml(metadata.baseSha?.slice(0, 12) ?? "unavailable")}</p>
        <p class="meta">Current: ${escapeHtml(metadata.currentSha?.slice(0, 12) ?? "unavailable")} · ${escapeHtml(dirtyLabel)}</p>
        <p class="meta">Generated: ${escapeHtml(metadata.generatedAt)}</p>
      </div>
      <div class="counts">
        <span class="count">${counts.total} total</span>
        <span class="count">${counts.changed} changed</span>
        <span class="count">${counts.added} added</span>
        <span class="count">${counts.removed} removed</span>
      </div>
    </section>
    ${errorPanel}
    <section class="controls" aria-label="Report filters">
      <input id="search" type="search" placeholder="Filter screenshot path">
      <select id="status"><option value="">All statuses</option><option value="changed">Changed</option><option value="added">Added</option><option value="removed">Removed</option></select>
      <select id="viewport"><option value="">All viewports</option>${viewportOptions}</select>
    </section>
    ${emptyState}
    <section id="cards">${cards}</section>
  </main>
  <script type="application/json" id="report-data">${serialisedReport}</script>
  <script>
    const search = document.querySelector("#search");
    const status = document.querySelector("#status");
    const viewport = document.querySelector("#viewport");
    const cards = [...document.querySelectorAll(".card")];
    function filter() {
      const query = search.value.trim().toLowerCase();
      for (const card of cards) {
        card.hidden = Boolean(
          (query && !card.dataset.path.includes(query)) ||
          (status.value && card.dataset.status !== status.value) ||
          (viewport.value && card.dataset.viewport !== viewport.value)
        );
      }
    }
    search.addEventListener("input", filter);
    status.addEventListener("change", filter);
    viewport.addEventListener("change", filter);
    for (const slider of document.querySelectorAll(".split")) {
      slider.addEventListener("input", () => slider.previousElementSibling.style.setProperty("--split", slider.value + "%"));
    }
  </script>
</body>
</html>`;

  const reportPath = join(reportDir, "index.html");
  await Bun.write(reportPath, html);
  return reportPath;
}

async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Could not reserve a local comparison port"));
          return;
        }
        const selected = address.port;
        server.close((error) => (error ? reject(error) : resolvePort(selected)));
      });
    });
    ports.push(port);
  }
  return ports;
}

async function captureResponsive(
  repoRoot: string,
  revisionRoot: string,
  screenshotDir: string,
  nodePath: string,
): Promise<void> {
  rmSync(screenshotDir, { recursive: true, force: true });
  mkdirSync(screenshotDir, { recursive: true });
  const [serverPort, clientPort, udpPort] = await reservePorts(3);
  const dataDir = join(repoRoot, ".ui-diff", "runtime", `test-data-${serverPort}`);
  const playwrightCli = requirePlaywrightCli(repoRoot, "playwright");

  try {
    await run(
      [nodePath, playwrightCli, "test", "--project=mobile-screenshots"],
      {
        cwd: join(repoRoot, "playwright"),
        env: {
          E2E_SERVER_MODE: "dev",
          PW_SCREENSHOT_ONLY: "1",
          PW_SEED_SCREENSHOTS: "1",
          RACEIQ_APP_ROOT: revisionRoot,
          RACEIQ_SCREENSHOT_DIR: screenshotDir,
          PW_FRESH_INSTALL_PORT: String(serverPort),
          PW_FRESH_INSTALL_CLIENT_PORT: String(clientPort),
          PW_FRESH_INSTALL_UDP_PORT: String(udpPort),
          PW_FRESH_INSTALL_DATA_DIR: dataDir,
        },
      },
    );
  } finally {
    await removeRuntimeData(dataDir);
  }
}

async function captureStorybook(
  repoRoot: string,
  revisionRoot: string,
  screenshotDir: string,
  nodePath: string,
): Promise<void> {
  rmSync(screenshotDir, { recursive: true, force: true });
  mkdirSync(screenshotDir, { recursive: true });
  const [storybookPort] = await reservePorts(1);
  const resultsDir = join(
    repoRoot,
    ".ui-diff",
    "runtime",
    `test-results-${storybookPort}`,
  );
  const playwrightCli = requirePlaywrightCli(repoRoot, "client");
  const hasReusableUiStories = existsSync(
    join(revisionRoot, "client", "src", "stories", "ReusableUi.stories.tsx"),
  );
  const snapshotSpecs = [
    "dashboards.snapshot.ts",
    "theme.snapshot.ts",
    ...(hasReusableUiStories ? ["reusable-ui.snapshot.ts"] : []),
  ];

  try {
    await run(
      [
        nodePath,
        playwrightCli,
        "test",
        ...snapshotSpecs,
        "--update-snapshots",
        "--workers=1",
      ],
      {
        cwd: join(repoRoot, "client"),
        env: {
          RACEIQ_STORYBOOK_PORT: String(storybookPort),
          RACEIQ_STORYBOOK_ROOT: join(revisionRoot, "client"),
          RACEIQ_SNAPSHOT_DIR: screenshotDir,
          RACEIQ_SNAPSHOT_RESULTS_DIR: resultsDir,
          RACEIQ_CAPTURE_REUSABLE_UI: hasReusableUiStories ? "1" : "0",
          RACEIQ_UI_DIFF_CAPTURE: "1",
        },
      },
    );
  } finally {
    await removeRuntimeData(resultsDir);
  }
}

function openReport(reportPath: string, cwd: string): void {
  const command =
    process.platform === "win32"
      ? ["cmd.exe", "/c", "start", "", reportPath]
      : process.platform === "darwin"
        ? ["open", reportPath]
        : ["xdg-open", reportPath];
  Bun.spawn(command, { cwd, stdout: "ignore", stderr: "ignore" });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(import.meta.dir, "..");
  const nodePath = await requireNode(repoRoot);
  const uiDiffDir = join(repoRoot, ".ui-diff");
  const captureDir = join(uiDiffDir, "captures");
  const baseResponsiveDir = join(captureDir, "base-responsive");
  const currentResponsiveDir = join(captureDir, "current-responsive");
  const baseStorybookDir = join(captureDir, "base-storybook");
  const currentStorybookDir = join(captureDir, "current-storybook");
  const reportDir = join(uiDiffDir, "report");
  const imagesDir = join(reportDir, "images");
  // Bun workspace linking can fail when the Windows user temp path contains
  // spaces. Prefer the existing short C:\tmp root used by local test tooling.
  const tempParent = process.platform === "win32" && existsSync("C:\\tmp") ? "C:\\tmp" : tmpdir();
  const tempRoot = mkdtempSync(join(tempParent, "raceiq-ui-diff-"));
  const baseWorktree = join(tempRoot, "base");
  const errors: string[] = [];
  let baseSha: string | null = null;
  let currentSha: string | null = null;
  let dirtyFiles: string[] = [];
  let worktreeAdded = false;
  let reportPath: string | null = null;

  rmSync(captureDir, { recursive: true, force: true });
  rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(imagesDir, { recursive: true });

  try {
    currentSha = await run(["git", "rev-parse", "HEAD"], { cwd: repoRoot, quiet: true });
    const porcelain = await run(["git", "status", "--porcelain"], { cwd: repoRoot, quiet: true });
    dirtyFiles = porcelain ? porcelain.split(/\r?\n/).filter(Boolean) : [];

    if (options.fetchMain) {
      await run(["git", "fetch", "origin", "main"], { cwd: repoRoot });
    }
    baseSha = await run(["git", "rev-parse", `${options.baseRef}^{commit}`], {
      cwd: repoRoot,
      quiet: true,
    });

    console.log(`\nBase ${options.baseRef}: ${baseSha}`);
    console.log(`Current worktree: ${currentSha}${dirtyFiles.length > 0 ? ` (${dirtyFiles.length} dirty paths)` : ""}`);
    console.log(`Capture mode: ${options.storybookOnly ? "Storybook only" : "responsive app + Storybook"}`);

    await run(["git", "worktree", "add", "--detach", baseWorktree, baseSha], {
      cwd: repoRoot,
    });
    worktreeAdded = true;

    let baseReady = false;
    try {
      try {
        await run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], {
          cwd: baseWorktree,
        });
      } catch {
        console.warn("Frozen install rejected temporary Windows lockfile normalization; retrying inside disposable worktree.");
        await run(["bun", "install", "--ignore-scripts"], { cwd: baseWorktree });
      }
      baseReady = true;
    } catch (error) {
      errors.push(`Baseline dependency preparation failed:\n${errorMessage(error)}`);
    }

    let baseResponsiveCaptured = false;
    let currentResponsiveCaptured = false;
    let baseStorybookCaptured = false;
    let currentStorybookCaptured = false;

    if (options.storybookOnly) {
      const captures = await Promise.allSettled([
        ...(baseReady ? [captureStorybook(repoRoot, baseWorktree, baseStorybookDir, nodePath)] : []),
        captureStorybook(repoRoot, repoRoot, currentStorybookDir, nodePath),
      ]);
      let captureIndex = 0;
      if (baseReady) {
        const baseResult = captures[captureIndex++];
        if (baseResult.status === "fulfilled") baseStorybookCaptured = true;
        else errors.push(`Baseline Storybook capture failed:\n${errorMessage(baseResult.reason)}`);
      }
      const currentResult = captures[captureIndex];
      if (currentResult.status === "fulfilled") currentStorybookCaptured = true;
      else errors.push(`Current Storybook capture failed:\n${errorMessage(currentResult.reason)}`);
    } else {
      if (baseReady) {
        try {
          await captureResponsive(
            repoRoot,
            baseWorktree,
            baseResponsiveDir,
            nodePath,
          );
          baseResponsiveCaptured = true;
        } catch (error) {
          errors.push(`Baseline responsive capture failed:\n${errorMessage(error)}`);
        }
        try {
          await captureStorybook(
            repoRoot,
            baseWorktree,
            baseStorybookDir,
            nodePath,
          );
          baseStorybookCaptured = true;
        } catch (error) {
          errors.push(`Baseline Storybook capture failed:\n${errorMessage(error)}`);
        }
      }
      try {
        await captureResponsive(
          repoRoot,
          repoRoot,
          currentResponsiveDir,
          nodePath,
        );
        currentResponsiveCaptured = true;
      } catch (error) {
        errors.push(`Current responsive capture failed:\n${errorMessage(error)}`);
      }
      try {
        await captureStorybook(
          repoRoot,
          repoRoot,
          currentStorybookDir,
          nodePath,
        );
        currentStorybookCaptured = true;
      } catch (error) {
        errors.push(`Current Storybook capture failed:\n${errorMessage(error)}`);
      }
    }

    const responsiveChanges = options.storybookOnly
      ? []
      : await collectScreenshotDiffs({
          baseDir: baseResponsiveDir,
          currentDir: currentResponsiveDir,
          outDir: imagesDir,
          prefix: "responsive",
          includeMissing: baseResponsiveCaptured && currentResponsiveCaptured,
        });
    const storybookChanges = await collectScreenshotDiffs({
      baseDir: baseStorybookDir,
      currentDir: currentStorybookDir,
      outDir: imagesDir,
      prefix: "storybook",
      includeMissing: baseStorybookCaptured && currentStorybookCaptured,
    });
    reportPath = await writeUiDiffReport(
      reportDir,
      {
        generatedAt: new Date().toISOString(),
        baseRef: options.baseRef,
        baseSha,
        currentSha,
        dirtyFiles,
        partial: errors.length > 0,
        errors,
      },
      [...responsiveChanges, ...storybookChanges],
    );
  } catch (error) {
    errors.push(errorMessage(error));
    reportPath = await writeUiDiffReport(
      reportDir,
      {
        generatedAt: new Date().toISOString(),
        baseRef: options.baseRef,
        baseSha,
        currentSha,
        dirtyFiles,
        partial: true,
        errors,
      },
      [],
    );
  } finally {
    if (worktreeAdded) {
      try {
        await run(["git", "worktree", "remove", "--force", baseWorktree], {
          cwd: repoRoot,
          quiet: true,
        });
      } catch (error) {
        // Windows preview processes can briefly retain files after Playwright
        // exits. The explicit temp removal below recovers that state; prune
        // then clears Git's stale worktree registration.
        console.warn(`Temporary worktree cleanup needed fallback removal: ${errorMessage(error)}`);
      }
    }
    if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
    try {
      await run(["git", "worktree", "prune"], { cwd: repoRoot, quiet: true });
    } catch {}
  }

  if (!reportPath) throw new Error("UI diff report was not created");
  console.log(`\nUI diff report: ${reportPath}`);
  if (options.open) openReport(reportPath, repoRoot);
  if (errors.length > 0) {
    console.error(`UI comparison incomplete (${errors.length} error${errors.length === 1 ? "" : "s"}).`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`UI diff failed: ${errorMessage(error)}`);
    process.exit(1);
  });
}
