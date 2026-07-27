# Track Curation & Verification

How corner data gets into RaceIQ, which layer wins, and what "verified" means.

Short version: **curated geometry is the source of truth. The detector is a fallback. Curated is not the same as correct — verification is a separate, human-only claim.**

## The hierarchy

Four layers, highest wins. Each one may be partial; lower layers fill the gaps.

| Rank | Layer | File | Authored by |
|------|-------|------|-------------|
| 1 | **Curated geometry** | `shared/tracks/<gameId>/<slug>-segments.json` | human, per game |
| 2 | **Curated roster** (names, numbers, direction, groups) | `shared/tracks/meta/<slug>.json` | human, shared across games |
| 3 | **Detect hints** (nudges for the fallback detector) | `shared/tracks/detect-hints.json` | human |
| 4 | **Fallback detector** | `detectCornerRegions()` in `shared/track-segment-generate.ts` | code |

### Why the roster is shared but geometry is not

A circuit's corner names and numbering are a property of the *circuit* — Spa's Eau Rouge is Eau Rouge in every game. So the roster lives once, keyed by slug.

Where a corner physically *is* depends on the game's centerline, which differs per title (different digitisation, different granularity, sometimes a racing line rather than a centerline). So geometry is keyed by `gameId` + slug.

## The fallback detector

`track-segment-generate.ts` infers corner regions from centerline curvature. It exists so a track that nobody has curated still renders something usable. **It will never be 100% accurate**, and it is not supposed to be.

Consequences, all deliberate:

- A detector miss on one track is **not a bug** if that track has accurate curated geometry. Fix the curated data.
- Only touch the detector when it is wrong in a *general* way — a bug affecting every track. Never to chase one slug's alignment. Tuning thresholds to rescue one circuit reliably breaks three others.
- Counting geometry files as "curation" would read ~100%, because the detector writes one for nearly every centerline. Hence the roster-based coverage stat below.

### Sanctioned gaps

Accepted detector misses are recorded in `test/helpers/track-known-gaps.ts` — `KNOWN_ALIGNMENT_GAPS`, `KNOWN_FUZZY_ALIGNMENTS`, `KNOWN_TURN_GAPS`.

These are **shrink-only**: every entry is asserted to *still* be broken, so fixing one forces its deletion. Adding an entry is legitimate when the miss is genuinely a centerline-quality problem, and each entry needs a reason comment. It is not a way to silence a regression in curated data.

Known centerline-quality classes, already understood — don't re-litigate:

