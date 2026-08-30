# iRacing scripts

Domain tooling for inspecting IBT recordings, rebuilding committed fixtures, and seeding shared iRacing car/track catalogs.

## Commands

| Entrypoint | Purpose | Input/output |
| --- | --- | --- |
| `bun scripts/iracing/probe-ibt.ts <recording.ibt>` | Summarize IBT metadata and normalized stream health | Reads IBT; writes JSON to stdout |
| `bun scripts/iracing/seed-cars.ts` | Seed car catalog and bundled car images | Reads JSON source; writes `shared/games/iracing/cars.csv` and `client/public/iracing-car-images/` |
| `bun scripts/iracing/seed-tracks.ts` | Seed track layout catalog | Reads track and asset JSON sources; writes `shared/games/iracing/tracks.csv` |
| `bun scripts/iracing/seed-track-maps.ts` | Seed bundled official track maps | Downloads official SVG layers; writes parsed JSON to `shared/games/iracing/track-maps/` |
| `bun scripts/iracing/generate-recording-fixture.ts` | Rebuild deterministic recorder fixture | Writes `test/artifacts/sessions/iracing-road-america-gt3.bin.gz` |
| `bun scripts/iracing/generate-seed-fixture.ts <recording.ibt>` | Build native-rate Daytona pit-stop seed fixture | Reads IBT; writes `test/artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz` |

## Seeder options

`seed-cars.ts` uses default source `get_cars.json`. Options:

- `--source <url-or-file>`: JSON source URL or local path.
- `--output <file>`: CSV destination.
- `--images-output <directory>`: bundled image destination.
- `--include-retired`: retain retired cars.
- `--skip-images`: keep existing bundled images.

`seed-tracks.ts` uses default `get_tracks.json` and `get_tracks_assets.json`. Options:

- `--tracks-source <url-or-file>`: track JSON source.
- `--assets-source <url-or-file>`: track-assets JSON source.
- `--source <url-or-file>`: compatibility alias for `--tracks-source`.
- `--output <file>`: CSV destination.
- `--include-retired`: retain retired layouts.

`seed-track-maps.ts` reads the committed track catalog. Options:

- `--output <directory>`: bundled map destination.
- `--source-cache <directory>`: reuse complete version-matched runtime cache files before downloading.
- `--reuse-maps`: reuse complete version-matched files already in the output directory.

Catalog seeders accept HTTP(S) URLs or local JSON files. URL headers and error messages remain domain-specific. CSV quoting and option lookup come from `scripts/lib`.

## Boundaries and verification

These scripts own iRacing source parsing, fixture generation, and catalog serialization. Runtime telemetry ingestion, catalog capture, and external command callers remain outside this directory.

Focused checks: run each command with `--help`-equivalent missing/invalid input paths as applicable, seed against a local JSON fixture with `--skip-images`, and inspect generated CSV/fixture paths. Full repository validation belongs to project-level CI.
