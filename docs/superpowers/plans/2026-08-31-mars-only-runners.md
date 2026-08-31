# Mars-Only GitHub Actions Runners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every active GitHub Actions job from Blacksmith to `mars-windows-x64` and add an explicit release option to skip Playwright tests after local verification.

**Architecture:** Keep workflow triggers, dependencies, artifacts, permissions, and job responsibilities unchanged unless required by Windows execution. Replace provider labels directly. Convert Linux-container-only setup and shell commands in screenshot workflows to Windows-compatible PowerShell steps. Add release dispatch input `skip-tests` with default `false`; conditionally skip the reusable Playwright job and allow draft creation after a successful build when skipped.

**Tech Stack:** GitHub Actions YAML, PowerShell, Bun, Playwright, GitHub Actions expressions.

## Global Constraints

- Every affected job runs on `mars-windows-x64`.
- No Blacksmith fallback or other runner provider remains in active workflows.
- Existing Mars jobs remain unchanged.
- Release tests remain enabled by default.
- `skip-tests` is explicit, manual-dispatch-only, and visible in the workflow summary.
- Preserve workflow permissions, artifacts, triggers, and build/test semantics outside the requested skip path.

---

### Task 1: Move native and release Windows jobs to Mars

**Files:**
- Modify: `.github/workflows/native-replay.yml:25-28`
- Modify: `.github/workflows/release.yml:24-55,207-212,239-243`

**Interfaces:**
- Consumes: Existing workflow job labels and `needs` graph.
- Produces: No active `blacksmith-*` `runs-on` values; Windows jobs target `mars-windows-x64`.

- [ ] **Step 1: Replace native replay runner**

Change `jobs.replay.runs-on` from `blacksmith-4vcpu-windows-2025` to the existing Mars Windows label array:

```yaml
runs-on:
  - mars-windows-x64
  - 4VCPU
  - 15G
```

Keep replay commands and artifact upload unchanged.

- [ ] **Step 2: Replace release Linux runner labels with Mars Windows**

Change `compute-version`, `draft-release`, and `finalize` to `mars-windows-x64`. Preserve their existing scripts and job dependencies; use PowerShell only where the current job already depends on Windows-specific behavior, otherwise retain explicit `shell: bash` where GitHub's Windows bash environment supports the command.

- [ ] **Step 3: Add release dispatch input**

Under `on.workflow_dispatch.inputs`, add:

```yaml
skip-tests:
  description: "Skip release Playwright tests after local verification"
  required: false
  type: boolean
  default: false
```

- [ ] **Step 4: Make release test dependency conditional**

Set `playwright-test.if` to `${{ github.event_name == 'workflow_dispatch' && !inputs.skip-tests }}`. Change `draft-release.needs` to `[compute-version, build, playwright-test]` and its job condition to `${{ github.event_name == 'workflow_dispatch' && (needs.playwright-test.result == 'success' || needs.playwright-test.result == 'skipped') }}` so a successful build can draft a release when tests are explicitly skipped, while failed tests still block it.

Add a summary step to `build` or `draft-release` that writes whether Playwright ran or was skipped based on `${{ inputs.skip-tests }}`.

- [ ] **Step 5: Validate affected YAML expressions**

Run the repository's available workflow/YAML validation command, or use a local YAML parser if no workflow validator is configured. Confirm no release job has an accidental unconditional test bypass.

- [ ] **Step 6: Commit the task**

```bash
git add .github/workflows/native-replay.yml .github/workflows/release.yml
git commit -m "ci: move native and release jobs to Mars"
```

### Task 2: Port PR snapshot workflow from Linux container to Mars Windows

**Files:**
- Modify: `.github/workflows/pr-snapshots.yml:36-114,115-161`

**Interfaces:**
- Consumes: Existing PR revision resolution outputs and screenshot diff paths.
- Produces: Same preview artifact and snapshot assertion on Mars Windows without a Linux container.

- [ ] **Step 1: Replace runner and remove container-only setup**

Set `render.runs-on` to:

```yaml
runs-on:
  - mars-windows-x64
  - 4VCPU
  - 15G
```

Remove the `container:` block, the root-only safe-directory step, and the `apt-get install unzip` step. Keep setup-bun and dependency installation.

- [ ] **Step 2: Convert revision merge commands to PowerShell**

