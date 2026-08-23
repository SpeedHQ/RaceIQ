# Release Feature Flag Test Fix

`loadReleaseEnvironment` now passes a copied environment to `Bun.spawnSync` after removing inherited `RACEIQ_FEATURE_F1_EXPERIMENTS` and `RACEIQ_FEATURE_IRACING_ADAPTER` values. This keeps `--env-file` production values authoritative.

Verification:

- Reproduced prior precedence behavior with both flags inherited as `true` and `--env-file=../../.env.production`; child output was both `true`.
- Ran with both flags inherited as `true`:
  `bun test test/runtime/release-feature-flags.test.ts --timeout 30000`
- Result: 7 pass, 0 fail.
