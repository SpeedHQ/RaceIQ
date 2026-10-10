import { hydrateDiscoveredAcEvoTracks } from "@raceiq/backend-core/db/discovered-tracks";
import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { acEvoTrackSourceKey, getDiscoveredAcEvoTrackSource, getOrCreateDiscoveredTrack, listDiscoveredTracks } from "@raceiq/backend-core/db/discovered-tracks";
import { db } from "@raceiq/backend-core/db/index";
import { discoveredTracks, sessions, tunes, tuneAssignments } from "@raceiq/backend-core/db/schema";
import { getAcEvoTrackByName, getAcEvoTrackName, injectDiscoveredAcEvoTracks } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { acEvoCarSourceKey, getOrCreateDiscoveredCar } from "@raceiq/backend-core/db/discovered-cars";
import { discoveredCars } from "@raceiq/backend-core/db/schema";
import { carRoutes } from "../../src/routes/car-routes";

const TEST_TRACK = "RaceIQ Identity Test Circuit";

afterEach(async () => {
  await db.delete(discoveredTracks).where(and(eq(discoveredTracks.gameId, "ac-evo"), eq(discoveredTracks.name, TEST_TRACK))).run();
});

describe("AC Evo discovered track identity", () => {
  test.each(["new", "persisted"])("imported source names resolve without restart or explicit hydration (%s)", async (state) => {
    const venue = `RaceIQ Immediate Name Circuit ${state}`;
    const car = `RaceIQ Immediate Name Car ${state}`;
    try {
      if (state === "persisted") {
        await db.insert(discoveredTracks).values({
          gameId: "ac-evo", ordinal: 800007, name: venue,
          sourceKey: acEvoTrackSourceKey(venue, "Tourist"), trackName: venue, trackConfiguration: "Tourist",
        }).run();
        await db.insert(discoveredCars).values({
          gameId: "ac-evo", ordinal: 800007, name: car, sourceKey: acEvoCarSourceKey(car),
        }).run();
      }
      const trackOrdinal = await getOrCreateDiscoveredTrack("ac-evo", venue, "Tourist");
      const carOrdinal = await getOrCreateDiscoveredCar("ac-evo", car);
      const response = await carRoutes.request(`/api/resolve-names?gameId=ac-evo&tracks=${trackOrdinal}&cars=${carOrdinal}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        trackNames: { [trackOrdinal]: `${venue} - Tourist` },
        carNames: { [carOrdinal]: car },
      });
    } finally {
      await db.delete(discoveredTracks).where(and(eq(discoveredTracks.gameId, "ac-evo"), eq(discoveredTracks.name, venue))).run();
      await db.delete(discoveredCars).where(and(eq(discoveredCars.gameId, "ac-evo"), eq(discoveredCars.name, car))).run();
    }
  });
  test("allocates distinct concurrent layouts and reuses normalized source keys", async () => {
    const [grandPrix, tourist] = await Promise.all([
      getOrCreateDiscoveredTrack("ac-evo", TEST_TRACK, "Grand Prix"),
      getOrCreateDiscoveredTrack("ac-evo", TEST_TRACK, "Tourist"),
    ]);

    expect(grandPrix).not.toBe(tourist);
    expect(await getOrCreateDiscoveredTrack("ac-evo", ` ${TEST_TRACK.toLowerCase()} `, "grand prix")).toBe(grandPrix);
    const rows = await listDiscoveredTracks("ac-evo");
    expect(rows.some((track) => track.ordinal === grandPrix && track.trackConfiguration === "Grand Prix")).toBe(true);
    expect(rows.some((track) => track.ordinal === tourist && track.trackConfiguration === "Tourist")).toBe(true);
    expect(await getDiscoveredAcEvoTrackSource(grandPrix)).toEqual({ trackName: TEST_TRACK, trackConfiguration: "Grand Prix" });
    await hydrateDiscoveredAcEvoTracks();
    expect(getAcEvoTrackByName(TEST_TRACK, "Grand Prix")?.id).toBe(grandPrix);
    expect(getAcEvoTrackByName(TEST_TRACK, "Tourist")?.id).toBe(tourist);
    expect(getAcEvoTrackByName(TEST_TRACK)).toBeUndefined();
    expect(getAcEvoTrackName(grandPrix)).toBe(`${TEST_TRACK} - Grand Prix`);
  });

  test("does not allocate synthetic track IDs for native-ID games", async () => {
    await expect(getOrCreateDiscoveredTrack("iracing", "Circuit", "Layout")).rejects.toThrow("AC Evo source-identity only");
  });

  test("does not infer exact identity from venue-only discovered rows", async () => {
    const ordinal = 987654321;
    await db.insert(discoveredTracks).values({ gameId: "ac-evo", ordinal, name: TEST_TRACK }).run();
    injectDiscoveredAcEvoTracks(await listDiscoveredTracks("ac-evo"));
    expect(getAcEvoTrackByName(TEST_TRACK)).toBeUndefined();
    expect(await getDiscoveredAcEvoTrackSource(ordinal)).toBeUndefined();
    await db.delete(discoveredTracks).where(eq(discoveredTracks.ordinal, ordinal)).run();
  });

  test("catalog hydration preserves session and tune assignment ordinal identities", async () => {
    const ordinal = await getOrCreateDiscoveredTrack("ac-evo", TEST_TRACK, "Stable Layout");
    const carOrdinal = 700001;
    const sessionId = (await db.insert(sessions).values({
      carOrdinal, trackOrdinal: ordinal, gameId: "ac-evo",
    }).returning({ id: sessions.id }))[0].id;
    const tuneId = (await db.insert(tunes).values({
      gameId: "ac-evo", name: "Identity Test Tune", author: "test", carOrdinal,
      category: "circuit", settings: "{}",
    }).returning({ id: tunes.id }))[0].id;
    await db.insert(tuneAssignments).values({ gameId: "ac-evo", carOrdinal, trackOrdinal: ordinal, tuneId }).run();
    injectDiscoveredAcEvoTracks(await listDiscoveredTracks("ac-evo"));

    expect(getAcEvoTrackByName(TEST_TRACK, "Stable Layout")?.id).toBe(ordinal);
    expect(await getDiscoveredAcEvoTrackSource(ordinal)).toEqual({ trackName: TEST_TRACK, trackConfiguration: "Stable Layout" });
    expect((await db.select().from(sessions).where(eq(sessions.id, sessionId)).get())?.trackOrdinal).toBe(ordinal);
    expect((await db.select().from(tuneAssignments).where(eq(tuneAssignments.tuneId, tuneId)).get())?.trackOrdinal).toBe(ordinal);
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    await db.delete(tuneAssignments).where(eq(tuneAssignments.tuneId, tuneId)).run();
    await db.delete(tunes).where(eq(tunes.id, tuneId)).run();
  });
});
