# iRacing catalogs

## Cars

`cars.csv` is an offline, minimal projection of an iRacing
`/data/car/get` response. RaceIQ never asks users for iRacing credentials and
does not call the Data API at runtime. The catalogue's car images are committed
under `client/public/iracing-car-images`, so installed builds do not require
iRacing or runtime access to iRacing's static CDN.

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
already-complete `client/public/iracing-car-images` directory.

The default public snapshot comes from the MIT-licensed
[`jasondilworth56/iracingdataapi`](https://github.com/jasondilworth56/iracingdataapi)
test fixtures. The generator retains the car identity, category, and source
image location needed to produce the committed catalogue, and excludes rows
where the API sets `retired: true`. The car images themselves are downloaded
from iRacing's public static image host.

## Tracks

`tracks.csv` follows the same offline catalog pattern and uses iRacing's native
configuration-level `track_id` values. It also retains each layout's public
`active.svg` map URL. Exact layout matches use `commonTrackName` to connect to
RaceIQ's existing centerlines, sectors, and named-corner data.

Refresh it from the public track and track-assets test snapshots:

```powershell
bun run iracing:tracks:seed
```

Or seed from locally exported `/data/track/get` and `/data/track/assets`
responses:

```powershell
bun run iracing:tracks:seed -- --tracks-source C:\path\to\get_tracks.json --assets-source C:\path\to\get_tracks_assets.json
```

The public SVG URLs do not require an iRacing login. RaceIQ uses them as static
maps for layouts without a compatible shared centerline; it does not treat an
SVG track ribbon as world-coordinate telemetry geometry.