- ACC tracks whose "centerline" is still the fastlane racing line (issue #98; fixed per-track by `scripts/acc-centerline-from-boundaries.ts`).
- ac-evo centerlines that under-detect individual corners.
- Forza's Nordschleife / Watkins Glen, digitised at a different corner granularity than the shared name list.

## Coverage & verification

Three claims, weakest to strongest. They are tracked separately because each says nothing about the next.

| Claim | Means | Proof |
|-------|-------|-------|
| **Curated roster** | someone hand-authored a non-empty `corners` array | `shared/tracks/meta/<slug>.json` exists with corners |
| **Meta human-verified** | someone checked that roster against a real turn-by-turn guide | a `verified` block in that `meta/<slug>.json` |
| **Segments human-verified** | someone checked that game's rendered geometry | a `verified` block in that `<slug>-segments.json` |

### The `verified` block

The sign-off lives in the file it describes, not in a side ledger that can drift from it:

```json
{
  "slug": "suzuka",
  "verified": { "by": "aaronc", "date": "2026-07-27", "note": "official Suzuka circuit map" },
  "corners": [ … ]
}
```

`by` is a person, never a tool. `note` is what they checked it against, and can be
omitted when the file's own `source` already says.

The block is **content-bound**. Every writer — the generator, the segment editor,
the sector editor — routes its save through `carryVerified()` in
`shared/track-meta.ts`, which keeps the block only when the rest of the file is
byte-for-byte unchanged and drops it otherwise. So a regeneration that shifts one
corner silently voids the sign-off; a re-run that changes nothing keeps it. Nothing
in the pipeline can *add* a block — only a human editing the file can.

The gap between column 1 and column 3 is the whole point. F1 25 is 24/24 curated and its segments are still known-inaccurate — a correct roster says nothing about whether the corners landed in the right *place*.

### Coverage table

**Hand-maintained. Nothing generates this — that is the point.** A generated table would only re-state what the repo already contains; it could never record that a *human looked at a track and agreed with it*. Update the row yourself in the same PR that curates or verifies a track.

| Game | Tracks | Curated roster | Meta human-verified | Segments human-verified | Not yet curated |
|------|--------|----------------|---------------------|-------------------------|-----------------|
| Forza Motorsport (fm-2023) | 71 | 68 | 0 | 0 | daytona-oval, fujimi-kaido, fujimi-kaido-r |
| F1 25 (f1-2025) | 24 | 24 | 0 | 0 | — |
| ACC (acc) | 25 | 25 | 0 | 0 | — |
| AC Evo (ac-evo) | 20 | 20 | 0 | 0 | — |
| **Total** | **140** | **137** | **0** | **0** | |

Both verified columns read 0 on purpose. Sebring and Suzuka were curated carefully
against real guides, but curation was done *with* Claude, and nobody has since sat
down and independently checked either one. Until someone does and signs the file,
the honest number is zero.

Last updated: 2026-07-27.

### Reading the table

| Column | Counts |
|--------|--------|
| **Tracks** | the denominator — distinct slugs this game ships a centerline for |
| **Curated roster** | slugs with a hand-authored `meta/<slug>.json` carrying a non-empty `corners` array |
| **Meta human-verified** | rosters a human checked against a real turn-by-turn guide, named inline |
| **Segments human-verified** | that game's `<slug>-segments.json` a human eyeballed against a circuit map |
| **Not yet curated** | the exact uncurated slugs, so the remainder is actionable rather than a number |

Denominator notes:

- **Tracks is per game, not global.** Same circuit in four games = four rows' worth of work. Totals are a sum of rows, not a count of distinct circuits.
- **Rosters are shared, verification is not.** One `meta/<slug>.json` serves every game, so verifying `suzuka` credits every game that ships a Suzuka centerline. Segments are per game — each title digitises its own.
- **Forza slugs are de-ordinalised.** `brands-hatch-860-centerline.csv` → `brands-hatch`.
- **Curated roster is the honest metric.** Counting `<slug>-segments.json` files would read ~100% and measure nothing, because the fallback detector writes one for essentially every centerline.
- **Verified columns use Tracks as the base**, never Curated — so they cannot flatter themselves by shrinking the denominator.

### What the numbers mean

Rosters are nearly everywhere, almost nothing has been checked against a real guide, and **rendered geometry has barely been checked by a human at all**. A high curated count is not a quality claim. F1 25 sits at 24/24 curated with segments known to be misplaced — exactly the gap the third column exists to expose.

The uncurated remainder is three Forza fantasy tracks (`daytona-oval`, `fujimi-kaido`, `fujimi-kaido-r`) — no real-world turn-by-turn guide exists for them, so they stay uncurated by choice, not by neglect. They are the reason curated will never read 140/140, and that is correct.

Expect the verified columns to climb slowly. That is the design.

### Signing off

Verification is a human act. Look at the thing, then record it.

1. Check the roster against a real turn-by-turn guide, or check the committed render at `test/e2e/output/track-segments/<slug>-<gameId>.svg` against a circuit map.
2. Add a `verified` block to that file by hand, with your name, today's date, and what you checked it against.
3. Bump the relevant cell in the table above, name the slug, bump *Last updated*.
4. Say the same thing in the PR ("official Suzuka circuit map", "IMSA 17-turn numbering") — that sentence is the evidence.

Rules:

- **Only a human verifies.** Nothing in the generation pipeline may touch these numbers. Claude proposes; the user confirms what they actually looked at.
- **Re-curating voids the sign-off**, and this is enforced, not remembered: change a verified file's content and `carryVerified()` strips the block on the next write. Drop the table cell to match.
- **You cannot verify what was never curated.** Verified never exceeds curated.
- **Low numbers are honest.** Not a metric to farm.

## Where effort belongs

Getting curated geometry and rosters *accurate*, against real turn-by-turn guides, per track. Not endlessly tuning the generator.

If a track looks wrong in the app: fix that track's curated data.

## Source of truth

| Concern | File |
|---------|------|
| Fallback detection + generation | `shared/track-segment-generate.ts` |
| Curated rosters | `shared/tracks/meta/<slug>.json` |
| Coverage + verification record | the table in this doc — hand-maintained, no generator |
| Guards | `test/helpers/track-known-gaps.ts` |
