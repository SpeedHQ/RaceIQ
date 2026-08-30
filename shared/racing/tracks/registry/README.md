# Track registry artifacts

Track registry keeps editable track identity, facts, geometry, and verification source separate from runtime artifacts.

## Files and authority

- `shared/data/tracks/venues/**/venue.json`, `revision.json`, and `metadata.json` are editable source authority.
- Per-game `geometryByGame` records in layout metadata are editable geometry source authority.
- `shared/data/tracks/registry.json` is compact generated runtime read model.
- `shared/data/tracks/registry-report.json` is generated audit output.

Never edit generated registry or report directly. Resolve conflicts in source manifests, then regenerate artifacts.

## Commands

```sh
bun run tracks:registry
bun run tracks:registry:check
```

`tracks:registry` validates and canonicalizes source, rebuilds compact JSON read model, validates every bundled iRacing SVG map, and writes report atomically.

`tracks:registry:check` performs no persistent writes. It fails when source files are non-canonical, generated read model differs from expected output, report differs, any assigned iRacing SVG layer is missing or invalid, or interrupted update journal remains.

CI runs `tracks:registry:check` in `.github/workflows/build-test.yml`, next to generated telemetry catalog check. Pull requests cannot pass Build & Test with stale registry artifacts.

Track configuration authoring APIs use `updateTrackRegistrySource()` and rebuild source, JSON read model, and report in one recoverable transaction. Manual source edits require `bun run tracks:registry` before commit.

## Report stability

Report is deterministic. It contains no generation timestamp, build ID, or current Git commit. `sourceHash` identifies registry source file names and contents only.

Unchanged source produces byte-identical report, so unrelated commits create no Git diff. Current report is about 328 KiB and grows with track assignments, facts, geometry, and diagnostics. It is regular Git text, not LFS content, so Git can delta-compress real changes.

## Modules

- `source.ts` parses, validates, canonicalizes, and renders editable source.
- `read-model.ts` builds, renders, parses, and validates compact generated JSON.
- `report.ts` renders audit report from deterministic read model.
- `update.ts` handles atomic updates, interruption recovery, and artifact freshness checks.
