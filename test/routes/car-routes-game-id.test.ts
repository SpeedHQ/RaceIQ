import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { registerDiscoveredCar } from "../../server/db/discovered-cars";
import { db } from "../../server/db/index";
import { discoveredCars } from "../../server/db/schema";
import { carRoutes } from "../../server/routes/car-routes";

const CAR_ID = 987_654_321;

async function cleanup(): Promise<void> {
  await db
    .delete(discoveredCars)
    .where(and(eq(discoveredCars.ordinal, CAR_ID), eq(discoveredCars.gameId, "iracing")))
    .run();
  await db
    .delete(discoveredCars)
    .where(and(eq(discoveredCars.ordinal, CAR_ID), eq(discoveredCars.gameId, "ac-evo")))
    .run();
}

beforeEach(cleanup);
afterEach(cleanup);

describe("GET /api/cars game context", () => {
  test("requires X-Game-Id", async () => {
    const response = await carRoutes.request("/api/cars");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Missing or invalid X-Game-Id header",
    });
  });

  test("returns the seeded active iRacing catalogue with images and categories", async () => {
    await registerDiscoveredCar("iracing", CAR_ID, "Future Test Car");
    await registerDiscoveredCar("ac-evo", CAR_ID, "Foreign AC Evo Car");

    const response = await carRoutes.request("/api/cars", {
      headers: { "X-Game-Id": "iracing" },
    });

    expect(response.status).toBe(200);
    const cars = (await response.json()) as Array<{
      ordinal: number;
      name: string;
      path: string;
      category: string;
      imageUrl: string;
      shortName: string;
      hp: number | null;
      weightLb: number | null;
      hasHeadlights: boolean | null;
      rainEnabled: boolean | null;
      hasMultipleDryTireTypes: boolean | null;
      searchTerms: string;
    }>;
    expect(cars.find((car) => car.ordinal === 216)).toMatchObject({
      ordinal: 216,
      name: "BMW M2 Racing (G87)",
      path: "cars\\bmwm2g87",
      category: "sports_car",
      imageUrl: "/iracing-car-images/216.jpg",
      shortName: "BMWM2R",
      hp: 313,
      weightLb: 3472,
      hasHeadlights: true,
      rainEnabled: true,
      hasMultipleDryTireTypes: true,
    });
    expect(cars).toContainEqual({
      ordinal: CAR_ID,
      name: "Future Test Car",
      path: "",
      category: "discovered",
      imageUrl: "",
      shortName: "",
      hp: null,
      weightLb: null,
      hasHeadlights: null,
      rainEnabled: null,
      hasMultipleDryTireTypes: null,
      searchTerms: "",
    });
    expect(cars).toHaveLength(186);
    expect(cars.some((car) => car.name === "Foreign AC Evo Car")).toBe(false);
    const catalogCars = cars.filter((car) => car.ordinal !== CAR_ID);
    const catalogPaths = catalogCars.map((car) => car.path);
    expect(new Set(catalogPaths).size).toBe(catalogPaths.length);
    expect(
      [...new Set(catalogCars.map((car) => car.category))].sort(),
    ).toEqual([
      "dirt_oval",
      "dirt_road",
      "formula_car",
      "oval",
      "sports_car",
    ]);
    for (const car of catalogCars) {
      expect(car.imageUrl).toBe(`/iracing-car-images/${car.ordinal}.jpg`);
      const imagePath = resolve(import.meta.dir, "../../client/public", car.imageUrl.slice(1));
      expect(existsSync(imagePath)).toBe(true);
      expect(statSync(imagePath).size).toBeGreaterThan(0);
    }
  });

  test("returns seeded iRacing car details by native ID", async () => {
    const response = await carRoutes.request("/api/cars/216", {
      headers: { "X-Game-Id": "iracing" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ordinal: 216,
      name: "BMW M2 Racing (G87)",
      hp: 313,
      rainEnabled: true,
    });
  });

  test("keeps the static Forza catalogue scoped to Forza", async () => {
    await registerDiscoveredCar("iracing", CAR_ID, "Test iRacing GT3");

    const response = await carRoutes.request("/api/cars", {
      headers: { "X-Game-Id": "fm-2023" },
    });

    expect(response.status).toBe(200);
    const cars = (await response.json()) as Array<{
      ordinal: number;
      name: string;
    }>;
    expect(cars.length).toBeGreaterThan(100);
    expect(cars.some((car) => car.name === "Test iRacing GT3")).toBe(false);
  });
});
