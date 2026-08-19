# Track scripts

Track curation and coverage commands. Authoring scripts update canonical registry JSON before regenerating SQLite and report artifacts; guide JSON and TUMFTM boundary data remain separate outputs. Game-specific extractors stay under game domains.

## Commands

| Command | Purpose | Main output |
|---|---|---|
| `bun run tracks:registry` | Canonicalize registry source and rebuild generated artifacts | `shared/data/tracks/registry.sqlite`, `shared/data/tracks/registry-report.json` |
| `bun run tracks:registry:check` | Reject non-canonical source or stale generated artifacts | Check result only |
| `bun run tracks:segments --track <slug> [--game <id>] [--write]` | Detect and align curated corner segments | Canonical `facts.json` and `geometry.json`, then generated artifacts, with `--write` |
| `bun run tracks:coverage [--write]` | Render curation ledger; `--verify` records human verification | Canonical `verification.json` and `docs/contributing/track-curation.md` |
| `bun run scripts/tracks/migrate-track-guides.ts` | Convert inline guide data to per-track JSON | `shared/data/tracks/guides/*.json` |
| `bun run scripts/tracks/migrate-variant-corner-names.ts [--write]` | Copy conservative parent-layout corner names to unnamed variants | Canonical `facts.json`, then generated artifacts, with `--write` |
| `bun run scripts/tracks/snapshot-track-guides.ts` | Capture guide API golden output | JSON on stdout |
| `bun run scripts/tracks/import-tumftm-boundaries.ts` | Import centerline and width boundaries | `shared/data/tracks/tumftm/*.json` |
| `bun run scripts/tracks/verify-unknown-track-fix.ts` | Inspect one local AC Evo unknown-track capture | Diagnostic stdout; reads fixed local download path |

## Input/output boundaries

- `shared/data/tracks/registry-source/{configurations.json, facts.json, geometry.json, verification.json}` are canonical registry input.
- `shared/data/tracks/registry.sqlite` and `registry-report.json` are generated downstream; scripts never edit projection rows or export SQLite into source.
- Authoring commands mutate source through shared APIs, then refresh generated projection and report. Generation never stamps verification; only human `--verify` does.
- Runtime packages and reads generated SQLite only.
- Resolve SQLite or report merge conflicts by merging canonical JSON, then running `bun run tracks:registry`.
- `track-coverage.ts` keeps importable helpers (`parseVerifyTarget`, marker constants, and splice functions) separate from CLI execution.
- Game-specific extraction remains under game domains. Shared normalization belongs in `shared/`, not ad hoc script aliases.

## Focused verification

- Run `bun run tracks:segments --track <slug>` and inspect dry-run alignment output before `--write`.
- Run `bun run tracks:coverage` and confirm ledger tables render; use `--write` only after review.
- Run migration commands without `--write` first and inspect proposed changes.
- Run `bun run tracks:registry:check` after registry source changes.
- For imported boundaries, compare generated JSON point counts and closure against source CSV metadata.
