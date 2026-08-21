# Track Curation & Verification

How corner data gets into RaceIQ, which layer wins, and what "verified" means.

Short version: **curated geometry wins over detector output. Curated is not same as correct — verification is separate, human-only claim.**

## The hierarchy

Four layers, highest wins. Each one may be partial; lower layers fill the gaps.

| Rank | Layer | Canonical source | Authored by |
|------|-------|------------------|-------------|
| 1 | **Curated geometry** | layout shard `geometryByGame` | human, per game |
| 2 | **Curated roster** (names, numbers, direction, groups) | layout shard `facts` | human, shared across games |
| 3 | **Detect hints** (nudges for fallback detector) | layout sibling `detect-hints.json` | human |
| 4 | **Fallback detector** | `detectCornerRegions()` in `shared/racing/tracks/curation/segment-align-detect.ts` | code |

### Registry storage and authoring

Venue/revision/layout source beside assets under `shared/data/tracks/venues/` is canonical:

```text
venues/<root-venue>/venue.json
venues/<root-venue>/revisions/<revision-path>/revision.json
venues/<root-venue>/revisions/<revision-path>/tracks/<layout>/metadata.json
```

`current` is source-only default revision. Current canonical layout ID remains
`<root-venue>/<layout>`. Historical IDs are
`<root-venue>/<revision-path>/<layout>`; revision paths may be nested, such as
`historical/2011`. Never put layout before revision or add `current` to ID.
Historical revision documents recreate existing nested venue nodes; current does
not project revision venue node.
Root `venue.json` may also carry normalized general metadata and explicit source provenance; generated SQLite projects it for runtime consumers.

Editors and curation commands update source manifests first, then regenerate
`registry.sqlite` and `registry-report.json`. Never edit generated SQLite rows or
export SQLite into source. Runtime package includes revision imagery, layout
geometry/guides, and root shared geometry. It excludes venue/revision/layout
manifests and layout `detect-hints.json`.

Resolve generated SQLite/report conflicts by merging source manifests, then
regenerate registry.

### Why the roster is shared but geometry is not

Circuit corner names and numbering are properties of circuit. Spa's Eau Rouge is
Eau Rouge in every game, so one layout shard stores roster once in `facts`.
Corner location depends on game centerline, so same shard stores fractional
geometry separately by game in `geometryByGame`.

iRacing is separate: native `SplitTimeInfo.Sectors` is variable-length session
metadata and flows through telemetry as an array. Registry's curated boundaries
serve games without authoritative native sector layouts.

## The fallback detector

`track-segment-generate.ts` infers corner regions from centerline curvature. It exists so a track that nobody has curated still renders something usable. **It will never be 100% accurate**, and it is not supposed to be.

Consequences, all deliberate:

- A detector miss on one track is **not a bug** if that track has accurate curated geometry. Fix the curated data.
- Only touch the detector when it is wrong in a *general* way — a bug affecting every track. Never to chase one slug's alignment. Tuning thresholds to rescue one circuit reliably breaks three others.
- Counting geometry rows as "curation" would read ~100%, because detector generates geometry for nearly every centerline. Hence roster-based coverage below.

### Sanctioned gaps

Accepted detector misses are recorded in `test/support/tracks/known-gaps.ts` —
`KNOWN_ALIGNMENT_GAPS`, `KNOWN_FUZZY_ALIGNMENTS`, `KNOWN_TURN_GAPS`.

These are **shrink-only**: every entry is asserted to *still* be broken, so fixing one forces its deletion. Adding an entry is legitimate when the miss is genuinely a centerline-quality problem, and each entry needs a reason comment. It is not a way to silence a regression in curated data.

Known centerline-quality classes, already understood — don't re-litigate:

