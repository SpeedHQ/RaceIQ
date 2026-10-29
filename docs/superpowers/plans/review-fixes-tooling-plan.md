# Review fixes tooling plan

[Shared contract and integration ownership](review-fixes-contract.md)

Two independent OMP owners: release entrypoints/launcher (AC1/16/17) and CI/screenshot harness (AC13–15). CI owner exclusively owns release.yml; update owner must request any needed workflow edit through main. No commits, nested workers, or mid-flight tests/builds/lint/formatters.

| ID | Observable acceptance and fix | Edge/failure handling | Actual-entry-point verification |
|---|---|---|---|
| AC1 | Both Windows compile commands include source-writer, live-capture, opponent-index workers from ordinary build | Preserve other entrypoints/flags; worker failures remain surfaced | E1: build actual release artifact, start recording and LMU indexing with isolated capture fixtures, observe worker results. Cross-compile on macOS only supplements Windows execution; unavailable Windows runtime remains explicit |
| AC13 | AppImage smoke failure fails release step despite tee | Declare bash or pipefail; logging remains available | E13: invoke exact workflow pipeline with failing smoke and successful tee; nonzero exit; success case exits zero |
| AC14 | Manual equal/missing/meaningless range runs full selection for unit/tooling/integration and lint/typecheck | Meaningful ranges remain affected-only; valid equal refs must not select zero | E14: execute actual selection helper with equal valid refs/manual event, inspect nonzero tasks and all full gates; meaningful range keeps intended selection |
| AC15 | Old baseline uses compatible screenshot harness; failure explicitly unavailable evidence | Missing config/dependencies, partial shards and failed capture never masquerade as comparison | E15: invoke screenshot-base against v0.20.0 with isolated worktree/output; both captures feed comparison; forced baseline failure produces unavailable status, not comparison claim |
| AC16 | AMS2 dump script uses shared safe launcher | Preserve proxy, --dump-only semantics, cooperative finalization and sibling behavior | E16: execute launcher non-destructive path/shutdown fixture and verify ams2 command dispatch; native hardware qualification unavailable on macOS |
| AC17 | Compiled-browser binary validation uses platform-aware `node:path.isAbsolute` | Native drive/UNC accepted on Windows; relative paths rejected; nonexistent paths fail existence check instead | E17: actual start-server harness launches local compiled binary using native absolute path; Windows drive/UNC boundary regression plus Windows execution when available |

Main executes targeted existing tooling and integration suites, actual command smokes, `bun run typecheck`, and records outcomes. Tests must inspect behavior, not source text copies. Update command documentation/callers only where changed routing requires it. No failing-before rerun needed for user-proven failures. Packaged/native platform proof is separate from generic build/startup.
