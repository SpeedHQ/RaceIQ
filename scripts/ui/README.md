# UI tooling

Local visual-regression utilities. These scripts capture equivalent base/current renders, compare PNGs with shared tolerance, and emit an inspectable local report without changing checked-in baselines.

## Commands

| Command | Purpose | Output |
| --- | --- | --- |
| `bun scripts/ui/local-ui-diff.ts [--base REF] [--no-fetch] [--open] [--storybook-only]` | Capture base and current responsive/Storybook screenshots, then build a report. | `.ui-diff/captures/`, `.ui-diff/report/index.html`, `.ui-diff/report/report.json` |
| `bun scripts/ui/collect-screenshot-diffs.ts --base DIR --current DIR --out DIR --prefix NAME` | Compare two PNG trees using `visual-diff-config.ts`. | Before, after, and difference PNG triplets in `DIR`; summary on stdout |
| `bash scripts/ui/snapshot-in-docker.sh` | Regenerate canonical dashboard snapshots with pinned Playwright container. | `client/src/stories/__snapshots__/snapshot-*.png` and `assets/screenshots/` |

`local-ui-diff.ts --help` documents comparison options. Default base is `origin/main`; `--base` selects another Git ref and disables fetching. Node.js, installed workspace dependencies, Git, and Playwright browsers are required. Docker snapshot regeneration additionally requires Docker.

## Inputs and outputs

`local-ui-diff.ts` reads current Git worktree plus selected base revision. Temporary detached worktree and runtime data are removed after capture. Report image paths are relative to `.ui-diff/report/`, making report directory self-contained.

`collect-screenshot-diffs.ts` recursively reads PNG files under `--base` and `--current`. Matching paths within configured pixel ratio are omitted. Added, removed, dimension-changed, and materially changed images produce triplets. Exported `collectScreenshotDiffs`, `ScreenshotDiff`, and `ScreenshotDiffOptions` support focused tooling/tests.

`visual-diff-config.ts` is shared policy for Playwright assertions and collector. Keep color threshold and aggregate pixel allowance aligned through this module.

## Boundaries

This domain owns capture orchestration, image comparison, local HTML/JSON reporting, and canonical Docker snapshot execution. Product UI styling, screenshot case definitions, Playwright specs, workflow wiring, package commands, and checked-in baseline review remain outside this directory.

## Focused verification

- `bun scripts/ui/local-ui-diff.ts --help` checks CLI loading and option text without capture.
- Run collector against small temporary base/current PNG trees; confirm unchanged images are omitted and changed images emit three files.
- `bash -n scripts/ui/snapshot-in-docker.sh` checks shell syntax without starting Docker.
- Run local UI diff in required capture mode and inspect report filters, image links, overlay slider, metadata, and partial-error state.
