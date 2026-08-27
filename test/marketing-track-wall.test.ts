import { expect, test } from "bun:test";
import { KNOWN_GAME_IDS } from "../shared/games/ids";
import { fmTrackCatalog } from "../shared/racing/tracks/catalogs/fm";
import { getF1Tracks } from "../shared/racing/tracks/catalogs/f1";
import { getAccTracks } from "../shared/racing/tracks/catalogs/acc";
import { getAcEvoTracks } from "../shared/racing/tracks/catalogs/ac-evo";
import { getAllIRacingTracks } from "../shared/racing/tracks/catalogs/iracing";
import { buildMarketingTrackWallFixture } from "../scripts/marketing/track-wall-data";

const fixture = buildMarketingTrackWallFixture();
const expectedCounts = [fmTrackCatalog.size, getF1Tracks().size, getAccTracks().size, getAcEvoTracks().size, getAllIRacingTracks().length];

test("matches authoritative catalog membership and counts", () => {
  expect(fixture.games.map((game) => game.gameId)).toEqual([...KNOWN_GAME_IDS]);
  expect(fixture.games.map((game) => game.count)).toEqual(expectedCounts);
  expect(fixture.tracks).toHaveLength(expectedCounts.reduce((sum, count) => sum + count, 0));
  expect(new Set(fixture.tracks.map((track) => track.key)).size).toBe(fixture.tracks.length);
});

test("is byte-equivalent and uses the declared synthetic count formula", () => {
  expect(JSON.stringify(buildMarketingTrackWallFixture())).toBe(JSON.stringify(fixture));
  for (const track of fixture.tracks) {
    expect(track.lapCount).toBeGreaterThanOrEqual(3);
    expect(track.lapCount).toBeLessThanOrEqual(148);
    expect(track.setupCount).toBeGreaterThanOrEqual(0);
    expect(track.setupCount).toBeLessThanOrEqual(12);
    expect(track.mapKind === "none").toBe(track.mapSrc === null);
  }
});

test("weaves every normalized catalog row exactly once", () => {
  const keys = fixture.tracks.map((track) => track.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const gameId of KNOWN_GAME_IDS) {
    expect(keys.filter((key) => key.startsWith(`${gameId}:`))).toHaveLength(fixture.games.find((game) => game.gameId === gameId)?.count ?? 0);
  }
});
