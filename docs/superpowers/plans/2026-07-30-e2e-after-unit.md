# Dev-Server PR E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run PR Playwright E2E against development servers after unit tests, while retaining compiled Windows E2E for releases.

**Architecture:** Replace the PR-only Windows build/compiled Playwright chain with an Ubuntu reusable workflow that depends on `build-test`. A new launcher starts isolated Bun backend and Vite frontend processes for the existing `fresh-install` and `tunes` projects. The existing compiled Playwright workflow remains unchanged for release.

**Tech Stack:** GitHub Actions, Bun, Vite, Playwright, TypeScript

## Global Constraints

- PR graph is `build-test → playwright-dev`.
- Release compiled E2E continues using `raceiq-dist-windows`.
- Existing E2E projects and test data isolation remain intact.
- Dev launcher must reject unsafe data directories and terminate both child processes.

---

### Task 1: Add dev-server E2E launcher and configuration

**Files:**
- Create: `playwright/start-dev-server.ts`
- Modify: `playwright/playwright.config.ts`

**Interfaces:**
- Launcher consumes `DATA_DIR`, `SERVER_PORT`, `CLIENT_PORT`, and `UDP_PORT` environment variables.
- Launcher starts backend `bun run server/index.ts` and Vite `bun run dev --host 0.0.0.0 --port $CLIENT_PORT` from `client/` with `SERVER_PORT`/`PROXY_TARGET` targeting backend.
- Playwright dev projects use client ports and preserve existing test data paths.

- [ ] **Step 1: Implement launcher**

Create a launcher that wipes only paths containing `test-data`, writes `{ udpPort }` settings, spawns backend and Vite children, forwards SIGTERM/SIGINT, and exits nonzero if either child exits unsuccessfully.

- [ ] **Step 2: Select dev-server ports in Playwright config**

Add `PW_FRESH_INSTALL_CLIENT_PORT` and `PW_TUNES_CLIENT_PORT`; in dev mode, use these client ports as `baseURL` and `webServer` URLs. Keep compiled defaults and existing `start-server.ts` configuration available for release.

- [ ] **Step 3: Run local dev E2E**

Run:

```bash
cd playwright && bunx playwright test --project=fresh-install --project=tunes
```

Expected: both projects pass against the dev launcher.

### Task 2: Wire PR workflow and preserve release workflow

**Files:**
- Create: `.github/workflows/playwright-dev.yml`
- Modify: `.github/workflows/build-test.yml`

**Interfaces:**
- `build-test.yml` invokes `playwright-dev.yml` with `needs: build-test`.
- `playwright-dev.yml` installs Bun dependencies/Chromium and runs `fresh-install` plus `tunes` on Ubuntu.
- `release.yml` continues invoking `.github/workflows/playwright.yml` with `dist-artifact: raceiq-dist-windows`.

- [ ] **Step 1: Add reusable dev Playwright workflow**

Create Ubuntu workflow with `workflow_call`, checkout, Bun setup, `bun install`, Chromium installation, and the two Playwright projects. Upload `playwright/test-results/` on failure.

- [ ] **Step 2: Replace PR Windows E2E chain**

Remove `build-windows` and its compiled `playwright` job from `build-test.yml`; add `playwright-dev` using the reusable dev workflow with `needs: build-test`.

- [ ] **Step 3: Validate workflow contracts**

Parse changed YAML and assert PR workflow contains `build-test` then `playwright-dev`, while release still references `playwright.yml` and `raceiq-dist-windows`.

### Task 3: Full verification and PR

**Files:**
- No additional source files.

- [ ] **Step 1: Run unit tests**

```bash
bun run test
```

Expected: zero failures.

- [ ] **Step 2: Re-run dev E2E**

```bash
cd playwright && bunx playwright test --project=fresh-install --project=tunes
```

Expected: zero failures.

- [ ] **Step 3: Commit, push, and create PR against main**

Use a concise fix commit, push `fix/e2e-after-unit`, and create a PR targeting `main` with unit/E2E verification results.