Replace the multiline bash merge step with `shell: pwsh`, preserving the base-ref/base-sha equality check, fetches, and `git merge --no-edit`. Use PowerShell environment variables (`$env:BASE_REF`, `$env:BASE_SHA`) and fail with `throw` when fetched SHA differs.

- [ ] **Step 3: Convert diff collection to PowerShell**

Replace the `shell: bash` `Collect diffs` step with PowerShell equivalents that create `$env:GITHUB_WORKSPACE/pr-preview`, copy expected/actual/diff PNGs, invoke the existing TypeScript collector through `bun`, and set `changed=1` or `changed=0` in `$env:GITHUB_OUTPUT`. Preserve output filenames and source paths exactly.

- [ ] **Step 4: Preserve assertion and artifacts**

Keep `snapshot:test`, `continue-on-error`, final failure step, and preview artifact upload behavior unchanged. Ensure `$RUNNER_TEMP` and `$GITHUB_WORKSPACE` resolve through PowerShell environment variables.

- [ ] **Step 5: Validate workflow syntax and command paths**

Parse the workflow YAML and run the narrowest available screenshot/workflow smoke validation without modifying baselines.

- [ ] **Step 6: Commit the task**

```bash
git add .github/workflows/pr-snapshots.yml
git commit -m "ci: run PR snapshots on Mars Windows"
```

### Task 3: Port baseline update workflow from Linux container to Mars Windows

**Files:**
- Modify: `.github/workflows/update-baselines.yml:28-58,77-90`
- Review: `scripts/ui/snapshot-in-docker.sh` only to preserve canonical image documentation; do not alter it.

**Interfaces:**
- Consumes: `target_ref` and `delivery` dispatch inputs.
- Produces: Same generated baseline artifacts and optional commit/push behavior on Mars Windows.

- [ ] **Step 1: Replace runner and remove Linux container steps**

Set `update.runs-on` to the Mars Windows resource array. Remove the `container:` block, root-only safe-directory step, and `apt-get install unzip`. Update the adjacent comment so it describes the pinned Playwright environment without claiming the job runs in a Linux container.

- [ ] **Step 2: Preserve checkout, dependency, and snapshot commands**

Keep checkout ref, Bun version, dependency installs, canonical snapshot environment, and artifact paths unchanged. Use PowerShell defaults or explicit `shell: pwsh` for steps whose current commands rely on shell portability.

- [ ] **Step 3: Convert baseline commit step**

Replace bash-only conditionals and environment syntax with PowerShell while retaining exact staged paths, no-change message, commit message, and `git push origin HEAD:${TARGET_REF}` destination.

- [ ] **Step 4: Validate artifact and delivery paths**

Parse YAML and run the focused baseline-generation command in dry-run-safe/local mode if available; do not push or commit generated baselines during local verification.

- [ ] **Step 5: Commit the task**

```bash
git add .github/workflows/update-baselines.yml
git commit -m "ci: run baseline updates on Mars Windows"
```

### Task 4: Verify complete runner migration and release skip behavior

**Files:**
- Verify: `.github/workflows/*.yml`
- Verify: `docs/superpowers/specs/2026-08-31-mars-only-runners-design.md`

**Interfaces:**
- Consumes: Tasks 1–3 workflow changes.
- Produces: Evidence that active workflows contain no Blacksmith labels and release skip behavior has correct precedence.

- [ ] **Step 1: Search active workflows**

Run a repository search limited to `.github/workflows` for `blacksmith`. Expected result: no matches.

- [ ] **Step 2: Check runner labels**

Inspect every `runs-on` in changed workflows. Expected result: each changed job uses `mars-windows-x64`; existing Mars labels and resource arrays remain valid.

- [ ] **Step 3: Check release conditions**

Verify default dispatch (`skip-tests=false`) runs Playwright and requires success. Verify explicit `skip-tests=true` skips Playwright and permits `draft-release` only after successful `compute-version` and `build`.

- [ ] **Step 4: Run final workflow validation**

Run the repository-configured workflow/YAML validation and targeted smoke commands. Record exact output; do not claim a remote GitHub run was observed unless one was actually executed.

- [ ] **Step 5: Review diff and commit verification changes if any**

Confirm unrelated `bun.lock` user changes remain untouched. Review changed workflow diff for preserved triggers, permissions, artifacts, and dependencies.
