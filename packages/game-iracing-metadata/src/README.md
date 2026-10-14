# iRacing catalogs

## Cars

`cars.csv` is an offline projection of an iRacing `/data/car/get` response,
including abbreviated names, horsepower, weight, capabilities, and search terms.
RaceIQ never asks users for iRacing credentials and
does not call the Data API at runtime. The catalogue's car images are committed
under `packages/game-iracing/assets/public/iracing-car-images`, so installed builds
do not require iRacing or runtime access to iRacing's static CDN.

Refresh the catalogue and its bundled images from the current public test
snapshot:

```powershell
bun run iracing:cars:seed
```

Or seed from a `/data/car/get` JSON file exported locally:

```powershell
bun run iracing:cars:seed -- --source C:\path\to\get_cars.json
```

Use `--skip-images` only when refreshing catalogue metadata while retaining an
already-complete `packages/game-iracing/assets/public/iracing-car-images` directory.

The default public snapshot comes from the MIT-licensed
[`jasondilworth56/iracingdataapi`](https://github.com/jasondilworth56/iracingdataapi)
test fixtures. The generator retains car identity, category, specifications,
capabilities, search terms, and source image locations, and excludes rows
where the API sets `retired: true`. The car images themselves are downloaded
from iRacing's public static image host.

## Car classes

`car-classes.csv` retains official class names and many-to-many car memberships.
Session parsing uses it when live session metadata omits the class display name.
Refresh it from an exported `/data/carclass/get` response:

```powershell
bun run iracing:car-classes:seed -- --source C:\path\to\get_car_classes.json
```

## Tracks

`tracks.csv` follows same offline catalog pattern and uses iRacing's native
configuration-level `track_id` values. It retains each layout's official map URL
as source metadata. Exact layout matches use `commonTrackName` to connect to
RaceIQ's existing centerlines, sectors, and named-corner data.
The catalog also retains corner count, pit-road speed, pit stalls, maximum field
size, night/rain capabilities, coordinates, time zone, and official SVG layers.

Refresh it from the public track and track-assets test snapshots:

```powershell
bun run iracing:tracks:seed
```

Or seed from locally exported `/data/track/get` and `/data/track/assets`
responses:

```powershell
bun run iracing:tracks:seed -- --tracks-source C:\path\to\get_tracks.json --assets-source C:\path\to\get_tracks_assets.json
```

The official SVG maps are bundled under
`packages/game-iracing/assets/iracing-track-maps` and served from RaceIQ's
same-origin asset route. Layouts without compatible shared centerlines therefore
do not depend on browser access to iRacing's static CDN. The map URLs in
`tracks.csv` remain source references; runtime responses use bundled asset paths.

Parsed centerlines, turn labels, pit-road lines, and merge lines are bundled in
`packages/game-iracing-metadata/src/track-maps`. Runtime prefers these versioned
JSON files before network fetches and upgrades incomplete caches. Refresh them:

```powershell
bun run iracing:track-maps:seed
```

Use `--reuse-maps` to retain complete version-matched output files, or
`--source-cache <directory>` to reuse complete runtime cache files.
