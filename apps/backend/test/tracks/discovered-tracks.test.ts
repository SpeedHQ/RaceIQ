import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { discoveredTracks, discoveredCars, sessions, tunes, tuneAssignments } from "@raceiq/backend-core/db/schema";
import { registerAcEvoTrack, registerDiscoveredTrack, listDiscoveredTracks, hydrateDiscoveredAcEvoTracks } from "@raceiq/backend-core/db/discovered-tracks";
import { registerAcEvoCar, registerDiscoveredCar } from "@raceiq/backend-core/db/discovered-cars";
import { getAcEvoTrackByName, getAcEvoTrackName } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";

const TEST_TRACK = "RaceIQ Identity Test Circuit";
const TEST_CAR = "RaceIQ Track Persistence Test Car";
const TEST_LAYOUT = "Stable Layout";

afterEach(async () => {
  await db.delete(discoveredTracks).where(and(eq(discoveredTracks.gameId, "ac-evo"), eq(discoveredTracks.trackName, TEST_TRACK))).run();
  await db.delete(discoveredCars).where(and(eq(discoveredCars.gameId, "ac-evo"), eq(discoveredCars.carId, TEST_CAR))).run();
  await db.delete(sessions).where(and(eq(sessions.gameId, "ac-evo"), eq(sessions.trackId, JSON.stringify([TEST_TRACK, TEST_LAYOUT])))).run();
  await db.delete(tuneAssignments).where(and(eq(tuneAssignments.gameId, "ac-evo"), eq(tuneAssignments.carId, TEST_CAR))).run();
  await db.delete(tunes).where(and(eq(tunes.gameId, "ac-evo"), eq(tunes.carId, TEST_CAR))).run();
  await db.delete(discoveredTracks).where(and(eq(discoveredTracks.gameId, "acc"), eq(discoveredTracks.name, "ACC Circuit"))).run();
  await db.delete(discoveredTracks).where(and(eq(discoveredTracks.gameId, "iracing"), eq(discoveredTracks.name, "iRacing Circuit"))).run();
});

describe("AC Evo native track identity", () => {
  test("registers trimmed case-preserving layout IDs, deduplicates concurrency, and distinguishes layouts", async () => {
    const [grandPrix, sameGrandPrix, tourist] = await Promise.all([
      registerAcEvoTrack(`  ${TEST_TRACK}  `, "  Grand Prix  "),
      registerAcEvoTrack(TEST_TRACK, "Grand Prix"),
      registerAcEvoTrack(TEST_TRACK, "Tourist"),
    ]);
    expect(grandPrix).toBe(JSON.stringify([TEST_TRACK, "Grand Prix"]));
    expect(sameGrandPrix).toBe(grandPrix);
    expect(tourist).toBe(JSON.stringify([TEST_TRACK, "Tourist"]));
    expect(tourist).not.toBe(grandPrix);
    const rows = (await listDiscoveredTracks("ac-evo")).filter((row) => [grandPrix, tourist].includes(row.trackId));
    expect(rows).toHaveLength(2);
    await hydrateDiscoveredAcEvoTracks();
    expect(getAcEvoTrackByName(TEST_TRACK, "Grand Prix")?.id).toBe(grandPrix);
    expect(getAcEvoTrackByName(TEST_TRACK, "Tourist")?.id).toBe(tourist);
    expect(getAcEvoTrackName(grandPrix)).toBe(`${TEST_TRACK} - Grand Prix`);
  });

  test("native identity persists in session and tune assignment", async () => {
    const trackId = await registerAcEvoTrack(TEST_TRACK, TEST_LAYOUT);
    const carId = await registerAcEvoCar(TEST_CAR);
    const sessionId = (await db.insert(sessions).values({
      gameId: "ac-evo", carId, trackId,
    }).returning({ id: sessions.id }))[0].id;
    const tuneId = (await db.insert(tunes).values({
      gameId: "ac-evo", name: "Native identity tune", author: "test",
      carId, trackId, category: "circuit", settings: "{}",
    }).returning({ id: tunes.id }))[0].id;
    await db.insert(tuneAssignments).values({
      gameId: "ac-evo", carId, trackId, tuneId,
    }).run();
    await hydrateDiscoveredAcEvoTracks();
    const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(session?.carId).toBe(carId);
    expect(session?.trackId).toBe(trackId);
    const assignment = await db.select().from(tuneAssignments).where(eq(tuneAssignments.tuneId, tuneId)).get();
    expect(assignment?.trackId).toBe(trackId);
    expect(assignment?.carId).toBe(carId);
  });
});

describe("string track IDs for other games", () => {
  test("stores ACC and iRacing numeric protocol IDs as strings", async () => {
    await registerDiscoveredTrack("acc", "42", "ACC Circuit");
    await registerDiscoveredTrack("iracing", "73", "iRacing Circuit");
    const rows = await listDiscoveredTracks();
    expect(rows.find((row) => row.gameId === "acc" && row.name === "ACC Circuit")?.trackId).toBe("42");
    expect(rows.find((row) => row.gameId === "iracing" && row.name === "iRacing Circuit")?.trackId).toBe("73");
  });
});