- ACC tracks whose "centerline" is still the fastlane racing line (issue #98; fixed per-track by `scripts/games/acc/centerline-from-boundaries.ts`).
- ac-evo centerlines that under-detect individual corners.
- Forza's Nordschleife / Watkins Glen, digitised at a different corner granularity than the shared name list.

## Coverage & verification

Three claims, weakest to strongest. They are tracked separately because each says nothing about the next.

| Claim | Means | Proof |
|-------|-------|-------|
| **Curated roster** | someone hand-authored non-empty corner facts | layout `metadata.json` facts |
| **Facts human-verified** | someone checked roster against real turn-by-turn guide | matching layout-metadata verification record |
| **Geometry human-verified** | someone checked game's rendered geometry | matching layout-metadata verification record |

### Verification records

Sign-offs live in each canonical layout `metadata.json` under `verification`.
Each record identifies kind and optional game ID, then stores content hash, date,
reviewer, and note. Generated `curation_verification` SQLite rows mirror those
records for runtime queries; they are not an authoring surface.

Facts verification hashes normalized roster source. Geometry verification hashes
normalized per-game geometry source. Editing relevant source makes previous
signature **stale**. Stale signatures stop counting and render as `+N stale` until
human review stamps current hash.

Nothing in generation pipeline creates or stamps verification. Records only
arrive from human running `--verify`.


Gap between columns 1 and 3 is whole point. F1 25 is 24/24 curated while geometry remains known-inaccurate—a correct roster says nothing about whether corners landed in right place.

### Summary

Generated — do not hand-edit. This doc is the only place the numbers live; CLAUDE.md carries the rules and points here.

<!-- track-coverage:start -->
| Game | Tracks | Curated roster | Facts human-verified | Geometry human-verified | Not yet curated |
|------|--------|----------------|---------------------|-------------------------|-----------------|
| Forza Motorsport (fm-2023) | 71 | 68/71 (96%) | 0/71 (0%) | 0/71 (0%) | daytona-oval, fujimi-kaido, fujimi-kaido-r |
| F1 25 (f1-2025) | 24 | 24/24 (100%) | 0/24 (0%) | 0/24 (0%) | — |
| ACC (acc) | 25 | 25/25 (100%) | 0/25 (0%) | 0/25 (0%) | — |
| AC Evo (ac-evo) | 20 | 20/20 (100%) | 0/20 (0%) | 0/20 (0%) | — |
| **Total** | **140** | **137/140 (98%)** | **0/140 (0%)** | **0/140 (0%)** | |
<!-- track-coverage:end -->

Both verified columns read 0 on purpose. Sebring and Suzuka were curated carefully
against real guides, but nobody has independently checked and signed current
canonical source. Until someone does, honest number is zero.

### Reading the table

Every cell is `n/total (pct%)`, optionally `+N stale`.

| Column | Counts | Computed from |
|--------|--------|---------------|
| **Tracks** | the denominator — distinct slugs this game ships a centerline for | `listAllCenterlines()` |
| **Curated roster** | slugs with non-empty registry corner rows | `listCuratedSlugs()` |
| **Facts human-verified** | roster rows signed off **and unchanged since** | layout verification hash vs normalized facts |
| **Geometry human-verified** | game's geometry rows signed off and unchanged since | layout verification hash vs normalized geometry |
| **Not yet curated** | the exact uncurated slugs, so the remainder is actionable rather than a number | |
| **`+N stale`** | signed off, then the file changed — signature void, needs a re-look | |

Denominator notes:

- **Tracks is per game, not global.** Same circuit in four games = four rows' worth of work. Totals are a sum of rows, not a count of distinct circuits.
- **Forza slugs are de-ordinalised.** `brands-hatch-860-centerline.csv` → `brands-hatch`, since roster is keyed by slug, not in-game ordinal (`canonicalSlug()`).
- **Curated roster is honest metric.** Counting geometry rows would read ~100% and measure nothing because fallback detector generates one for nearly every centerline.
- Both verified columns use **Tracks** as the denominator, not Curated — so they never flatter themselves by shrinking the base.

Adding a game to `GameId` breaks `GAME_LABELS` on purpose; there is no default row.

### What the numbers mean

Read summary as: rosters are nearly everywhere, almost nothing has been checked against real guide, and **rendered geometry has barely been checked by human at all**. High curated percentage is not quality claim. F1 25 sits at 24/24 curated with geometry known to be misplaced — exactly gap third column exposes.

The uncurated remainder is three Forza fantasy tracks (`daytona-oval`, `fujimi-kaido`, `fujimi-kaido-r`) — no real-world turn-by-turn guide exists for them, so they stay uncurated by choice, not by neglect. They are the reason curated will never read 100%, and that is correct.

Expect the verified columns to climb slowly. That is the design.

Refresh after curating anything:

```bash
bun run tracks:coverage            # print
bun run tracks:coverage --write    # rewrite the summary above + the detail tables below
```

### Per-track detail

Generated — do not hand-edit. `✅` = signed off and unchanged since; `⚠️ stale` = signed off then data changed; `—` = never checked. **Curated roster** is shared across games, so column repeats per game; **Geometry verified** is per game because each title digitises its own centerline.

<!-- track-detail:start -->
#### Forza Motorsport (fm-2023)

68/71 (96%) curated · 0/71 (0%) facts-verified · 0/71 (0%) geometry-verified

| Track | Curated roster | Facts verified | Geometry verified |
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

24/24 (100%) curated · 0/24 (0%) facts-verified · 0/24 (0%) geometry-verified

| Track | Curated roster | Facts verified | Geometry verified |
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

25/25 (100%) curated · 0/25 (0%) facts-verified · 0/25 (0%) geometry-verified

| Track | Curated roster | Facts verified | Geometry verified |
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

20/20 (100%) curated · 0/20 (0%) facts-verified · 0/20 (0%) geometry-verified

| Track | Curated roster | Facts verified | Geometry verified |
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

1. Check roster against real turn-by-turn guide, or check committed render at `test/e2e/output/track-segments/<slug>-<gameId>.svg` against circuit map.
2. Run `--verify` for those source records, with what you checked them against.
3. Run `--write` to refresh table.
4. Say same thing in PR ("official Suzuka circuit map", "IMSA 17-turn numbering") — that sentence is evidence.

Rules:

- **Only a human verifies.** Nothing in generation pipeline stamps verification records. Claude proposes; user confirms what they actually looked at.
- **Signatures pin a content hash.** Edit signed source and its entry goes stale — it drops out of verified count and shows as `+N stale` until someone looks again.
- **You cannot verify what was never curated.** Tests assert verified never exceeds curated.
- **Low numbers are honest.** Not metric to farm.

## Where effort belongs

Getting curated geometry and rosters *accurate*, against real turn-by-turn guides, per track. Not endlessly tuning the generator.

If a track looks wrong in the app: fix that track's curated data.

## Source of truth

| Concern | Source |
|---------|--------|
| Venue identity | `shared/data/tracks/venues/<root-venue>/venue.json` |
| Revision identity | `shared/data/tracks/venues/<root-venue>/revisions/<revision-path>/revision.json` |
| Layout identity, game assignments, facts, per-game geometry, and verification | `shared/data/tracks/venues/<root-venue>/revisions/<revision-path>/tracks/<layout>/metadata.json` |
| Shippable revision imagery | sibling `imagery/` beneath revision directory |
| Layout geometry, authored guide, and source-only detector hints | sibling `geometry/<gameId>/`, `guide.json`, and `detect-hints.json` beneath layout directory |
| Shared ACC geometry | `shared/data/tracks/venues/<root-venue>/geometry/acc/` |
| Generated runtime projection and audit | `shared/data/tracks/registry.sqlite`, `shared/data/tracks/registry-report.json` |
| Runtime registry access | `shared/racing/tracks/registry.ts`, `shared/racing/tracks/storage/meta.ts` |
| Fallback detection + generation | `shared/racing/tracks/curation/segment-align-detect.ts`, `shared/racing/tracks/curation/generate.ts` |
| Coverage stats and verification | `shared/racing/tracks/curation/coverage.ts`, `shared/racing/tracks/curation/verified.ts` |
| CLI | `scripts/tracks/track-coverage.ts` |
| Guards | `test/tracks/track-coverage.test.ts`, `test/support/tracks/known-gaps.ts` |

`test/tracks/track-coverage.test.ts` fails if committed coverage tables drift from repository data.
