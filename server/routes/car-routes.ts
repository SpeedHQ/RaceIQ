import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

import { OrdinalParamSchema, GameIdQuerySchema } from "../../shared/schemas";
import { carMap, getCarName, getCarSpecs, getTrackName } from "../../shared/car-data";
import { getAllIRacingCars } from "../../shared/iracing-car-data";
import { GameIdSchema } from "../../shared/types";
import {
  getDiscoveredCarName,
  listDiscoveredCars,
} from "../db/discovered-cars";
import { tryGetServerGame } from "../games/registry";

// ─── Car model config paths ────────────────────────────────────────────────────

import { USER_DATA_DIR, SHARED_DIR } from "../paths";
const CAR_MODEL_CONFIGS_PATH = resolve(USER_DATA_DIR, "car-model-configs.json");
const CAR_DIMENSIONS_PATH = resolve(SHARED_DIR, "games/fm-2023/car-dimensions.csv");

// ─── Car dimensions (loaded at module init) ─────────────────────────────────────

const carDimensions: Record<
  string,
  { halfWheelbase: number; halfFrontTrack: number; halfRearTrack: number; bodyLength: number }
> = {};

try {
  if (existsSync(CAR_DIMENSIONS_PATH)) {
    const lines = readFileSync(CAR_DIMENSIONS_PATH, "utf-8").trim().split("\n");
    for (let i = 1; i < lines.length; i++) {
      const [ordinal, , halfWheelbase, , halfFrontTrack, , halfRearTrack, bodyLength] = lines[i].split(",");
      carDimensions[ordinal] = {
        halfWheelbase: parseFloat(halfWheelbase),
        halfFrontTrack: parseFloat(halfFrontTrack),
        halfRearTrack: parseFloat(halfRearTrack),
        bodyLength: parseFloat(bodyLength),
      };
    }
    if (Object.keys(carDimensions).length > 0) {
      console.log(`[Cars] Loaded dimensions for ${Object.keys(carDimensions).length} cars`);
    }
  }
} catch {}


// ─── Helpers ────────────────────────────────────────────────────────────────────

