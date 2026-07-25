---
name: track-segment-meta-architecture
description: track facts (names/turn numbers) and per-game geometry (fractions) are separate files; how they join and flow to the UI
type: project
---

A track layout is described by **two** files. Classification is a property of the
circuit; only where a corner sits varies per game, because each game digitises
its own centerline.

```
shared/tracks/meta/<slug>.json               facts    — turn numbers, names, groups, layout identity
shared/tracks/<gameId>/<slug>-segments.json  geometry — fractions, per-game sectors
```

A name never appears in a geometry file; a fraction never appears in a facts
file. `joinSegments`/`splitSegments` in `shared/track-meta.ts` convert between
the split form and the labelled `NamedSegment` shape consumers use.

**Facts shape:** `{ slug, track, layout, layoutName, name, corners[], straights? }`.
`track` is the physical venue (groups layouts: `brands-hatch-indy` and
`brands-hatch` share `brands-hatch`), `layoutName` renders as `<name> — <layoutName>`.
Corners are `{ number, covers?, name, direction?, group? }`; `number` is always
the lowest of the span it covers.

**Keys.** Corners key on turn number (`t3`, `t10-11`) — the one identifier every
game agrees on. Straights key on the corner they follow (`s3` = the gap after
turn 3). Straights are derived from the corner list, so only the ~31 gaps with
real names get a facts entry; the rest are anonymous connective tissue.

**An empty corner `name` means the circuit does not name that turn.** The display
token `T3` / `T3-4` is synthesized by `joinSegments` and must never be stored as
a fact — `isPlaceholderName` recognises it on the way back in.

**Access — always via `shared/track-data.ts`, never by reading the files:**
- `loadTrackFacts(slug)` — takes NO gameId, deliberately. Anything returning a
  name that accepts a gameId is a bug.
- `loadTrackGeometry(slug, gameId)` / `loadTrackSectorsFor(slug, gameId)`
- `loadLabelledSegments(slug, gameId)` — the joined list; `[]` when the game has
  no geometry, so callers fall through to their own auto-detection rather than
  borrowing another game's fractions.
- `saveTrackFacts` / `saveTrackGeometry`

The `ac-evo` → `acc` geometry fallback lives **inside** `loadTrackGeometry`.
Never hand-roll it at a call site; five sites used to and drifted apart.

**Segment pipeline (server-side):**
1. `GET /api/track-sectors/:ordinal?gameId=X` — `loadLabelledSegments` first
2. Falls back to auto-detection from the telemetry outline
3. `PUT /api/tracks/:trackOrdinal/segments?gameId=X` (dev only) — splits the
   posted list: fractions to the geometry file, names/groups to the facts file.
   Merges rather than replaces, so a game that misses a turn cannot delete it
   for every other game.

**Critical gotcha:** the PUT requires `?gameId=X` and now returns 400 without it
— fractions are always game-specific. `TrackDetail.tsx` passes it.

**Shared adapter note:** ACC and F1's *shared* `getSharedTrackName()` are stubs
returning `undefined`; only the server adapters implement it. Code using
`tryGetGame()` (shared registry) therefore resolves no slug for those games and
falls back to default sectors. Pre-existing, applies to `sector-tracker.ts`.

**Invariant, enforced by `test/track-meta.test.ts`:** every game must place
exactly the corners its facts file declares, and every *named* straight. Games
model the same circuit, so a gap is a detector bug — it fails the build. Known
gaps live in `KNOWN_CORNER_GAPS` / `KNOWN_STRAIGHT_GAPS`, both shrink-only (a
fixed gap must be deleted, or the stale-entry test fails). Straight *row count*
is deliberately unconstrained: detectors split gaps differently and counts
differ on 16 of 23 multi-game layouts.

**How to apply:** to change a corner name, edit the facts file once — it applies
to every game. To change where a corner is, edit that game's geometry file. For
curated tracks the generator owns both: edit
`shared/tracks/corner-names/<slug>.json` and run `bun run tracks:segments --all --write`.
