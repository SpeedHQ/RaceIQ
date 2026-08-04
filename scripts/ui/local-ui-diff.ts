#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collectScreenshotDiffs } from "./collect-screenshot-diffs";
import { captureResponsive, captureStorybook } from "./lib/capture";
import {
  errorMessage,
  openReport,
  requireNode,
  run,
} from "./lib/process";
import {
  type UiDiffMetadata,
  writeUiDiffReport,
} from "./lib/report";

export { writeUiDiffReport };
export type { UiDiffMetadata };

interface CliOptions {
  baseRef: string;
  fetchMain: boolean;
  open: boolean;
  storybookOnly: boolean;
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(import.meta.dir, "../..");
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
