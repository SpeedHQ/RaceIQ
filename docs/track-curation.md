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
| **Meta human-verified** | someone checked that roster against a real turn-by-turn guide | ledger entry for that file |
| **Segments human-verified** | someone checked that game's rendered geometry | ledger entry for that file |

### The ledger

Sign-offs live in one file, `shared/tracks/verified.json`, keyed by the **path of
the file signed**:

```json
{
  "shared/tracks/meta/suzuka.json": {
    "hash": "95778f6106d2",
    "date": "2026-07-27",
    "by": "aaronc",
    "note": "official Suzuka circuit map"
  },
  "shared/tracks/f1-2025/spa-segments.json": { "hash": "…", "date": "…", "by": "…" }
}
```

The path is the whole record of *what* was checked — `meta/` entries are rosters,
`<gameId>/*-segments.json` entries are that game's geometry. `by` is a person,
never a tool. `note` is what they checked it against.

Entries are **hash-bound**: `hash` is a short sha256 of the file at sign-off, so
editing that file makes the signature **stale**. A stale entry stops counting as
verified and renders as `+N stale` until a human looks again and re-stamps. That
is the ledger's answer to the obvious objection — a side file can drift from what
it describes, so it is not allowed to: drift is detected and it costs you the
claim, silently keeping it is impossible.

Nothing in the pipeline writes an entry. They only ever arrive by a person running
`--verify`.

The gap between column 1 and column 3 is the whole point. F1 25 is 24/24 curated and its segments are still known-inaccurate — a correct roster says nothing about whether the corners landed in the right *place*.

### Summary

Generated — do not hand-edit. This doc is the only place the numbers live; CLAUDE.md carries the rules and points here.

<!-- track-coverage:start -->
| Game | Tracks | Curated roster | Meta human-verified | Segments human-verified | Not yet curated |
|------|--------|----------------|---------------------|-------------------------|-----------------|
| Forza Motorsport (fm-2023) | 71 | 68/71 (96%) | 0/71 (0%) | 0/71 (0%) | daytona-oval, fujimi-kaido, fujimi-kaido-r |
| F1 25 (f1-2025) | 24 | 24/24 (100%) | 0/24 (0%) | 0/24 (0%) | — |
| ACC (acc) | 25 | 25/25 (100%) | 0/25 (0%) | 0/25 (0%) | — |
| AC Evo (ac-evo) | 20 | 20/20 (100%) | 0/20 (0%) | 0/20 (0%) | — |
| **Total** | **140** | **137/140 (98%)** | **0/140 (0%)** | **0/140 (0%)** | |
<!-- track-coverage:end -->

Both verified columns read 0 on purpose. Sebring and Suzuka were curated carefully
against real guides, but curation was done *with* Claude, and nobody has since sat
down and independently checked either one. Until someone does and signs the file,
the honest number is zero.

### Reading the table

Every cell is `n/total (pct%)`, optionally `+N stale`.

| Column | Counts | Computed from |
|--------|--------|---------------|
| **Tracks** | the denominator — distinct slugs this game ships a centerline for | `listAllCenterlines()` |
| **Curated roster** | slugs with a hand-authored `meta/<slug>.json` carrying a non-empty `corners` array | `listCuratedSlugs()` |
| **Meta human-verified** | rosters signed off **and unchanged since** | ledger hash vs file |
| **Segments human-verified** | that game's `<slug>-segments.json` signed off and unchanged since | ledger hash vs file |
| **Not yet curated** | the exact uncurated slugs, so the remainder is actionable rather than a number | |
| **`+N stale`** | signed off, then the file changed — signature void, needs a re-look | |

Denominator notes:

- **Tracks is per game, not global.** Same circuit in four games = four rows' worth of work. Totals are a sum of rows, not a count of distinct circuits.
- **Forza slugs are de-ordinalised.** `brands-hatch-860-centerline.csv` → `brands-hatch`, since the roster is keyed by slug, not by in-game ordinal (`canonicalSlug()`).
- **Curated roster is the honest metric.** Counting `<slug>-segments.json` files would read ~100% and measure nothing, because the fallback detector writes one for essentially every centerline.
- Both verified columns use **Tracks** as the denominator, not Curated — so they never flatter themselves by shrinking the base.

Adding a game to `GameId` breaks `GAME_LABELS` on purpose; there is no default row.

### What the numbers mean

Read the summary as: rosters are nearly everywhere, almost nothing has been checked against a real guide, and **rendered geometry has barely been checked by a human at all**. A high curated percentage is not a quality claim. F1 25 sits at 24/24 curated with segments known to be misplaced — exactly the gap the third column exists to expose.

