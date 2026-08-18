# Track scripts

Track curation and coverage commands. Scripts write bundled registry rows, guide JSON, and TUMFTM boundary data; game-specific extractors remain under game domains.

## Commands

| Command | Purpose | Main output |
|---|---|---|
| `bun run tracks:segments --track <slug> [--game <id>] [--write]` | Detect and align curated corner segments | Registry facts and per-game geometry rows with `--write` |
| `bun run tracks:coverage [--write]` | Render curation ledger; `--verify` records human verification | Registry verification rows and `docs/contributing/track-curation.md` |
| `bun run scripts/tracks/migrate-track-guides.ts` | Convert inline guide data to per-track JSON | `shared/data/tracks/guides/*.json` |
| `bun run scripts/tracks/migrate-variant-corner-names.ts [--write]` | Copy conservative parent-layout corner names to unnamed variants | Updated registry facts with `--write` |
| `bun run scripts/tracks/snapshot-track-guides.ts` | Capture guide API golden output | JSON on stdout |
| `bun run scripts/tracks/import-tumftm-boundaries.ts` | Import centerline and width boundaries | `shared/data/tracks/tumftm/*.json` |
| `bun run scripts/tracks/verify-unknown-track-fix.ts` | Inspect one local AC Evo unknown-track capture | Diagnostic stdout; reads fixed local download path |

## Input/output boundaries

- Read bundled registry, game roster CSVs, guide modules, and external TUMFTM CSVs.
- Write only track curation artifacts and explicitly requested migration outputs.
- `track-coverage.ts` keeps importable helpers (`parseVerifyTarget`, marker constants, and splice functions) separate from CLI execution.
- Game-specific extraction remains under game domains. Shared normalization belongs in `shared/`, not ad hoc script aliases.

## Focused verification

- Run `bun run tracks:segments --track <slug>` and inspect dry-run alignment output before `--write`.
- Run `bun run tracks:coverage` and confirm ledger tables render; use `--write` only after review.
- Run migration commands without `--write` first and inspect proposed changes.
- For imported boundaries, compare generated JSON point counts and closure against source CSV metadata.
