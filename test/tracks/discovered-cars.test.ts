import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/db/index";
import { discoveredCars, sessions, tunes } from "../../server/db/schema";
import {
  getOrCreateDiscoveredCar,
  getDiscoveredCarName,
  listDiscoveredCars,
  reconcileDiscoveredCars,
  DISCOVERED_CAR_ORDINAL_BASE,
} from "../../server/db/discovered-cars";
import { injectDiscoveredAcEvoCars, getAcEvoCarName } from "../../shared/racing/cars/ac-evo"
import { LapDetectorAcEvo } from "../../server/games/ac-evo/lap-detector";
import { CapturingDbAdapter } from "../../server/telemetry/pipeline-ports";
import { EMPTY_LAP_TIMELINE_CONTEXT } from "../../server/lap-detection/types";
import type { TelemetryPacket } from "../../shared/telemetry/types";


// Follows DATA_DIR so this never touches the real dev database — `bun run
// test` isolates DATA_DIR to a throwaway directory (see package.json).

// Games used by non-reconcile tests. reconcileDiscoveredCars() only acts on
// gameId === "ac-evo", so anything that must NOT be reconciled uses a
// different id to stay isolated from that behavior.
const GAME = "__test_discovered_cars__";
const GAME2 = "__test_discovered_cars_2__";

async function cleanup(gameIds: string[]) {
  for (const g of gameIds) {
    await db.delete(discoveredCars).where(eq(discoveredCars.gameId, g)).run();
    await db.delete(sessions).where(eq(sessions.gameId, g)).run();
    await db.delete(tunes).where(eq(tunes.gameId, g)).run();
  }
}

beforeEach(async () => {
  await cleanup([GAME, GAME2, "ac-evo"]);
});

afterEach(async () => {
  await cleanup([GAME, GAME2, "ac-evo"]);
});

describe("getOrCreateDiscoveredCar", () => {
  test("registers a new name with an ordinal >= DISCOVERED_CAR_ORDINAL_BASE", async () => {
    const ordinal = await getOrCreateDiscoveredCar(GAME, "Totally Unknown Car");
    expect(ordinal).toBeGreaterThanOrEqual(DISCOVERED_CAR_ORDINAL_BASE);

    const rows = await listDiscoveredCars(GAME);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Totally Unknown Car");
    expect(rows[0].ordinal).toBe(ordinal);
  });

  test("is idempotent for the same name — returns the same ordinal, no duplicate row", async () => {
    const first = await getOrCreateDiscoveredCar(GAME, "Same Car");
    const second = await getOrCreateDiscoveredCar(GAME, "Same Car");
    expect(second).toBe(first);

    const rows = await listDiscoveredCars(GAME);
    expect(rows).toHaveLength(1);
  });

  test("assigns increasing ordinals to distinct names", async () => {
    const a = await getOrCreateDiscoveredCar(GAME, "Car A");
    const b = await getOrCreateDiscoveredCar(GAME, "Car B");
    expect(b).toBeGreaterThan(a);
  });

  test("concurrent calls for the same brand-new name resolve to one ordinal and one row", async () => {
    const results = await Promise.all([
      getOrCreateDiscoveredCar(GAME, "Race Condition Car"),
      getOrCreateDiscoveredCar(GAME, "Race Condition Car"),
      getOrCreateDiscoveredCar(GAME, "Race Condition Car"),
    ]);
    expect(new Set(results).size).toBe(1);

    const rows = await listDiscoveredCars(GAME);
    expect(rows).toHaveLength(1);
  });

  test("stores the model string when provided", async () => {
    await getOrCreateDiscoveredCar(GAME, "Modeled Car", "modeled_car_slug");
    const rows = await listDiscoveredCars(GAME);
    expect(rows[0].model).toBe("modeled_car_slug");
  });
});

describe("getDiscoveredCarName", () => {
  test("returns the registered name for a known ordinal", async () => {
    const ordinal = await getOrCreateDiscoveredCar(GAME, "Named Car");
    expect(await getDiscoveredCarName(GAME, ordinal)).toBe("Named Car");
  });

  test("returns undefined for an ordinal that was never registered", async () => {
    expect(await getDiscoveredCarName(GAME, 999999)).toBeUndefined();
  });

  test("is scoped by gameId — same ordinal under a different game does not match", async () => {
    const ordinal = await getOrCreateDiscoveredCar(GAME, "Cross Game Car");
    expect(await getDiscoveredCarName(GAME2, ordinal)).toBeUndefined();
  });
});

