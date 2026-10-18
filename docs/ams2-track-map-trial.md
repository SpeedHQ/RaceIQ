# AMS2 original road-corridor maps

## Shared names

AMS2's exact `BrandsHatch - BrandsHatch_Indy` identity links to the existing
`brands-hatch-indy` shared facts and displays as `Brands Hatch Indy` in the
AMS2 adapter and track catalog. The discovered telemetry name and ID remain
unchanged for recording and boundary lookup. No other game's SVG, geometry,
sector fractions or metadata is changed or substituted. Cordoba has no existing
shared entry in this checkout and retains its native display name.

The bundle contains 235 layouts found in the installed physics archives,
including installed DLC and mod layouts. A bundled layout is not a claim
that it is official content or that it has been driven and visually verified.
The initial validated telemetry identity is `BrandsHatch - BrandsHatch_Indy`
(ordinal `165370945`).

## Layout lookup

The loader uses the layout portion after the final ` - ` in the discovered
telemetry track name, or the entire name when there is no separator. It matches
an archive layout exactly, ignoring case only. It does not strip punctuation,
guess aliases, match partial names or select tracks by similar lengths.
Explicit full-name aliases can be added when a recording verifies them.
Duplicate matches are refused. When live telemetry has supplied a track length,
it must agree within 1% of the AIW lap length. Persisted discovered names can
load geometry after restart before a live length is available.

Unknown names and length mismatches return no bundled map. Missing names are
not cached, so lookup can succeed once the identity is discovered. An untested
game variation whose telemetry name differs from its archive name will need
an evidence-backed alias later, rather than a guess now.

The bundled `packages/game-ams2/assets/tracks/brandshatch-indy-boundaries.json`
contains 379 original paired AIW road-edge points and reference-path points.
Coordinates are native world X/Z in metres, matching normalized AMS2 telemetry.
They have not been smoothed, translated, mirrored or fitted to a driven lap.
These road offsets are visual references, not authoritative track limits.
Pit-lane geometry is unavailable and remains null.

The bundle was regenerated from the installed physics archives with the private
extraction tool, retaining native X/Z and original AIW road offsets. Every map
records the source archive and AIW SHA-256. `tracks/catalog.json` lists layout,
filename and native length. The pre-existing Indy geometry was checked for
exact equality before its metadata was updated.
No extraction tool, game archive or experimental cosmetic correction is included.
The existing production build copies game-owned assets into its data directory.

Validation against `test/artifacts/sessions/ams2-race-pit-stop.bin.gz` selected
4,225 active non-pit driving samples. With no fitted coordinate transform,
95.2426% were within the road corridor plus one metre; the 95th percentile
outside distance was 0.3927 metres. This checks native alignment, not official
lap validity or accuracy at every location.

## Manual check

Stop any RaceIQ executable running from this checkout before building.
From the AMS2 review project, run `bun run build`, then `./dist/raceiq.exe`.
Open a saved Brands Hatch Indy AMS2 lap in Analyse Session and inspect the map.
The driving trace should follow the road corridor without a flipped axis or
shifted origin. Driving outside the corridor can occur in the recording;
do not interpret these edges as lap-validity decisions.

This integration does not add catalog thumbnail SVGs, pit lanes or official
track limits. Brands Hatch Indy has been visually checked in a rebuilt Windows
app: the driven trace follows the road corridor without an obvious shifted
origin or flipped axis. The remaining layouts have automated structural checks
but still need real telemetry identity/alignment confirmation as they are used.
The previous cosmetic correction experiments are not included.

## Verified Cordoba alias

`Cordoba - Cordoba_International` maps to archive layout `Cordoba`, not
`Cordoba_GP`. Three saved sessions supplied 174,416 active non-pit frames.
Comparing every tenth frame (17,442 positions) without fitting coordinates:

| Archive | AIW length | Median path distance | 95th percentile |
| --- | ---: | ---: | ---: |
| Cordoba | 3655.272461 m | 3.21 m | 7.56 m |
| Cordoba_GP | 4055.424805 m | 3.56 m | 53.42 m |
| Cordoba_NATL | 2278.025391 m | 69.71 m | 696.32 m |

The recorded track length was 3655.272705 m. The full-name alias retains the
normal live length check and does not match the same variation under a different
location. In-app visual validation of this alias is pending rebuilding.
