# Single-Build E2E Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse the Build & Test RaceIQ build as the compiled Windows E2E artifact instead of rebuilding it in a separate job.

**Architecture:** `build-test` remains the sole PR build job and conditionally uploads `dist/` under the existing `raceiq-dist-windows` artifact name. The duplicate `e2e-windows-build` job is removed; `playwright-dev` waits on `build-test` and downloads its artifact. Upload is controlled by an explicit `UPLOAD_E2E_ARTIFACT` flag, enabled only for non-draft pull requests.

**Tech Stack:** GitHub Actions YAML, Bun build, reusable Playwright workflow.

## Global Constraints

- Preserve existing `raceiq-dist-windows` artifact name and Playwright reusable-workflow inputs.
- Upload E2E build artifact only for non-draft pull requests.
- Do not alter release workflow build behavior.
- Keep Playwright project matrix and artifact outputs unchanged.

---

### Task 1: Consolidate PR build artifact production

**Files:**
- Modify: `.github/workflows/build-test.yml`

**Interfaces:**
- Produces `raceiq-dist-windows` from the existing `Build RaceIQ` step.
- `playwright-dev` consumes the artifact through its existing `dist-artifact` input.

- [ ] Add `UPLOAD_E2E_ARTIFACT` job environment flag set from the non-draft pull-request condition.
- [ ] Add an upload step immediately after `Build RaceIQ`, guarded by the flag, using `actions/upload-artifact@v4`, artifact name `raceiq-dist-windows`, path `dist/`, and one-day retention.
- [ ] Delete the separate `e2e-windows-build` job and its duplicate dependency installation/build/upload steps.
- [ ] Change `playwright-dev.needs` from `[build-test, e2e-windows-build]` to `[build-test]`.

### Task 2: Verify and publish workflow change

**Files:**
- Verify: `.github/workflows/build-test.yml`, `.github/workflows/playwright-dev.yml`, `.github/workflows/playwright.yml`, `.github/workflows/release.yml`

- [ ] Parse all affected workflow YAML files.
- [ ] Confirm artifact name, dependency graph, flag condition, and release workflow remain correct.
- [ ] Run repository lint and typecheck.
- [ ] Commit and push the workflow change.
