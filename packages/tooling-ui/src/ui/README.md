# UI tooling

Local visual-regression utilities. These scripts capture equivalent base/current renders, compare PNGs with shared tolerance, and emit an inspectable local report without changing checked-in baselines.

## Commands

| Command | Purpose | Output |
| --- | --- | --- |
| `bun packages/tooling-ui/src/ui/local-ui-diff.ts [--base REF] [--no-fetch] [--open] [--storybook-only]` | Capture base and current responsive/Storybook screenshots, then build a report. | `.ui-diff/captures/`, `.ui-diff/report/index.html`, `.ui-diff/report/report.json` |
| `bun packages/tooling-ui/src/ui/collect-screenshot-diffs.ts --base DIR --current DIR --out DIR --prefix NAME` | Compare two PNG trees using `visual-diff-config.ts`. | Before, after, and difference PNG triplets in `DIR`; summary on stdout |
| `bun packages/tooling-ui/src/ui/build-storybook.ts [--client-root PATH]` | Build static Storybook or reuse a validated build. `--key` prints its cache key; `--verify` rejects stale or damaged output without compiling. | Target client's `storybook-static/` and build manifest |

`local-ui-diff.ts --help` documents comparison options. Default base is `origin/main`; `--base` selects another Git ref and disables fetching. Node.js, installed workspace dependencies, Git, and Playwright browsers are required.

## Inputs and outputs

`local-ui-diff.ts` reads current Git worktree plus selected base revision. Temporary detached worktree and runtime data are removed after capture. Report image paths are relative to `.ui-diff/report/`, making report directory self-contained.

`collect-screenshot-diffs.ts` recursively reads PNG files under `--base` and `--current`. Matching paths within configured pixel ratio are omitted. Added, removed, dimension-changed, and materially changed images produce triplets. Exported `collectScreenshotDiffs`, `ScreenshotDiff`, and `ScreenshotDiffOptions` support focused tooling/tests.

`visual-diff-config.ts` is shared policy for Playwright assertions and collector. Keep color threshold and aggregate pixel allowance aligned through this module.

The collector processes image pairs serially. Changed pairs reuse dimensions from pixel comparison; added and removed images read dimensions from metadata, avoiding raw pixel decoding solely to size preview output.

PR Storybook comparison is advisory: added, changed, and removed screenshots produce before/after/diff artifacts for the PR comment; unchanged images are omitted. Base and PR render failures emit warnings without failing the comparison job, so available screenshots still reach visual review. A missing render is not proof of an intentional removal; inspect render warnings when artifacts are incomplete.

## Compiled Storybook reuse

Snapshot capture builds static Storybook through the shared helper before serving it. Build keys cover tracked working-tree contents, untracked source, environment files and build flags, the dependency lockfile, helper implementation, and Node/Bun/platform versions. Generated translation, snapshot, and cache output is excluded. Source and asset hashing is streamed; every static asset is validated before reuse.

Static builds always use `CI=true`, matching Playwright's web-server environment. Capture invokes the helper from the repository root, matching standalone Bun dotenv loading, so local prebuilds remain eligible for verify-only capture.

CI restores exact keys without fallback prefixes, builds each revision explicitly, and sets `RACEIQ_STORYBOOK_PREBUILT=1` for verify-only serving. `RACEIQ_STORYBOOK_ROOT` selects the revision's client; `RACEIQ_SNAPSHOT_TEST_DIR` selects historical specs without replacing their fixtures. Failed builds do not render stale assets, and cache service failures do not prevent uncached builds or partial preview publication.

Paraglide generation uses the shared translation build cache documented in `scripts/dev/README.md`. Historical base revisions keep their own Vite configuration, so their first uncached build may still run the older translation compiler. GitHub pull-request caches reuse builds within the same PR; sharing across PRs requires a matching default-branch cache.

The upstream `Build RaceIQ` job uploads generated locales and their hidden manifest as `raceiq-paraglide`. The reusable snapshot and compiled E2E workflows accept `paraglide-artifact` and download it into `client` before locale validation or the local production build. Every compiled E2E matrix job receives the artifact; jobs using a prebuilt native `dist` skip the locale download. Successful snapshot artifact downloads skip the persistent locale-cache restore. Manual runs and failed transfers fall back to the persistent cache or compilation; mismatched or damaged artifacts are regenerated.

Compiled E2E gates depend on the upstream build and test jobs, not snapshot comparison. E2E, responsive screenshots, and snapshot comparison can run alongside one another after those shared prerequisites succeed.

Git input enumeration and test fixtures discard inherited `GIT_*` variables. In particular, pre-commit's `GIT_INDEX_FILE` must never redirect a temporary fixture's `git add` into the caller's staging index.

## Boundaries

This domain owns capture orchestration, image comparison, local HTML/JSON reporting, and canonical Docker snapshot execution. Product UI styling, screenshot case definitions, Playwright specs, workflow wiring, package commands, and checked-in baseline review remain outside this directory.

## Focused verification

- `bun packages/tooling-ui/src/ui/local-ui-diff.ts --help` checks CLI loading and option text without capture.
- Run collector against small temporary base/current PNG trees; confirm unchanged images are omitted and changed images emit three files.
- `bash -n packages/tooling-ui/src/ui/snapshot-in-docker.sh` checks shell syntax without starting Docker.
- Run local UI diff in required capture mode and inspect report filters, image links, overlay slider, metadata, and partial-error state.
