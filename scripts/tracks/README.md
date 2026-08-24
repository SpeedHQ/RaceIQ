# Track scripts

Track curation, migration, and coverage commands. These scripts write committed track facts, per-game segment geometry, guide JSON, and TUMFTM boundary data; they do not extract game-specific assets.

## Commands

| Command | Purpose | Main output |
|---|---|---|
| `bun run tracks:segments --track <slug> [--game <id>] [--write]` | Detect and align curated corner segments | `shared/data/tracks/<game>/<slug>-segments.json` and track meta when `--write` |
| `bun run tracks:coverage [--write]` | Render curation ledger; `--verify` records human verification | `docs/contributing/track-curation.md` when `--write` |
| `bun run tracks:registry` / `bun run tracks:registry:check` | Rebuild generated registry artifacts or verify committed artifacts without writes | `shared/data/tracks/registry.sqlite` and `registry-report.json` |
| `bun run scripts/tracks/migrate-track-meta.ts [--track <slug>] [--write]` | Convert legacy per-game meta into facts and geometry | `shared/data/tracks/meta/*.json`, per-game `*-segments.json` |
| `bun run scripts/tracks/migrate-track-guides.ts` | Convert inline guide data to per-track JSON | `shared/data/tracks/guides/*.json` |
| `bun run scripts/tracks/migrate-variant-corner-names.ts [--write]` | Copy conservative parent-layout corner names to unnamed variants | Updated `shared/data/tracks/meta/*.json` with `--write` |
| `bun run scripts/tracks/snapshot-track-guides.ts` | Capture guide API golden output | JSON on stdout |
| `bun run scripts/tracks/import-tumftm-boundaries.ts` | Import centerline and width boundaries | `shared/data/tracks/tumftm/*.json` |
| `bun run scripts/tracks/verify-unknown-track-fix.ts` | Inspect one local AC Evo unknown-track capture | Diagnostic stdout; reads fixed local download path |

## Input/output boundaries

- Read legacy metadata, curated facts, game roster CSVs, guide modules, and external TUMFTM CSVs.
- Write only track curation artifacts and explicitly requested migration outputs.
- `migrate-track-meta.ts` defaults dry-run; migration helpers split input/merge, identity, segment voting, TrackFacts layout, and file orchestration responsibilities.
- `track-coverage.ts` keeps importable helpers (`parseVerifyTarget`, marker constants, and splice functions) separate from CLI execution.
- Game-specific extraction remains under game domains. Shared normalization belongs in `shared/`, not ad hoc script aliases.

## Focused verification

- Run `bun run tracks:segments --track <slug>` and inspect dry-run alignment output before `--write`.
- Run `bun run tracks:coverage` and confirm ledger tables render; use `--write` only after review.
- Run `bun run tracks:registry:check` before committing source manifest changes; CI runs same command in Build & Test.
- Run migration commands without `--write` first; inspect conflict and dormant-layout reports.
- For imported boundaries, compare generated JSON point counts and closure against source CSV metadata.
