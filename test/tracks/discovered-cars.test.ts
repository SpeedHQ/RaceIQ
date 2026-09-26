import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../server/db/index";
import { discoveredCars } from "../../server/db/schema";
import { getDiscoveredCarName, listDiscoveredCars, registerDiscoveredCar } from "../../server/db/discovered-cars";

const GAME = "__test_native_discovered_cars__";
const OTHER_GAME = "__test_native_discovered_cars_other__";

async function cleanup(): Promise<void> {
  await db.delete(discoveredCars).where(eq(discoveredCars.gameId, GAME)).run();
  await db.delete(discoveredCars).where(eq(discoveredCars.gameId, OTHER_GAME)).run();
}

beforeEach(cleanup);
afterEach(cleanup);

describe("native discovered-car registry", () => {
  test("retains first observed native ordinal mapping and isolates games", async () => {
    await registerDiscoveredCar(GAME, 78901, "Native GT3");
    await registerDiscoveredCar(GAME, 78901, "Conflicting Name");
    await registerDiscoveredCar(OTHER_GAME, 78901, "Different Game GT3");

    expect(await getDiscoveredCarName(GAME, 78901)).toBe("Native GT3");
    expect(await getDiscoveredCarName(OTHER_GAME, 78901)).toBe("Different Game GT3");
    expect(await getDiscoveredCarName(GAME, 99999)).toBeUndefined();
    expect((await listDiscoveredCars(GAME)).map((car) => car.ordinal)).toEqual([78901]);
  });
});
