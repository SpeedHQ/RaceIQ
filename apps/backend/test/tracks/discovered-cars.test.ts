import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { discoveredCars } from "@raceiq/backend-core/db/schema";
import { registerAcEvoCar, registerDiscoveredCar, listDiscoveredCars, hydrateDiscoveredAcEvoCars } from "@raceiq/backend-core/db/discovered-cars";
import { getAcEvoCarName } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";

const TEST_CAR = "RaceIQ Car Identity Test";

async function cleanup() {
  await db.delete(discoveredCars).where(and(eq(discoveredCars.gameId, "ac-evo"), inArray(discoveredCars.carId, [TEST_CAR, TEST_CAR.toLowerCase()]))).run();
  await db.delete(discoveredCars).where(and(eq(discoveredCars.gameId, "acc"), eq(discoveredCars.name, "ACC Car"))).run();
  await db.delete(discoveredCars).where(and(eq(discoveredCars.gameId, "iracing"), eq(discoveredCars.name, "iRacing Car"))).run();
}

beforeEach(cleanup);
afterEach(cleanup);
describe("AC Evo native car identity", () => {
  test("registers trimmed case-preserving IDs, deduplicates concurrent calls, and hydrates identity", async () => {
    const [first, second, spaced] = await Promise.all([
      registerAcEvoCar(`  ${TEST_CAR}  `, "test-model"),
      registerAcEvoCar(TEST_CAR, "test-model"),
      registerAcEvoCar(` ${TEST_CAR.toLowerCase()} `, "test-model"),
    ]);
    expect(first).toBe(TEST_CAR);
    expect(second).toBe(first);
    expect(spaced).toBe(TEST_CAR.toLowerCase());
    expect(spaced).not.toBe(first);
    let rows = (await listDiscoveredCars("ac-evo")).filter((row) => [TEST_CAR, spaced].includes(row.carId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.model).sort()).toEqual(["test-model", "test-model"]);
    expect(getAcEvoCarName(first)).toBe(first);
    await hydrateDiscoveredAcEvoCars();
    expect(getAcEvoCarName(first)).toBe(first);
    rows = (await listDiscoveredCars("ac-evo")).filter((row) => [TEST_CAR, spaced].includes(row.carId));
    expect(rows.map((row) => row.name).sort()).toEqual([first, spaced].sort());
  });

  test("stores ACC and iRacing numeric protocol IDs as strings", async () => {
    await registerDiscoveredCar("acc", "42", "ACC Car");
    await registerDiscoveredCar("iracing", "73", "iRacing Car");
    const rows = await listDiscoveredCars();
    expect(rows.find((row) => row.gameId === "acc" && row.name === "ACC Car")?.carId).toBe("42");
    expect(rows.find((row) => row.gameId === "iracing" && row.name === "iRacing Car")?.carId).toBe("73");
  });
});
