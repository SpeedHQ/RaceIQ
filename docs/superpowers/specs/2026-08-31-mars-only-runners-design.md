# Mars-Only GitHub Actions Runners

## Goal

Remove Blacksmith runner usage from RaceIQ CI and release workflows. Every affected job must run on the existing Mars Windows runner label, `mars-windows-x64`.

## Scope

Update these workflows:

- `.github/workflows/native-replay.yml`
- `.github/workflows/pr-snapshots.yml`
- `.github/workflows/release.yml`
- `.github/workflows/update-baselines.yml`

Existing Mars-backed jobs and reusable Playwright inputs remain unchanged. No application code, test behavior, job ordering, artifact names, or permissions change.

## Runner mapping

- Blacksmith Windows jobs map directly to the Mars Windows runner label.
- Blacksmith Linux jobs map to `mars-windows-x64`, preserving equivalent CPU and memory labels where the workflow already specifies them.
- Jobs currently using a Linux container are converted only as required for execution on the Windows runner. Containerized Linux behavior must not be silently assumed to work on Windows.

## Implementation

1. Replace every active `blacksmith-*` `runs-on` value with Mars Windows configuration.
2. Inspect each affected job for `container`, shell, package-manager, path, and command assumptions that conflict with Windows.
3. Make the smallest workflow-only adjustments needed to keep each job executable on Mars Windows.
4. Leave already-Mars jobs untouched.
5. Add an explicit `skip_tests` boolean input to the release workflow's manual dispatch trigger, defaulting to `false`.
6. When `skip_tests` is enabled, skip release Playwright jobs while allowing `draft-release` to run after a successful build. Keep the default path test-enabled and expose the skip in the workflow summary.
7. Confirm no active workflow retains a Blacksmith runner reference.

## Error handling and compatibility

Workflow failures remain visible through normal GitHub Actions status. This change does not add fallbacks to Blacksmith or other providers. Linux-specific container/package behavior is the primary compatibility risk; affected steps must use existing Windows-compatible project commands or be adjusted explicitly.

## Verification

- Search active workflow files and confirm zero `blacksmith` references.
- Parse/validate all changed workflow YAML.
- Run repository-configured targeted workflow or CI validation available locally.
- Review the final diff for unchanged job dependencies, artifacts, permissions, and triggers.