function loadCarModelConfigs(): Record<string, any> {
  if (!existsSync(CAR_MODEL_CONFIGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CAR_MODEL_CONFIGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────────

export const carRoutes = new Hono()

  // GET /api/cars — list cars for the requested game
  .get("/api/cars", async (c) => {
    const gameIdResult = GameIdSchema.safeParse(
      c.req.header("X-Game-Id"),
    );
    if (!gameIdResult.success) {
      return c.json(
        { error: "Missing or invalid X-Game-Id header" },
        400,
      );
    }

    if (gameIdResult.data === "iracing") {
      const catalogCars = getAllIRacingCars();
      const catalogIds = new Set(catalogCars.map((car) => car.ordinal));
      const discoveredOnly = (await listDiscoveredCars("iracing"))
        .filter((car) => !catalogIds.has(car.ordinal))
        .map(({ ordinal, name }) => ({
          ordinal,
          name,
          path: "",
          category: "discovered",
          imageUrl: "",
        }));
      const cars = [...catalogCars, ...discoveredOnly];
      cars.sort((a, b) => a.name.localeCompare(b.name));
      return c.json(cars);
    }

    // ACC, AC Evo, and F1 use their own catalogue routes and pages. Do not
    // leak Forza's static catalogue if this shared route is called for them.
    if (gameIdResult.data !== "fm-2023") {
      return c.json([]);
    }

    const cars = Array.from(carMap.entries()).map(([ordinal, car]) => ({
      ordinal,
      name: `${car.year} ${car.make} ${car.model}`,
      specs: getCarSpecs(ordinal),
    }));
    cars.sort((a, b) => a.name.localeCompare(b.name));
    return c.json(cars);
  })

  // GET /api/cars/:ordinal — single car details
  .get("/api/cars/:ordinal", zValidator("param", OrdinalParamSchema), async (c) => {
    const gameIdResult = GameIdSchema.safeParse(
      c.req.header("X-Game-Id"),
    );
    if (!gameIdResult.success) {
      return c.json(
        { error: "Missing or invalid X-Game-Id header" },
        400,
      );
    }

    const { ordinal } = c.req.valid("param");
    if (gameIdResult.data === "iracing") {
      const name =
        getAllIRacingCars().find((car) => car.ordinal === ordinal)?.name ??
        (await getDiscoveredCarName("iracing", ordinal));
      return name
        ? c.json({ ordinal, name })
        : c.json({ error: "Car not found" }, 404);
    }
    if (gameIdResult.data !== "fm-2023") {
      return c.json({ error: "Car not found" }, 404);
    }

    const car = carMap.get(ordinal);
    if (!car) return c.json({ error: "Car not found" }, 404);
    return c.json({
      ordinal,
      ...car,
      name: `${car.year} ${car.make} ${car.model}`,
      specs: getCarSpecs(ordinal),
    });
  })

  // GET /api/car-name/:ordinal — plain text car name
  .get("/api/car-name/:ordinal", zValidator("param", OrdinalParamSchema), zValidator("query", GameIdQuerySchema), (c) => {
    const { ordinal } = c.req.valid("param");
    const gameId = c.req.query("gameId");
    const serverAdapter = gameId ? tryGetServerGame(gameId) : undefined;
    if (serverAdapter) return c.text(serverAdapter.getCarName(ordinal));
    return c.text(getCarName(ordinal, gameId));
  })


  // GET /api/resolve-names — batch resolve track + car ordinals to names
  .get("/api/resolve-names",
    zValidator("query", z.object({
      gameId: z.string().optional(),
      tracks: z.string().optional(),
      cars: z.string().optional(),
    })),
    (c) => {
      const { gameId, tracks, cars } = c.req.valid("query");
      const adapter = gameId ? tryGetServerGame(gameId) : undefined;
      const trackNames: Record<string, string> = {};
      const carNames: Record<string, string> = {};
      if (tracks) {
        for (const ord of tracks.split(",")) {
          const n = Number(ord);
          if (!Number.isNaN(n)) {
            trackNames[ord] = adapter ? adapter.getTrackName(n) : getTrackName(n, gameId);
          }
        }
      }
      if (cars) {
        for (const ord of cars.split(",")) {
          const n = Number(ord);
          if (!Number.isNaN(n)) {
            carNames[ord] = adapter ? adapter.getCarName(n) : getCarName(n, gameId);
          }
        }
      }
      return c.json({ trackNames, carNames });
    }
  )

  // GET /api/car-model-configs — all configs (merged with extracted dimensions)
  .get("/api/car-model-configs", (c) => {
    const configs = loadCarModelConfigs();
    // Merge extracted dimensions as defaults (config values take priority)
    for (const [ordinal, dims] of Object.entries(carDimensions)) {
      if (!configs[ordinal]) configs[ordinal] = {};
      const cfg = configs[ordinal];
      if (!cfg.halfWheelbase) cfg.halfWheelbase = dims.halfWheelbase;
      if (!cfg.halfFrontTrack) cfg.halfFrontTrack = dims.halfFrontTrack;
      if (!cfg.halfRearTrack) cfg.halfRearTrack = dims.halfRearTrack;
      if (!cfg.bodyLength) cfg.bodyLength = dims.bodyLength;
    }
    return c.json(configs);
  })

  // GET /api/car-model-configs/:ordinal — single car config
  .get(
    "/api/car-model-configs/:ordinal",
    zValidator("param", OrdinalParamSchema),
    (c) => {
      const { ordinal } = c.req.valid("param");
      const configs = loadCarModelConfigs();
      const key = String(ordinal);
      return configs[key] ? c.json(configs[key]) : c.json({ error: "No config" }, 404);
    },
  )

  // PUT /api/car-model-configs/:ordinal — update car model config (merges fields)
  .put(
    "/api/car-model-configs/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("json", z.object({ glbOffsetX: z.number() })),
    async (c) => {
      const { ordinal } = c.req.valid("param");
      const key = String(ordinal);
      const body = c.req.valid("json");

      const configs = loadCarModelConfigs();
      configs[key] = { ...configs[key], ...body };
      writeFileSync(CAR_MODEL_CONFIGS_PATH, JSON.stringify(configs, null, 2));
      console.log(`[CarModel] Saved config for car ${key}:`, body);
      return c.json({ success: true, config: configs[key] });
    },
  );
