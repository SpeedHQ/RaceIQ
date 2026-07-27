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
| **Curated roster** | someone hand-authored a non-empty `corners` array | file exists |
| **Meta human-verified** | someone checked that roster against a real turn-by-turn guide | ledger entry |
| **Segments human-verified** | someone checked that game's rendered geometry | ledger entry |

The gap between column 1 and column 3 is the whole point. F1 25 is 24/24 curated and its segments are still known-inaccurate — a correct roster says nothing about whether the corners landed in the right *place*.

The live table lives in `CLAUDE.md` between the `<!-- track-coverage:start -->` markers. Refresh it after curating anything:

```bash
bun run tracks:coverage            # print
bun run tracks:coverage --write    # rewrite the block in CLAUDE.md
```

### Signing off

```bash
bun run tracks:coverage --verify meta:suzuka --by "official circuit map"
bun run tracks:coverage --verify segments:f1-2025/spa --by "svg render vs circuit map"
bun run tracks:coverage --write
```

Easiest way to check segments: the committed render at `test/e2e/output/track-segments/<slug>-<gameId>.svg`.

Rules:

- **Only a human verifies.** Nothing in the generation pipeline stamps the ledger. Claude proposes; the user confirms what they actually looked at.
- **Signatures pin a content hash.** `shared/tracks/verified.json` stores a hash of the file signed. Edit that file and the signature goes **stale** — it drops out of the verified count and shows as `+N stale` until someone looks again.
- **You cannot verify what was never curated.** Tests assert `metaVerified <= curated`.
- **Low numbers are honest.** Not a metric to farm.

Ledger shape:

```json
{
  "meta":     { "suzuka": { "hash": "95778f6106d2", "date": "2026-07-27", "by": "official circuit map" } },
  "segments": { "f1-2025": { "spa": { "hash": "…", "date": "…", "by": "…" } } }
}
```

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
