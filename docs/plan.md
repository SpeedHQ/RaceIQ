# Plan: stop duplicating names across games

## Scope

Core change: **classification lives once per track. Per-game segments carry
fractions only.**

Riding along (decided): the dev editor writer, the `ac-evo` alias bypasses, and
the duplicated slug/group-collapse helpers. Guide consolidation, `corner-names/`
deletion, and sector reshape stay out — listed at bottom.

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
{ "type": "corner",   "number": 2, "startFrac": 0.1546, "endFrac": 0.1936 }
{ "type": "straight", "sector": 1, "startFrac": 0,      "endFrac": 0.1546 }
```

Top-level `segments[]` keeps `name`/`group`/`direction`/`number` and loses
`startFrac`/`endFrac`.

**The invariant, stated once.** Turn names, straight names, groupings, and
guide text are properties of the *track*. They are shared across every game and
live top-level, exactly once. The only thing that legitimately varies per game
is where a turn or straight *is* — `startFrac`/`endFrac`. Per-game entries are
geometry plus a join key, nothing else. Anything else appearing in a `games{}`
block is a bug.

Consequence: `gameId` is an input to geometry lookup only. It has no business in
any name, label, group, or guide lookup — those take a slug and a join key.
`track-guides.ts:1112 metaLabelsByTurn(slug, gameId)` loses its `gameId`
parameter rather than being rewired to the seam.

**Join key.** Corners join on `number`. Straights join on sector (`s1`/`s2`/`s3`)
— a straight matches the top-level straight in the same sector. No match means
the fraction detection is probably wrong, so the migration flags it rather than
guessing.

**Top-level is the union.** Per-game blocks currently hold *more* segments than
top-level (2410 vs 1709; `catalunya` top=16 but f1-2025=17, acc=15, fm-2023=16).
Migration widens top-level `segments[]` to a superset covering every turn number
and every sector-straight seen in any game. A game that does not drive a given
segment simply has no per-game entry for it. Invariant stays absolute: no
per-game segment ever carries a classification key.

Files stay where they are. No new file layout, no new directories.

## Corrections to the previous draft

- The "land current work" step is stale. `main` is clean at `8ff0c88`, 0 ahead.
  The 99 modified meta files are in worktree `.claude/worktrees/per-car-setup-ranges/`,
  a separate concern.
- The seam already exists, twice. `server/ai/track-context.ts:41`
  `resolveMetaField(meta, gameId, field)` does the `games[gameId]` → `ac-evo`→`acc`
  alias → top-level chain, and `server/routes/track-routes.ts:177`
  `resolveTrackSegments(ordinal, gameId)` already owns segment fractions. Do not
  add a third; extend these.

## Steps

1. **Extend `resolveMetaField` into a join.** `track-context.ts` gains the
   geometry→classification join and returns today's labelled-segment shape:
   per-game geometry for the fracs, top-level for everything else.
   `track-routes.ts:177 resolveTrackSegments` delegates to it. Consumers
   unchanged at this step.

   Split the surface so the invariant is enforced by the types, not by care:
   a geometry lookup that takes `(slug, gameId)`, and a classification lookup
   that takes `(slug)` only. Nothing that returns a name should accept a
   `gameId`.

2. **Migration script**, `--dry-run`/`--write`. Builds the top-level union,
   strips `name`/`group`/`direction` from per-game segments, strips fracs from
   top-level, adds `sector` to per-game straights.

   Two reports, both gates — read before writing:
   - every per-game name that disagrees with the top-level name for the same key
   - every per-game segment with no join match (suspect fraction detection)

3. **Point consumers at the seam.** `track-guides.ts:1118`, `analyst-prompt.ts`,
   `lap-routes.ts:409`/`:931`, `track-routes.ts:216`/`:529`, client
   `draw-track.ts` / `TrackDetail.tsx` / `TrackInfoPanel.tsx`.

   `analyst-prompt.ts:26-33 PromptSegment` must stop dropping `group`/`direction`
   (the mapper at `lap-routes.ts:935-939` is what drops them) — otherwise
   `segmentPromptLabels` group-collapsing is a no-op there while it fires in
   `track-guides.ts:1123`, and the two label sets disagree.

   `track-guides.ts` keeps its 60 inline guides this PR — but the guide text is
   already track-level, so `metaLabelsByTurn(slug, gameId)` at `:1112` drops its
   `gameId` parameter and `getTrackGuide` (`:1153-1179`) stops threading
   `opts.gameId` through for naming. Guides and names both resolve from slug
   alone. Whatever still needs `gameId` after this is a geometry call.

4. **(A) Fix the writer.** `PUT /api/tracks/:trackOrdinal/segments`
   (`track-routes.ts:492-525`) currently writes `name`/`group` into
   `games[gameId].segments`. It must write geometry to `games{}` and route any
   classification edit to top-level. Without this the dev editor
   (`TrackDetail.tsx:809-819`) re-creates the duplication on the first save.
   Also alias-aware: an `ac-evo` save currently creates a `games["ac-evo"]` block
   that shadows the `acc` block it was reading from.

   Same for `track-segment-generate.ts:187-213 buildUpdatedMeta` and
   `:234-256 autoTrackSegments` (`:249` emits `name`/`direction`). Regenerate.

5. **(B) Kill the alias bypasses.** Five sites hand-roll
   `games?.[gameId]?.X ?? top-level` and so skip `ac-evo`→`acc`:
   `track-guides.ts:1118` (segments), `lap-routes.ts:175` and `:776`,
   `compute-lap-sectors.ts:29`, `sector-tracker.ts:71` (sectors). Route all
   through `resolveMetaField`.

6. **(C) Dedupe helpers.** Slug resolution is copy-pasted in four places —
   `track-context.ts:57`, `analyst-prompt.ts:238`, `track-routes.ts:181` and
   `:507`; collapse to one. `draw-track.ts:268-273` reimplements group collapsing
   (anchors on longest member; `segmentGroupLabels` anchors on first) — use the
   helper, which currently has no production consumer. Delete the unreferenced
   `namedSegments` const at `shared/track-named-segments.ts:36-82`.

7. **Tests.** Golden-compare: joined output matches pre-migration labelled
   segments for all 102 tracks — that is the whole correctness claim. Plus an
   assertion that no per-game segment carries a classification key. Re-baseline
   `test/e2e/output/track-segments*/` SVGs. C changes `draw-track` group-label
   anchoring, so expect real SVG diffs there and eyeball them.

## Follow-ups (not this PR)

- Fold `track-guides.ts` (1252 lines, 60 guides) into per-track meta, anchored on
  turn number. Guides already key off numbers, so this is mechanical later.
- Reconcile 102 meta files vs 96 `corner-names/`; then decide whether
  `corner-names/` merges into `meta/` or stays curated input.
- Sectors as "after corner N" instead of fractions.
- `inputs-compare-prompt.ts:326` uses `segmentDisplayNames` (map format,
  `"T2-4 Eau Rouge/Raidillon"`) against `cornerLabelWhitelist` (prompt format).
  Never matches. Fix needs grouped-row merging and changes row counts.
