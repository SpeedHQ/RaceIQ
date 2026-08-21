# AC Evo script tools

AC Evo content and recording extractors. Run from repo root or any working directory; paths resolve from script location.

## Prerequisites

- Windows installation of Assetto Corsa EVO with `content.kspkg` available.
- Set `AC_EVO_KSPKG` to `content.kspkg`, or pass a package path where supported. Default discovery checks common Steam locations.
- `--recordings` modes require `.bin` recordings under `test/artifacts/sessions`.
- Bun runtime and repository dependencies installed.

## Commands

| Command | Purpose | Inputs |
| --- | --- | --- |
| `bun run scripts/games/ac-evo/extract-cars.ts [kspkg]` | Reconcile shipped cars and refresh setup ranges | `content.kspkg`; optional package path |
| `bun run scripts/games/ac-evo/extract-cars.ts --recordings` | Report car names found in recordings and append unknown rows | AC Evo `.bin` recordings |
| `bun run scripts/games/ac-evo/extract-tracks.ts [kspkg]` | Reconcile shipped tracks and extract geometry | `content.kspkg`; optional `--no-geometry` |
| `bun run scripts/games/ac-evo/extract-tracks.ts --recordings` | Report track/config identities found in recordings | AC Evo `.bin` or `.bin.gz` recordings |
| `bun run scripts/games/ac-evo/extract-track-geometry.ts` | Extract native centerlines, racelines, boundaries, and missing metadata | Discovered `content.kspkg` |
| `bun run scripts/games/ac-evo/extract-setup-ranges.ts [--kspkg <path>] [--list]` | Rewrite setup range catalog; optionally list cars | `content.kspkg` |

## Outputs

- `shared/games/ac-evo/cars.csv`: appended missing car catalog rows.
- `shared/games/ac-evo/tracks.csv`: appended missing track rows.
- `shared/games/ac-evo/setup-ranges.json`: extracted setup limits.
- `shared/data/tracks/venues/<root>/revisions/<revision-path>/tracks/<layout>/geometry/ac-evo/{centerline.csv,raceline.csv,boundaries.json}`: native geometry; current source uses revision path `current`. Missing facts/segments seed matching layout metadata without clobbering curation.

`extractAcEvoTrackGeometry()` and `runSetupRangesExtraction()` remain importable APIs. Geometry stays in raw package coordinates; render-time track-frame handling remains downstream. Scripts do not migrate telemetry diagnostics or external callers.

Canonical current layout ID remains `<root>/<layout>`; historical ID inserts revision before layout. Extractors resolve asset paths through shared helpers and require `gameId: "ac-evo"`.

## Focused verification

- Run each `--list`/`--recordings` mode against a representative installed package or recording set and inspect stdout/stderr.
- For geometry, verify generated files have matching point counts and expected output directory.
- For setup extraction, verify JSON car keys match `cars.csv` model keys.
