# Track scripts

Track curation and coverage commands. Authoring scripts update canonical venue/revision/layout metadata before regenerating SQLite and report artifacts; imported legacy boundary data remains a separate game-owned output. Game-specific extractors stay under game domains.

## Commands

| Command | Purpose | Main output |
|---|---|---|
| `bun run tracks:registry` | Canonicalize registry source and rebuild generated artifacts | `shared/data/tracks/registry.sqlite`, `shared/data/tracks/registry-report.json` |
| `bun run tracks:registry:check` | Reject non-canonical source or stale generated artifacts | Check result only |
| `bun run tracks:venue-metadata:seed [--check]` | Seed normalized root venue metadata from game catalogs and official venue sources | Root `venue.json` files plus generated registry artifacts |
| `bun run tracks:segments --track <slug> [--game <gameId>] [--write]` | Detect and align curated corner segments | Matching canonical layout `metadata.json`, then generated artifacts, with `--write` |
| `bun run tracks:coverage [--write]` | Render curation ledger; `--verify` records human verification | Layout `metadata.json` verification records and `docs/contributing/track-curation.md` |
| `bun run scripts/tracks/migrate-variant-corner-names.ts [--write]` | Copy conservative parent-layout corner names to unnamed variants | Matching canonical layout `metadata.json` files, then generated artifacts, with `--write` |
| `bun run scripts/tracks/snapshot-track-guides.ts` | Capture guide API golden output | JSON on stdout |
| `bun run scripts/tracks/import-tumftm-boundaries.ts` | Import centerline and width boundaries | Owning layout `geometry/<gameId>/legacy-boundaries.json` |
| `bun run scripts/tracks/verify-unknown-track-fix.ts` | Inspect one local AC Evo unknown-track capture | Diagnostic stdout; reads fixed local download path |

## Input/output boundaries

- Canonical input is `venues/<root>/venue.json`, each `revisions/<revision-path>/revision.json`, and each revision's `tracks/<layout>/metadata.json`.
- Root-only/current layouts keep ID `<root>/<layout>`; historical IDs use `<root>/<revision-path>/<layout>`, including nested revision paths.
- Authoring commands resolve source paths through shared configuration helpers, mutate metadata, then refresh projection/report. Generation never stamps verification; only human `--verify` does.
- Runtime reads generated SQLite and excludes source manifests/report/hints. Revision imagery, layout game geometry/guides, game-owned legacy baselines, and root shared ACC geometry ship.
- Merge generated-artifact conflicts through source manifests, then regenerate registry.
- Every game-scoped asset operation requires explicit `gameId`.
- `track-coverage.ts` keeps importable helpers (`parseVerifyTarget`, marker constants, and splice functions) separate from CLI execution.
- Game-specific extraction remains under game domains. Shared normalization belongs in `shared/`, not ad hoc script aliases.

`seed-venue-metadata.ts` prefers iRacing's geodata, then F1 and Forza location catalogs, and fills remaining real-venue coordinates from cited OpenStreetMap objects. It labels fictional venues explicitly and removes physical coordinates and time zones from them.

## Focused verification

- Run `bun run tracks:segments --track <slug>` and inspect dry-run alignment output before `--write`.
- Run `bun run tracks:coverage` and confirm ledger tables render; use `--write` only after review.
- Run migration commands without `--write` first and inspect proposed changes.
- Run `bun run tracks:registry:check` after registry source changes.
- Run `bun run tracks:venue-metadata:seed --check` to reject missing or stale venue metadata.
- For imported boundaries, compare generated JSON point counts and closure against source CSV metadata.