The uncurated remainder is three Forza fantasy tracks (`daytona-oval`, `fujimi-kaido`, `fujimi-kaido-r`) — no real-world turn-by-turn guide exists for them, so they stay uncurated by choice, not by neglect. They are the reason curated will never read 100%, and that is correct.

Expect the verified columns to climb slowly. That is the design.

Refresh after curating anything:

```bash
bun run tracks:coverage            # print
bun run tracks:coverage --write    # rewrite the summary above + the detail tables below
```

### Per-track detail

Generated — do not hand-edit. `✅` = signed off and unchanged since; `⚠️ stale` = signed off then the file changed; `—` = never checked. **Curated roster** is shared across games (one `meta/<slug>.json`), so that column repeats per game by design; **Segments verified** is per game because each title digitises its own centerline.

<!-- track-detail:start -->
#### Forza Motorsport (fm-2023)

68/71 (96%) curated · 0/71 (0%) meta-verified · 0/71 (0%) segments-verified

| Track | Curated roster | Meta verified | Segments verified |
|-------|----------------|---------------|-------------------|
| brands-hatch | ✅ | — | — |
| brands-hatch-indy | ✅ | — | — |
| catalunya | ✅ | — | — |
| catalunya-s | ✅ | — | — |
| catalunya-s2 | ✅ | — | — |
| daytona | ✅ | — | — |
| daytona-oval | — | — | — |
| eaglerock | ✅ | — | — |
| eaglerock-oval | ✅ | — | — |
| eaglerock-r | ✅ | — | — |
| fujimi-kaido | — | — | — |
| fujimi-kaido-r | — | — | — |
| grand-oak | ✅ | — | — |
| grand-oak-r | ✅ | — | — |
| grand-oak-s | ✅ | — | — |
| hakone | ✅ | — | — |
| hakone-s | ✅ | — | — |
| hakone-sr | ✅ | — | — |
| hockenheim | ✅ | — | — |
| hockenheim-s | ✅ | — | — |
| hockenheim-s2 | ✅ | — | — |
| homestead | ✅ | — | — |
| homestead-oval | ✅ | — | — |
| indianapolis | ✅ | — | — |
| indianapolis-oval | ✅ | — | — |
| kyalami | ✅ | — | — |
| laguna-seca | ✅ | — | — |
| laguna-seca-s | ✅ | — | — |
| le-mans | ✅ | — | — |
| le-mans-old | ✅ | — | — |
| lime-rock | ✅ | — | — |
| lime-rock-alt | ✅ | — | — |
| lime-rock-sc | ✅ | — | — |
| maple-valley | ✅ | — | — |
| maple-valley-s | ✅ | — | — |
| maple-valley-sr | ✅ | — | — |
| mid-ohio | ✅ | — | — |
| mid-ohio-s | ✅ | — | — |
| mount-panorama | ✅ | — | — |
| mugello | ✅ | — | — |
| mugello-s | ✅ | — | — |
| nordschleife | ✅ | — | — |
| nurburgring | ✅ | — | — |
| nurburgring-nord | ✅ | — | — |
| nurburgring-s | ✅ | — | — |
| road-america | ✅ | — | — |
| road-america-s | ✅ | — | — |
| road-atlanta | ✅ | — | — |
| road-atlanta-s | ✅ | — | — |
| sebring | ✅ | — | — |
| sebring-s | ✅ | — | — |
| silverstone | ✅ | — | — |
| silverstone-s | ✅ | — | — |
| silverstone-s2 | ✅ | — | — |
| spa | ✅ | — | — |
| sunset-peninsula | ✅ | — | — |
| sunset-peninsula-oval | ✅ | — | — |
| sunset-peninsula-r | ✅ | — | — |
| sunset-peninsula-s | ✅ | — | — |
| sunset-peninsula-sr | ✅ | — | — |
| vir | ✅ | — | — |
| vir-ge | ✅ | — | — |
| vir-gw | ✅ | — | — |
| vir-n | ✅ | — | — |
| vir-s | ✅ | — | — |
| watkins-glen | ✅ | — | — |
| watkins-glen-s | ✅ | — | — |
| yas-marina | ✅ | — | — |
| yas-marina-n | ✅ | — | — |
| yas-marina-nc | ✅ | — | — |
| yas-marina-s | ✅ | — | — |

#### F1 25 (f1-2025)

24/24 (100%) curated · 0/24 (0%) meta-verified · 0/24 (0%) segments-verified

