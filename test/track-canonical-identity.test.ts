import { expect, test } from "bun:test";
import type { GameId } from "../shared/games/ids";
import { getAcEvoTracks } from "../shared/racing/tracks/catalogs/ac-evo";
import { getAccTracks } from "../shared/racing/tracks/catalogs/acc";
import { getF1Tracks } from "../shared/racing/tracks/catalogs/f1";
import { fmTrackCatalog } from "../shared/racing/tracks/catalogs/fm";
import { getAllIRacingTracks } from "../shared/racing/tracks/catalogs/iracing";
import { trackConfigurationCanonicalId } from "../shared/racing/tracks/configuration";
import { resolveTrackSegments } from "../server/routes/tracks/support";
import { listCanonicalTrackPeers, listTrackConfigurations, loadTrackConfiguration } from "../server/tracks/configuration";
import { resolveTrackGeographicCatalogSource } from "../server/tracks/geographic-reference";
import { resolveTrackSharedName } from "../server/tracks/identity";
import { resolveTrack } from "../server/tracks/info";

test("shares exact-layout identity from F1 Spa to iRacing Spa", () => {
  const f1 = loadTrackConfiguration("f1-2025", 10);
  const iracing = loadTrackConfiguration("iracing", 523);
  expect(f1).not.toBeNull();
  expect(iracing).not.toBeNull();
  expect(trackConfigurationCanonicalId(f1!)).toBe("circuit-de-spa-francorchamps/grand-prix");
  expect(trackConfigurationCanonicalId(iracing!)).toBe(trackConfigurationCanonicalId(f1!));
  expect(listCanonicalTrackPeers("f1-2025", 10)).toContainEqual(iracing!);

  const geographic = resolveTrackGeographicCatalogSource("f1-2025", 10);
  expect(geographic).toMatchObject({ match: "assigned-identity", track: { ordinal: 523, latitude: 50.4369118, longitude: 5.969856 } });
});

test("inherits shared facts and game-specific geometry through exact-layout identity", async () => {
  expect(resolveTrackSharedName(10, "f1-2025")).toBe("spa");
  expect(resolveTrackSharedName(523, "iracing")).toBe("spa");

  const f1 = resolveTrack("f1-2025", 10);
  const iracing = resolveTrack("iracing", 523);
  expect(f1.facts).toEqual(iracing.facts);
  expect(f1.facts?.corners.find((corner) => corner.number === 3)?.name).toBe("Eau Rouge");

  const f1Segments = await resolveTrackSegments(10, "f1-2025");
  const iracingSegments = await resolveTrackSegments(523, "iracing");
  expect(f1Segments.segments.filter((segment) => segment.type === "corner").map((segment) => segment.name)).toEqual(
    iracingSegments.segments.filter((segment) => segment.type === "corner").map((segment) => segment.name),
  );
  expect(f1Segments.segments.find((segment) => segment.name === "Blanchimont")).toBeDefined();
});

test("assigns every bundled simulator track to a canonical identity", () => {
  const catalogOrdinals: Record<GameId, number[]> = {
    "fm-2023": [...fmTrackCatalog.keys()],
    "f1-2025": [...getF1Tracks().keys()],
    acc: [...getAccTracks().keys()],
    "ac-evo": [...getAcEvoTracks().keys()],
    iracing: getAllIRacingTracks().map((track) => track.ordinal),
  };
  const expectedKeys = new Set(Object.entries(catalogOrdinals).flatMap(([gameId, ordinals]) => ordinals.map((ordinal) => `${gameId}:${ordinal}`)));
  const configurations = listTrackConfigurations();

  expect(new Set(configurations.map((configuration) => `${configuration.gameId}:${configuration.trackOrdinal}`))).toEqual(expectedKeys);
  for (const [gameId, ordinals] of Object.entries(catalogOrdinals) as [GameId, number[]][]) {
    for (const ordinal of ordinals) {
      expect(loadTrackConfiguration(gameId, ordinal)).not.toBeNull();
    }
  }
});