describe("listDiscoveredCars", () => {
  test("scopes results to the requested gameId", async () => {
    await getOrCreateDiscoveredCar(GAME, "Game1 Car");
    await getOrCreateDiscoveredCar(GAME2, "Game2 Car");

    const game1Rows = await listDiscoveredCars(GAME);
    expect(game1Rows.map((r) => r.name)).toEqual(["Game1 Car"]);

    const game2Rows = await listDiscoveredCars(GAME2);
    expect(game2Rows.map((r) => r.name)).toEqual(["Game2 Car"]);
  });
});

describe("reconcileDiscoveredCars", () => {
  test("promotes a discovered row once its name lands in cars.csv, remaps sessions/tunes, deletes the row", async () => {
    // "Ferrari SF90 Stradale" is CSV id 0 (shared/games/ac-evo/cars.csv).
    const discoveredOrdinal = await getOrCreateDiscoveredCar("ac-evo", "Ferrari SF90 Stradale");
    expect(discoveredOrdinal).toBeGreaterThanOrEqual(DISCOVERED_CAR_ORDINAL_BASE);

    const sessionId = (
      await db
        .insert(sessions)
        .values({ carOrdinal: discoveredOrdinal, trackOrdinal: 1, gameId: "ac-evo" })
        .returning({ id: sessions.id })
    )[0].id;
    const tuneId = (
      await db
        .insert(tunes)
        .values({
          gameId: "ac-evo",
          name: "Discovered Tune",
          author: "test",
          carOrdinal: discoveredOrdinal,
          category: "circuit",
          settings: "{}",
        })
        .returning({ id: tunes.id })
    )[0].id;

    await reconcileDiscoveredCars();

    const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(session?.carOrdinal).toBe(0);

    const tune = await db.select().from(tunes).where(eq(tunes.id, tuneId)).get();
    expect(tune?.carOrdinal).toBe(0);

    const row = await db
      .select()
      .from(discoveredCars)
      .where(and(eq(discoveredCars.gameId, "ac-evo"), eq(discoveredCars.ordinal, discoveredOrdinal)))
      .get();
    expect(row).toBeUndefined();
  });

  test("leaves a discovered row untouched when its name still isn't in cars.csv", async () => {
    const ordinal = await getOrCreateDiscoveredCar(
      "ac-evo",
      "Definitely Not A Real Car __TEST__",
    );

    await reconcileDiscoveredCars();

    const row = await db
      .select()
      .from(discoveredCars)
      .where(and(eq(discoveredCars.gameId, "ac-evo"), eq(discoveredCars.ordinal, ordinal)))
      .get();
    expect(row).toBeDefined();
    expect(row?.name).toBe("Definitely Not A Real Car __TEST__");
  });
});

describe("injectDiscoveredAcEvoCars / getAcEvoCarName", () => {
  test("registered discovered car resolves to its real name instead of the `Car #N` fallback", () => {
    const ordinal = 654321;
    injectDiscoveredAcEvoCars([{ ordinal, name: "Injected Test Car" }]);
    expect(getAcEvoCarName(ordinal)).toBe("Injected Test Car");
  });
});

describe("pipeline: unknown car resolves through LapDetectorAcEvo into discovered_cars", () => {
  test("a packet with CarOrdinal -1 + carModelName registers the car and the session gets the generated ordinal", async () => {
    const capturingDb = new CapturingDbAdapter();
    const detector = new LapDetectorAcEvo({
      db: capturingDb,
      lapTimelineContext: EMPTY_LAP_TIMELINE_CONTEXT,
    });

    const packet: Partial<TelemetryPacket> = {
      gameId: "ac-evo",
      CarOrdinal: -1,
      carModelName: "Pipeline Unknown Car",
      TrackOrdinal: 1,
      DistanceTraveled: 0,
      CurrentLap: 0,
    };

    await detector.feed(packet as TelemetryPacket, 0);

    expect(capturingDb.sessions).toHaveLength(1);
    const resolvedOrdinal = capturingDb.sessions[0].carOrdinal;
    expect(resolvedOrdinal).toBeGreaterThanOrEqual(DISCOVERED_CAR_ORDINAL_BASE);

    expect(await getDiscoveredCarName("ac-evo", resolvedOrdinal)).toBe("Pipeline Unknown Car");
  });
});