| Track | Curated roster | Meta verified | Segments verified |
|-------|----------------|---------------|-------------------|
| austin | ✅ | — | — |
| baku | ✅ | — | — |
| budapest | ✅ | — | — |
| catalunya | ✅ | — | — |
| imola | ✅ | — | — |
| interlagos | ✅ | — | — |
| jeddah | ✅ | — | — |
| las-vegas | ✅ | — | — |
| lusail | ✅ | — | — |
| melbourne | ✅ | — | — |
| mexico-city | ✅ | — | — |
| miami | ✅ | — | — |
| monaco | ✅ | — | — |
| montreal | ✅ | — | — |
| monza | ✅ | — | — |
| sakhir | ✅ | — | — |
| shanghai | ✅ | — | — |
| silverstone | ✅ | — | — |
| singapore | ✅ | — | — |
| spa | ✅ | — | — |
| spielberg | ✅ | — | — |
| suzuka | ✅ | — | — |
| yas-marina | ✅ | — | — |
| zandvoort | ✅ | — | — |

#### ACC (acc)

25/25 (100%) curated · 0/25 (0%) meta-verified · 0/25 (0%) segments-verified

| Track | Curated roster | Meta verified | Segments verified |
|-------|----------------|---------------|-------------------|
| austin | ✅ | — | — |
| brands-hatch | ✅ | — | — |
| budapest | ✅ | — | — |
| catalunya | ✅ | — | — |
| donington | ✅ | — | — |
| imola | ✅ | — | — |
| indianapolis | ✅ | — | — |
| kyalami | ✅ | — | — |
| laguna-seca | ✅ | — | — |
| misano | ✅ | — | — |
| monza | ✅ | — | — |
| mount-panorama | ✅ | — | — |
| nordschleife | ✅ | — | — |
| nurburgring | ✅ | — | — |
| oulton-park | ✅ | — | — |
| paul-ricard | ✅ | — | — |
| silverstone | ✅ | — | — |
| snetterton | ✅ | — | — |
| spa | ✅ | — | — |
| spielberg | ✅ | — | — |
| suzuka | ✅ | — | — |
| valencia | ✅ | — | — |
| watkins-glen | ✅ | — | — |
| zandvoort | ✅ | — | — |
| zolder | ✅ | — | — |

#### AC Evo (ac-evo)

20/20 (100%) curated · 0/20 (0%) meta-verified · 0/20 (0%) segments-verified

| Track | Curated roster | Meta verified | Segments verified |
|-------|----------------|---------------|-------------------|
| austin | ✅ | — | — |
| brands-hatch | ✅ | — | — |
| brands-hatch-indy | ✅ | — | — |
| donington | ✅ | — | — |
| fuji | ✅ | — | — |
| imola | ✅ | — | — |
| kyalami | ✅ | — | — |
| laguna-seca | ✅ | — | — |
| monza | ✅ | — | — |
| mount-panorama | ✅ | — | — |
| nordschleife | ✅ | — | — |
| nurburgring | ✅ | — | — |
| oulton-park | ✅ | — | — |
| paul-ricard | ✅ | — | — |
| road-atlanta | ✅ | — | — |
| sebring | ✅ | — | — |
| spa | ✅ | — | — |
| spielberg | ✅ | — | — |
| suzuka | ✅ | — | — |
| watkins-glen | ✅ | — | — |
<!-- track-detail:end -->

### Signing off

```bash
bun run tracks:coverage --verify meta:suzuka --by "official circuit map"
bun run tracks:coverage --verify segments:f1-2025/spa --by "svg render vs circuit map"
bun run tracks:coverage --write
```

1. Check the roster against a real turn-by-turn guide, or check the committed render at `test/e2e/output/track-segments/<slug>-<gameId>.svg` against a circuit map.
2. Run `--verify` for that file, with what you checked it against.
3. Run `--write` to refresh the table.
4. Say the same thing in the PR ("official Suzuka circuit map", "IMSA 17-turn numbering") — that sentence is the evidence.

Rules:

- **Only a human verifies.** Nothing in the generation pipeline stamps the ledger. Claude proposes; the user confirms what they actually looked at.
- **Signatures pin a content hash.** Edit a signed file and its entry goes stale — it drops out of the verified count and shows as `+N stale` until someone looks again.
- **You cannot verify what was never curated.** Tests assert verified never exceeds curated.
- **Low numbers are honest.** Not a metric to farm.

## Where effort belongs

Getting curated geometry and rosters *accurate*, against real turn-by-turn guides, per track. Not endlessly tuning the generator.

If a track looks wrong in the app: fix that track's curated data.

## Source of truth

| Concern | File |
|---------|------|
| Fallback detection + generation | `shared/track-segment-generate.ts` |
| Coverage stats | `shared/track-coverage.ts` |
| Verification ledger | `shared/track-verified.ts` → `shared/tracks/verified.json` |
| CLI | `scripts/track-coverage.ts` |
| Guards | `test/track-coverage.test.ts`, `test/helpers/track-known-gaps.ts` |

`test/track-coverage.test.ts` fails if the committed table drifts from the repo, so none of this can silently rot.
