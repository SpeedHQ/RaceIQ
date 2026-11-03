# AMS2 catalog

The catalog supplies choices before live capture: 260 distinct car names from
262 server vehicle records, 222 layouts, 139 exact geometry matches, and 36
reviewed common circuit mappings. The other 83 layouts retain unavailable
geometry. Existing captured IDs and world coordinates are preserved.

## Source and coverage

The factual inventory comes from https://github.com/enum-gg/ams2-server-docs
at revision `486d83d0bb5c4183d18000d619f25952063006cb`.
`catalog-source.json` records the pinned input URLs, SHA-256 hashes and counts.
It is not a claim to cover the latest installed game, every DLC, or mods.
No Gonky Racing maps or implementation were copied.

Ligier JS P217 and Oreca 07 each occur in two server classes. Their class and
server-ID lists are retained under the existing name-based recording identity.
No car images, dimensions, power figures or corner fractions are invented.
Historical layouts do not inherit modern circuit facts by default. A common
mapping enables resources that exist; it does not guarantee an expert guide
or curated AMS2 named segments.

## Identity and import behavior

`identity.ts` preserves the existing UTF-8 FNV-derived telemetry-name hash:
Volkswagen Polo is `325487790`, Porsche 911 GT3 R is `854916192`, and
`BrandsHatch - BrandsHatch_Indy` is `165370945`. These identities are verified
by the four committed raw AMS2 fixtures.

Server inventory contains variation names, not every full telemetry location
and variation pair. Unobserved track rows use server IDs. Observed full names
resolve by exact variation, while the recorded RaceIQ ID remains the visible
row. Imports now persist discovered names, so lookup survives restart without
rewriting session IDs or adding a database migration. Unknown names remain
unmapped. Observed telemetry wins if a server ID collides with a recording ID.

Native telemetry length takes precedence over reference geometry length.
Recorded outlines remain preferred; matched native AMS2 centerlines provide
the fallback. Other games' geometry is not substituted. Cordoba International
uses its explicitly reviewed standard archive alias, never the GP archive.

## Offline regeneration

`catalog-overrides.json` holds reviewed display names, common circuit slugs,
known full telemetry names and exceptional geometry aliases.
The converter accepts a directory containing `vehicles.json`, `tracks.json`,
`vehicle_classes.json`, and `sources.json`. The latter records a pinned revision
and the input filenames and SHA-256 hashes, shaped like `catalog-source.json`.
Obtain and review an updated inventory before regenerating.

From the repository root:

```powershell
bun packages/tooling-catalog/src/catalog/import-ams2-inventory.ts <snapshot-directory>
```

The converter checks input hashes, duplicate IDs, ambiguous geometry and common
metadata files. It writes `cars.json`, `tracks.json`, `tracks.csv`, and
`catalog-source.json`. CSV is the reviewable mirror; JSON is bundled for
browser-safe runtime lookup. Runtime does not fetch or update catalogs.

## Validation and manual build

Focused checks cover conversion, identity repair, import persistence across a
fresh process, all 235 existing geometry assets and the real AMS2 fixtures.
Browser checks use a disposable seed profile and separate ports. They do not
alter racing data or establish compiled packaging or live acquisition behavior.

Close RaceIQ before rebuilding, then run from the repository root:

```powershell
bun run build
```

Expect successful tasks and `dist/raceiq.exe`. Use the existing AMS2 shortcut
to preserve the AMS2 profile selection. Check Cars and Tracks, then open a
known AMS2 replay: its identity and matched native edges should resolve.
Unverified layouts may still lack maps or curated corner segments.
