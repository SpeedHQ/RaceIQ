import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { gameAssetsDir } from "@raceiq/shared/platform/runtime/data-paths";
import { CarIdParamSchema, GameIdQuerySchema } from "@raceiq/shared/platform/http/route-schemas";
import { fmCarCatalog, getFmCarSpecs } from "@raceiq/game-fm-2023-metadata/racing/cars/fm";
import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { getAllIRacingCars } from "@raceiq/game-iracing-metadata/racing/cars/iracing";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import {
  getDiscoveredCarName,
  listDiscoveredCars,
} from "@raceiq/backend-core/db/discovered-cars";
import { getLMUCar, lmuCarCatalog } from "@raceiq/game-lmu-metadata/catalog";
import { getAcEvoCarName } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";
import { getAcEvoTrackName } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { tryGetServerGame } from "@raceiq/backend-core/games/registry";
import { getAllF1Cars } from "@raceiq/game-f1-2025-metadata/racing/cars/f1";
// ─── Car model config paths ────────────────────────────────────────────────────

import { USER_DATA_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { gameCatalogDir } from "@raceiq/shared/platform/runtime/data-paths";
const CAR_MODEL_CONFIGS_PATH = resolve(USER_DATA_DIR, "car-model-configs.json");
const CAR_DIMENSIONS_PATH = resolve(gameCatalogDir("fm-2023"), "car-dimensions.csv");

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
export const CarModelConfigUpdateSchema = z.object({ glbOffsetX: z.number() }).strict();


function loadCarModelConfigs(): Record<string, any> {
  if (!existsSync(CAR_MODEL_CONFIGS_PATH)) return {};
  try {
    const configs = JSON.parse(readFileSync(CAR_MODEL_CONFIGS_PATH, "utf-8")) as Record<string, any>;
    let migrated = false;
    for (const config of Object.values(configs)) {
      if (config && typeof config === "object" && "glbRotationY" in config) {
        delete config.glbRotationY;
        migrated = true;
      }
    }
    if (migrated) writeFileSync(CAR_MODEL_CONFIGS_PATH, JSON.stringify(configs, null, 2));
    return configs;
  } catch {
    return {};
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────────

const IdentityListQuerySchema = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid JSON identity list" });
    return z.NEVER;
  }
}).pipe(z.array(z.string())).optional();

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
    if (gameIdResult.data === "lmu") {
      const cars = lmuCarCatalog.map((car) => ({
        id: car.id,
        name: car.name,
        class: car.class,
        series: car.series,
        manufacturer: car.manufacturer,
        path: car.thumbnail ?? "",
        category: car.class,
        imageUrl: car.thumbnail ? `/api/lmu-assets/cars/${encodeURIComponent(car.id)}` : "",
      }));
      const discovered = (await listDiscoveredCars("lmu")).map(
        ({ carId, name }) => ({
          id: carId,
          name,
          path: "",
          category: "discovered",
          imageUrl: "",
        }),
      );
      return c.json([...cars, ...discovered].sort((left, right) => left.name.localeCompare(right.name)));
    }
    if (gameIdResult.data === "f1-2025") {
      return c.json(getAllF1Cars());
    }

    if (gameIdResult.data === "iracing") {
      const catalogCars = getAllIRacingCars().map(({ ordinal, ...car }) => ({ id: String(ordinal), ...car }));
      const catalogIds = new Set(catalogCars.map((car) => car.id));
      const discoveredOnly = (await listDiscoveredCars("iracing"))
        .filter((car) => !catalogIds.has(car.carId))
        .map(({ carId, name }) => ({
          id: carId,
          name,
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

    const cars = Array.from(fmCarCatalog.entries()).map(([ordinal, car]) => ({
      id: String(ordinal),
      name: `${car.year} ${car.make} ${car.model}`,
      specs: getFmCarSpecs(ordinal),
    }));
    cars.sort((a, b) => a.name.localeCompare(b.name));
    return c.json(cars);
  })

  .get("/api/lmu-assets/cars/:id", (c) => {
    const car = getLMUCar(c.req.param("id"));
    if (!car?.thumbnail) return c.json({ error: "LMU car asset not found" }, 404);
    const file = resolve(gameAssetsDir("lmu"), car.thumbnail);
    if (!existsSync(file)) return c.json({ error: "LMU car asset not found" }, 404);
    return new Response(readFileSync(file), {
      headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  })

  // GET /api/cars/:carId — single car details
  .get("/api/cars/:carId", zValidator("param", CarIdParamSchema), async (c) => {
    const gameIdResult = GameIdSchema.safeParse(
      c.req.header("X-Game-Id"),
    );
    if (!gameIdResult.success) {
      return c.json(
        { error: "Missing or invalid X-Game-Id header" },
        400,
      );
    }

    const { carId } = c.req.valid("param");
    if (gameIdResult.data === "lmu") {
      const name = await getDiscoveredCarName("lmu", carId);
      return name
        ? c.json({ id: carId, name })
        : c.json({ error: "Car not found" }, 404);
    }
    if (gameIdResult.data === "iracing") {
      const catalogCar = getAllIRacingCars().find((car) => String(car.ordinal) === carId);
      if (catalogCar) {
        const { ordinal, ...car } = catalogCar;
        return c.json({ id: String(ordinal), ...car });
      }
      const name = await getDiscoveredCarName("iracing", carId);
      return name ? c.json({ id: carId, name }) : c.json({ error: "Car not found" }, 404);
    }
    if (gameIdResult.data !== "fm-2023") {
      return c.json({ error: "Car not found" }, 404);
    }

    const car = fmCarCatalog.get(Number(carId));
    if (!car) return c.json({ error: "Car not found" }, 404);
    return c.json({
      id: carId,
      ...car,
      name: `${car.year} ${car.make} ${car.model}`,
      specs: getFmCarSpecs(Number(carId)),
    });
  })

  // GET /api/car-name/:carId — plain text car name
  .get("/api/car-name/:carId", zValidator("param", CarIdParamSchema), zValidator("query", GameIdQuerySchema), (c) => {
    const carId = c.req.valid("param").carId;
    const gameId = c.req.query("gameId");
    if (gameId === "lmu") return c.text(getLMUCar(carId)?.name ?? carId);
    if (gameId === "ac-evo") return c.text(getAcEvoCarName(carId) ?? carId);
    const serverAdapter = gameId ? tryGetServerGame(gameId) : undefined;
    if (serverAdapter) return c.text(serverAdapter.getCarName(carId));
    return c.text(resolveCarName(carId, gameId));
  })


  // GET /api/resolve-names — batch resolve track + car identities to names
  .get("/api/resolve-names",
    zValidator("query", z.object({
      gameId: z.string().optional(),
      tracks: IdentityListQuerySchema,
      cars: IdentityListQuerySchema,
    })),
    (c) => {
      const { gameId, tracks, cars } = c.req.valid("query");
      const adapter = gameId ? tryGetServerGame(gameId) : undefined;
      const trackNames: Record<string, string> = {};
      const carNames: Record<string, string> = {};
      if (tracks) {
        for (const raw of tracks) {
          if (gameId === "ac-evo") {
            trackNames[raw] = getAcEvoTrackName(raw) ?? "Unknown track";
            continue;
          }
          trackNames[raw] = adapter ? adapter.getTrackName(raw) : resolveTrackName(raw, gameId);
        }
      }
      if (cars) {
        for (const raw of cars) {
          if (gameId === "ac-evo") {
            carNames[raw] = getAcEvoCarName(raw) ?? "Unknown car";
            continue;
          }
          carNames[raw] = adapter ? adapter.getCarName(raw) : resolveCarName(raw, gameId);
        }
      }
      return c.json({ trackNames, carNames });
    }
  )
  // GET /api/car-model-configs — all configs (merged with extracted dimensions)
  .get("/api/car-model-configs", (c) => {
    const configs = loadCarModelConfigs();
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






  // GET /api/car-model-configs/:carId — single car config
  .get(
    "/api/car-model-configs/:carId",
    zValidator("param", CarIdParamSchema),
    (c) => {
      const { carId } = c.req.valid("param");
      const configs = loadCarModelConfigs();
      const key = carId;
      return configs[key] ? c.json(configs[key]) : c.json({ error: "No config" }, 404);
    },
  )

  // PUT /api/car-model-configs/:carId — update car model config (merges fields)
  .put(
    "/api/car-model-configs/:carId",
    zValidator("param", CarIdParamSchema),
    zValidator("json", CarModelConfigUpdateSchema),
    async (c) => {
      const { carId } = c.req.valid("param");
      const key = carId;
      const body = c.req.valid("json");

      const configs = loadCarModelConfigs();
      configs[key] = { ...configs[key], ...body };
      writeFileSync(CAR_MODEL_CONFIGS_PATH, JSON.stringify(configs, null, 2));
      console.log(`[CarModel] Saved config for car ${key}:`, body);
      return c.json({ success: true, config: configs[key] });
    },
  );
