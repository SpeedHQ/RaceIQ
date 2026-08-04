---
name: project_pr_screenshot_pipeline
description: PR dashboard screenshot-diff CI pipeline (RaceIQ) — how it works + the 3 determinism gotchas
metadata: 
  node_type: memory
  type: project
  originSessionId: 2ce431d0-42a7-4841-a88e-d7a9791e8f00
---

RaceIQ PR visual-diff pipeline (built 2026-06-29). Renders Storybook dashboard stories on each PR, posts Before/After/Diff as a sticky PR comment, labels PR `ui change`.

**Workflows (on main):**
- `.github/workflows/pr-screenshots.yml` — `pull_request` + `workflow_dispatch`(input `pr`). Read-only token, runs PR code. Renders `client/src/stories/dashboards.snapshot.ts` via `bun run snapshot:test`, collects changed `<Name>-{before,after,diff}.png` → artifact `pr-screenshot-preview`.
- `.github/workflows/pr-screenshots-comment.yml` — `workflow_run` (write token, NO PR code). Hosts PNGs on orphan branch `pr-previews`, posts sticky comment (marker `<!-- dashboard-screenshot-diff -->`), labels. Two-workflow split is the secure fork-safe pattern.
- `.github/workflows/update-baselines.yml` — manual; re-renders baselines in CI env, commits to main.
- Local repro: `cd client && bun run snapshot:docker` → `scripts/ui/snapshot-in-docker.sh`.

**Determinism is everything — baselines must match renders byte-for-byte. Three gotchas fixed:**
1. **Container**: render in pinned `mcr.microsoft.com/playwright:v1.61.1-jammy` (matches `@playwright/test`). Software GL deterministic; local GPU drifts. Needs `apt-get install unzip` before setup-bun, `git safe.directory`, `shell: bash` for process-substitution steps, root user.
2. **Redline strobe**: `RevBar.tsx` `useRedlineStrobe` 90ms setInterval flipped bar red↔orange → random frame. Fixed via `prefers-reduced-motion` + `reducedMotion:"reduce"` in playwright config. `animations:"disabled"` does NOT stop JS intervals.
3. **Font race**: snapshot fired before Geist loaded → every glyph shifts ~1px (full-frame ghost diff). Fixed: `await page.evaluate(() => document.fonts.ready)` before capture in the snapshot spec.

**Biggest trap — stale merge ref:** `refs/pull/N/merge` is recomputed lazily by GitHub, so `workflow_dispatch` rendered OLD code vs OLD baselines (every dashboard looked changed). Fix: checkout `refs/pull/N/head` (fetch-depth 0) and `git merge origin/main` ourselves → always PR code + fresh main. Diagnose by comparing render `-before.png` hash vs `git show origin/main:.../snapshot-<Name>.png`.

`playwright.config.ts` is excluded from client build (`tsconfig.app.json` includes only `src`), so its TS diagnostics don't gate CI. Related: [[project_f1_2025_support]] [[project_known_test_failures]]
