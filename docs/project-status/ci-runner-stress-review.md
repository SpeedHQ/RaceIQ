# CI Runner Stress Review

## Scope

Review of CI-related commits merged to `main` from August 14 through August 21, 2026, with emphasis on recent Whitesmith self-hosted runner crashes and PR #249.

## Executive summary

Recent CI changes fixed flaky tests and reduced contention inside individual jobs. The largest change also moved work onto Whitesmith and replaced one E2E job with four unthrottled jobs. This improved test isolation and wall-clock time while increasing aggregate runner-pool pressure.

The most important change is commit [`c211e8c`](https://github.com/SpeedHQ/RaceIQ/commit/c211e8c294b037c923136b28e3311511640f80f7), merged August 19. It created the Windows E2E matrix used by the seeded Playwright job that later lost runner communication in PR #249. This establishes a direct configuration link, not proof of causation. No surviving host telemetry identifies OOM, CPU starvation, runner-service termination, host reboot, disk exhaustion, or network loss as the root cause.

## Confirmed PR #249 incident

The seeded Playwright job failed with GitHub's self-hosted runner communication annotation:

> The self-hosted runner lost communication with the server. Verify the machine is running and has a healthy network connection. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.

Incident details:

- Workflow run: [32487052688](https://github.com/SpeedHQ/RaceIQ/actions/runs/32487052688)
- Job: [96787547663](https://github.com/SpeedHQ/RaceIQ/actions/runs/32487052688/job/96787547663)
- Job name: `playwright-dev / Playwright E2E (seeded) / playwright`
- Runner label: `whitesmith-windows-x64`, `4VCPU`, `10G`
- Runner identity: `whitesmith-b7f75ecf-e489-459c-ab82-7f908c6520aa`
- Playwright gate started at `2026-08-21T13:44:01Z`
- Check ended at `2026-08-21T14:01:45Z`
- Gate step never recorded completion
- Seeded Playwright and server-diagnostic artifacts were not uploaded

This differs from two ordinary failures also visible on PR #249:

- `ComboDash1` Storybook snapshot mismatch on Blacksmith
- Tunes Playwright locator timeout, which completed normally and uploaded diagnostics

## Commit review

### `c211e8c` — seeded E2E reliability

Commit: [`c211e8c`](https://github.com/SpeedHQ/RaceIQ/commit/c211e8c294b037c923136b28e3311511640f80f7)

Before this commit:

- Build/test ran on Blacksmith Ubuntu with 4 vCPU.
- E2E ran as one Blacksmith Windows job with 4 vCPU.
- The job performed one dependency install, one Chromium install, and one artifact download.
- Playwright used one worker.
- Fresh, tunes, and seeded server sets ran inside the same job.

After this commit:

- Build/test moved to Whitesmith Windows with `10VCPU` and `15G` labels.
- Build output became `raceiq-dist-windows`.
- E2E became four Whitesmith matrix jobs:
  - fresh: `2VCPU`, `10G`
  - tunes: `2VCPU`, `10G`
  - tunes-unseeded: `2VCPU`, `10G`
  - seeded: `4VCPU`, `10G`
- Matrix has `fail-fast: false` and no `max-parallel`.
- Every matrix job repeats checkout, Bun and Node setup, dependency installation, Chromium installation, artifact download, project discovery, test execution, and artifact upload.
- Responsive screenshot and Storybook snapshot workflows also start after build/test succeeds.

Reliability improvements:

- One RaceIQ server set per matrix job
- Unique data directories and HTTP/client/UDP ports
- `PW_WORKERS="1"` enforced by reusable workflow
- Stateful import specs serialized
- Separate artifacts and diagnostics per matrix entry
- Dependency-install retry
- Project discovery check before test execution

Resource impact:

- Previous E2E allocation: one 4-vCPU job.
- New E2E allocation: four jobs requesting 10 vCPU and 40G total.
- Responsive screenshot job can add another `4VCPU` and `5G` Whitesmith allocation.
- One PR can therefore advertise 14 vCPU and 45G across five concurrent Whitesmith jobs after build/test.
- Multiple active PRs can multiply this demand if jobs share constrained physical hosts.
- Server isolation lowers per-job pressure, but matrix fan-out raises aggregate process, memory, disk, network, and scheduler pressure.

Assessment: strongest current stress candidate. Commit directly configured the failed PR #249 seeded job, but available evidence does not prove the commit caused the runner disconnect.

### `0bb86a3` — compiled artifact reuse

Commit: [`0bb86a3`](https://github.com/SpeedHQ/RaceIQ/commit/0bb86a3d3b6a16f2d534bcbecd9c3d21f26dc91c)

Changes:

- Switched PR E2E from development servers to a compiled binary.
- Built the binary once in the upstream build job.
- Uploaded `raceiq-dist-linux` for downstream E2E.
- E2E downloaded the artifact instead of rebuilding.
- Kept one Blacksmith E2E job.

Resource impact:

- Removed a duplicate E2E build and its CPU/RAM cost.
- Added artifact archive, upload, download, and extraction cost.
- Shifted build work upstream rather than repeating it.

Current topology preserves artifact reuse, but four E2E jobs now download the same artifact and repeat the remaining setup work.

Assessment: useful stress reduction that was partially diluted by later matrix fan-out.

### `12e6913` — Storybook snapshot speed

Commit: [`12e6913`](https://github.com/SpeedHQ/RaceIQ/commit/12e69131519bad0f95446813ac7bde96824757d1)

Changes:

- Replaced `storybook dev` with one static `storybook build --test`.
- Serves static output using Vite preview.
- Removed repeated full warmup and stabilization work.
- Increased snapshot workers from 1 to 2.
- Increased web-server startup timeout from 120 seconds to 600 seconds.
- Retained a 4GB Node heap allowance for Storybook compilation.

Resource impact:

- Lower total runtime and less repeated compilation.
- Potentially higher instantaneous browser CPU/RAM from two workers.
- Additional transient disk use for static Storybook output.
- Current snapshot workflow runs on Blacksmith Ubuntu, not Whitesmith.

Assessment: improves external snapshot performance. It does not directly explain the PR #249 Whitesmith seeded runner loss.

### `3b82fb6` — bench workflow parser fix

Commit: [`3b82fb6`](https://github.com/SpeedHQ/RaceIQ/commit/3b82fb69e512a4a58c3aac59d51d793be74f11ae)

Change:

- Removed a duplicate top-level `permissions` mapping from `bench.yml`.

Resource impact:

- No matrix, runner, process, cache, worker, or artifact change.
- Restored valid workflow parsing and Blacksmith bench scheduling.

Assessment: CI correctness fix with no Whitesmith stress effect.

### `d43f149` — Paraglide startup and bench reporting

Commit: [`d43f149`](https://github.com/SpeedHQ/RaceIQ/commit/d43f1490be9aa2b83637b64091c39729526a7f4d)

Changes:

- Reduced Paraglide development output from 2,998 files to 10.
- Commit measurements report:
  - Cold startup: 36.672 seconds to 12.308 seconds
  - Unchanged restart: 27.704 seconds to 2.918 seconds
- Added bench comparison output to GitHub step summary.
- Skipped PR comment actions for fork pull requests.

Resource impact:

- Useful development startup reduction.
- Bench execution remains on Blacksmith.
- Production and Storybook builds retain production output behavior.

Assessment: negligible Whitesmith runner effect.

### `4ed2148` — workflow whitespace only

Commit: [`4ed2148`](https://github.com/SpeedHQ/RaceIQ/commit/4ed2148027cf11bd964b3517007bc0ff20c37a26)

The only CI diff removed trailing whitespace from `runs-on:`. Runner labels remained `whitesmith-windows-x64`, `10VCPU`, and `15G`.

Assessment: no runtime effect.

## Recent main-branch outcomes

From August 14 through August 21:

- 11 `Build & Test` runs on `main`
- 7 cancelled by branch concurrency during rapid pushes
- 2 successful
- 2 ordinary `Run tests` failures
- No confirmed main-branch self-hosted runner disconnect in inspected runs

This does not validate the new E2E topology. Main pushes do not execute the PR Playwright matrix; `.github/workflows/build-test.yml` invokes it only for pull requests or manual dispatch. The matrix therefore lacks regular post-merge soak coverage.

## Current stress gaps

### No host-wide admission control

Per-job labels and Playwright worker caps do not bound aggregate physical-host load unless Whitesmith enforces those labels as real CPU/RAM reservations. Repository configuration contains no matrix `max-parallel` or cross-workflow capacity control.

### No out-of-process runner telemetry

Current diagnostic uploads depend on the runner remaining alive. PR #249 proved that `if: always()` cannot upload diagnostics after runner communication disappears.

Needed host-side measurements:

- Available and committed memory
- Pagefile usage
- CPU utilization and queue depth
- Free disk space
- Bun, Node, RaceIQ, and Chromium process counts and working sets
- Runner service heartbeat and restart history
- Concurrent job identities on the same physical host
- Windows Kernel-Power, Resource-Exhaustion-Detector, WHEA, and Application Error events
- GitHub runner `_diag` logs

### Repeated matrix setup

Four matrix jobs independently install dependencies and Chromium, download the same compiled artifact, and upload results. This creates concurrent disk, extraction, process, and network bursts.

### Main does not soak PR-only E2E

A CI topology change can merge successfully without repeated execution after merge. Failures remain dependent on later pull requests.

### Known monolithic test pressure

Build workflow documents ACC fixture replay reaching roughly 4GB heap and GC-thrashing on 2 vCPU. Current comment says 4 vCPU while runner labels request `10VCPU` and `15G`. Actual label enforcement and physical capacity are not documented in the repository.

## Recommended rollout

1. Add out-of-process host telemetry before changing capacity.
2. Set Playwright matrix `max-parallel: 1` as a stability baseline.
3. Run responsive screenshots after E2E instead of concurrently.
4. Keep `PW_WORKERS="1"`.
5. Set `PW_SCREENSHOT_WORKERS="1"` while investigating crashes.
6. Re-run the PR #249 seeded workload repeatedly and classify every outcome.
7. Raise `max-parallel` to 2 only after stable resource measurements.
8. Add measured job timeouts and cancellation-safe process cleanup.
9. Skip visual workflows for unrelated changes using conservative path eligibility and a manual override.
10. Reuse the existing compiled artifact in responsive screenshots.
11. Cache immutable Bun package downloads and Playwright Chromium only after measuring cache size and disk impact.
12. Isolate heavy ACC replay tests or seeded Playwright on dedicated capacity if one serialized job still disconnects the runner.

## Mitigation implemented

Current pull-request topology preserves shared installation work without
sharing mutable seeded runtime state:

- The light E2E job uses `4VCPU`, `10G`; the seeded E2E job uses `10VCPU`, `15G`.
- Each job performs checkout, Bun, Node, dependency installation, Chromium installation, and compiled artifact download once.
- Fresh, tunes, and tunes-unseeded remain isolated sequential batches with one backend set live at a time.
- Seeded tests run as four Playwright shards. Each shard has one worker plus its own compiled backend, data directory, setup home, HTTP/client/UDP ports, and output directory.
- Batch discovery or test failure does not skip another batch or shard; the job reports aggregate failure after all executions finish.
- Responsive screenshots wait for PR E2E and use `PW_SCREENSHOT_WORKERS="1"`.
- Release E2E retains its existing single-set path through the reusable workflow.
- Both reusable Playwright gate paths emit `pw:browser` process diagnostics, including Chromium stderr and exit codes, so a later `TargetClosedError` preserves its initiating browser failure rather than only the cleanup symptom.

Configured concurrency now stays inside one Whitesmith allocation per stage:
at most `10VCPU`, `15G` for seeded E2E, followed by the `4VCPU`, `5G`
screenshot allocation. Cross-PR host admission control and out-of-process
telemetry remain unresolved.

## Final assessment

The reviewed fixes optimized test isolation, wall-clock speed, and compiled artifact reuse without adding physical-host resource governance. Commit `c211e8c` traded lower per-job contention for higher aggregate Whitesmith demand and is the most relevant change to investigate. This pull request bounds one PR's configured fan-out and repeated setup, but root cause remains unproven until host-side telemetry survives the next runner disconnect.
