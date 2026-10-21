import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { registerAcEvoCar, registerDiscoveredCar } from "@raceiq/backend-core/db/discovered-cars";
import { db } from "@raceiq/backend-core/db/index";
import { discoveredCars } from "@raceiq/backend-core/db/schema";
import { CarModelConfigUpdateSchema, carRoutes } from "../../src/routes/car-routes";

const CAR_ID = "987654321";

async function cleanup(): Promise<void> {
  await db
    .delete(discoveredCars)
    .where(and(eq(discoveredCars.carId, CAR_ID), eq(discoveredCars.gameId, "iracing")))
    .run();
  await db
    .delete(discoveredCars)
    .where(and(eq(discoveredCars.carId, "Foreign AC Evo Car"), eq(discoveredCars.gameId, "ac-evo")))
    .run();
}

beforeEach(cleanup);
afterEach(cleanup);

test("rejects consumer model orientation overrides", () => {
  expect(CarModelConfigUpdateSchema.safeParse({ glbOffsetX: 0, glbRotationY: Math.PI }).success).toBe(false);
});

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
    await registerAcEvoCar("Foreign AC Evo Car");

    const response = await carRoutes.request("/api/cars", {
      headers: { "X-Game-Id": "iracing" },
    });

    expect(response.status).toBe(200);
    const cars = (await response.json()) as Array<{
      id: string;
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
    expect(cars.find((car) => car.id === "216")).toMatchObject({
      id: "216",
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
    expect(cars.find((car) => car.id === CAR_ID)).toMatchObject({
      id: CAR_ID,
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
    expect(cars.some((car) => car.name === "Foreign AC Evo Car")).toBe(false);
    const catalogCars = cars.filter((car) => car.id !== CAR_ID);
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
      expect(car.imageUrl).toBe(`/iracing-car-images/${car.id}.jpg`);
      const imagePath = resolve(ROOT_DIR, "packages/game-iracing/assets/public/iracing-car-images", `${car.id}.jpg`);
      expect(existsSync(imagePath)).toBe(true);
      expect(statSync(imagePath).size).toBeGreaterThan(0);
    }
  });

  test("returns enriched iRacing car details by native ID", async () => {
    const response = await carRoutes.request("/api/cars/216", {
      headers: { "X-Game-Id": "iracing" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "216",
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
      id: string;
      name: string;
    }>;
    expect(cars.some((car) => car.name === "Test iRacing GT3")).toBe(false);
  });
});

describe("GET /api/resolve-names native identities", () => {
  test("preserves JSON track tuples and car names containing commas and quotes", async () => {
    const trackId = JSON.stringify(['Unknown, "Circuit"', 'Layout, "East"']);
    const carId = 'Unknown, "Car"';
    const query = new URLSearchParams({
      gameId: "ac-evo",
      tracks: JSON.stringify([trackId]),
      cars: JSON.stringify([carId]),
    });
    const response = await carRoutes.request(`/api/resolve-names?${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      trackNames: { [trackId]: trackId },
      carNames: { [carId]: carId },
    });
  });

  test("rejects malformed JSON and numeric identities instead of coercing them", async () => {
    for (const tracks of ["not-json", "[42]"]) {
      const query = new URLSearchParams({ gameId: "ac-evo", tracks });
      const response = await carRoutes.request(`/api/resolve-names?${query}`);
      expect(response.status).toBe(400);
    }
  });
});
