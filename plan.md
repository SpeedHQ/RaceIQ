# Plan: stop duplicating names across games

## Scope

One change: **classification lives once per track. Per-game segments carry
fractions only.**

Nothing else. Guide consolidation, `corner-names/` deletion, sector reshape,
the two label bugs — all out, listed at bottom as follow-ups.

## Problem (measured)

`shared/tracks/meta/<slug>.json` holds a top-level `segments[]` AND a `games{}`
map. Both carry `name`/`group`:

- 1709 top-level segments, 102 files
- 135 game blocks (`f1-2025, acc, ac-evo, fm-2023`), 2410 segments
- **2410 of 2410** per-game segments carry `name` and/or `group`

Rename Rivazza → touch up to 5 places in one file. Nothing enforces agreement.

## Change

Per-game segment entries drop to geometry:

```jsonc
{ "type": "corner",   "number": 2,  "startFrac": 0.1546, "endFrac": 0.1936 }
{ "type": "straight", "ordinal": 1, "startFrac": 0,      "endFrac": 0.1546 }
```

Top-level `segments[]` keeps `name`/`group`/`direction`/`number` and loses
`startFrac`/`endFrac`. Join on `number` (turn numbers are stable across games;
names are not).

Files stay where they are. No new file layout, no new directories.

## Steps

1. **Land current work.** 99 modified `meta/*.json` + 11 modified source files on
   `worktree-auto-tune`, ahead 1 unpushed. Commit and push first or this diff is
   unreadable.

2. **`resolveTrackSegments(gameId, slug)`** — join per-game geometry to
   top-level classification, return today's labelled-segment shape. Single seam;
   consumers unchanged.

3. **Migration script**, `--dry-run`/`--write`. Strips `name`/`group`/`direction`
   from per-game segments, strips fracs from top-level. **Reports every case
   where a per-game name disagrees with the top-level name.**

   That report is the gate. Nonempty means the duplication was hiding real
   drift — read it before writing.

4. **Point consumers at the seam.** `track-guides.ts`, `analyst-prompt.ts`,
   `track-routes.ts`, `lap-routes.ts`, `track-named-segments.ts`,
   `track-segment-align.ts`, and client `segment-label.ts` / `draw-track.ts` /
   `TrackDetail.tsx` / `TrackInfoPanel.tsx`.

   `track-guides.ts` keeps its 60 inline guides this PR. Only its name lookup
   moves.

5. **`track-segment-generate.ts` stops emitting `name`/`group`.** Regenerate.

6. **Tests.** Golden-compare: joined output matches pre-migration labelled
   segments for all 102 tracks — that is the whole correctness claim. Plus an
   assertion that no per-game segment carries a classification key, so this
   cannot regress. Re-baseline `test/e2e/output/track-segments*/` SVGs.

## Follow-ups (not this PR)

- Fold `track-guides.ts` (1252 lines, 60 guides) into per-track meta, anchored on
  turn number. Guides already key off numbers, so this is mechanical later.
- Reconcile 102 meta files vs 96 `corner-names/`; then decide whether
  `corner-names/` merges into `meta/` or stays curated input.
- Sectors as "after corner N" instead of fractions.
- `inputs-compare-prompt.ts:326` uses `segmentDisplayNames` (map format,
  `"T2-4 Eau Rouge/Raidillon"`) against `cornerLabelWhitelist` (prompt format).
  Never matches. Fix needs grouped-row merging and changes row counts.
- `draw-track.ts:259-273` re-implements `segmentGroupLabels`, anchoring group
  labels on longest member vs helper's first member.

## Open call

Top-level `segments[]` vs per-game `ordinal` for straights: straights have no
official number, so the join key is positional. Confirm ordinal is stable across
games before relying on it, or key straights on "after corner N" now rather than
migrating twice.
