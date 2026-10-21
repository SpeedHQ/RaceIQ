import { resolve } from "node:path";
import { accAdapter } from "@raceiq/game-acc-metadata/index";
import { acEvoAdapter } from "@raceiq/game-ac-evo-metadata/index";
import { f1Adapter } from "@raceiq/game-f1-2025-metadata/index";
import { forzaAdapter } from "@raceiq/game-fm-2023-metadata/index";
import { iracingAdapter } from "@raceiq/game-iracing-metadata/index";
import { lmuAdapter } from "@raceiq/game-lmu-metadata/index";
import { getAllAccCars, getAccCarName } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccTracks, getAccTrackName } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import { getAllAcEvoCars, getAcEvoCarName } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";
import { getAcEvoTracks, getAcEvoTrackName } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { getAllF1Cars, getF1CarName } from "@raceiq/game-f1-2025-metadata/racing/cars/f1";
import { getF1Tracks, getF1TrackName } from "@raceiq/game-f1-2025-metadata/racing/tracks/catalogs/f1";
import { fmCarCatalog, getFmCarName } from "@raceiq/game-fm-2023-metadata/racing/cars/fm";
import { fmTrackCatalog, getFmTrackName } from "@raceiq/game-fm-2023-metadata/racing/tracks/catalogs/fm";
import { getAllIRacingCars } from "@raceiq/game-iracing-metadata/racing/cars/iracing";
import { getAllIRacingTracks, getIRacingTrackName } from "@raceiq/game-iracing-metadata/racing/tracks/catalogs/iracing";
import { lmuCarCatalog, lmuTrackCatalog } from "@raceiq/game-lmu-metadata/catalog";

// Run from the desktop workspace against its authoritative native-ID catalogues.
// The resulting data is vendored by cloud; neither runtime imports the other repo.
function names(entries: Iterable<readonly [string, string]>): Record<string, string> {
  const labels = new Map<string, string>();
  for (const [id, label] of entries) {
    if (!id.trim() || !label.trim()) throw new Error("Empty canonical metadata identity or label");
    const previous = labels.get(id);
    if (previous !== undefined && previous !== label) throw new Error(`Conflicting canonical label for ${id}`);
    labels.set(id, label);
  }
  return Object.fromEntries([...labels].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: bun packages/game-catalogs/scripts/export-online-metadata.ts <output-json-path>");

const games = {
  "ac-evo": {
    displayName: acEvoAdapter.displayName,
    cars: names(getAllAcEvoCars().map((car) => [car.id, getAcEvoCarName(car.id)] as const)),
    tracks: names([...getAcEvoTracks().keys()].map((id) => [id, getAcEvoTrackName(id)] as const)),
  },
  acc: {
    displayName: accAdapter.displayName,
    cars: names(getAllAccCars().map((car) => [String(car.id), getAccCarName(car.id)] as const)),
    tracks: names([...getAccTracks().keys()].map((id) => [String(id), getAccTrackName(id)] as const)),
  },
  "f1-2025": {
    displayName: f1Adapter.displayName,
    cars: names(getAllF1Cars().map((car) => [car.id, getF1CarName(Number(car.id))] as const)),
    tracks: names([...getF1Tracks().keys()].map((id) => [String(id), getF1TrackName(id)] as const)),
  },
  "fm-2023": {
    displayName: forzaAdapter.displayName,
    cars: names([...fmCarCatalog.keys()].map((id) => [String(id), getFmCarName(id)] as const)),
    tracks: names([...fmTrackCatalog.keys()].map((id) => [String(id), getFmTrackName(id)] as const)),
  },
  iracing: {
    displayName: iracingAdapter.displayName,
    cars: names(getAllIRacingCars().map((car) => [String(car.ordinal), car.name] as const)),
    tracks: names(getAllIRacingTracks().map((track) => [String(track.ordinal), getIRacingTrackName(track.ordinal)] as const)),
  },
  lmu: {
    displayName: lmuAdapter.displayName,
    cars: names(lmuCarCatalog.map((car) => [car.id, car.name] as const)),
    tracks: names(lmuTrackCatalog.map((track) => [track.id, track.name] as const)),
  },
};

await Bun.write(resolve(outputPath), `${JSON.stringify({ schemaVersion: 1, games }, null, 2)}\n`);
console.log(JSON.stringify({ outputPath: resolve(outputPath), games: Object.fromEntries(
  Object.entries(games).map(([gameId, game]) => [gameId, {
    cars: Object.keys(game.cars).length, tracks: Object.keys(game.tracks).length,
  }]),
) }));
