# Local AMS2 car thumbnails

The car catalogue optionally loads one WebP thumbnail per car from `cars/<catalogue-car-id>.webp` in this directory. The numeric ID comes from `packages/game-ams2-metadata/src/cars.json`.

Extracted game images stay local and are ignored by Git. Missing images leave the existing text-only card intact. Images are served through `/api/ams2-assets/cars/<id>`; arbitrary file paths are rejected.

Development reads this directory directly. Production builds copy these local files to `dist/data/games/ams2/cars/` using the existing asset-copy step. Rebuild the application to include the route in an older executable. Keep the original game files untouched.
