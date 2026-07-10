import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { resolve, sep } from "path";
import { IdParamSchema } from "../../shared/schemas";
import { GameIdSchema } from "../../shared/types";
import {
  insertTune,
  getTunes,
  getTuneById,
  updateTune,
  deleteTune,
  setTuneAssignment,
  getTuneAssignment,
  getTuneAssignments,
  deleteTuneAssignment,
  updateLapTune,
} from "../db/tune-queries";

// Static catalog data — loaded from shared JSON
import balancedCircuit from "../../shared/tunes/2860-amv-gt3-balanced-circuit.json";
import aggressiveCircuit from "../../shared/tunes/2860-amv-gt3-aggressive-circuit.json";
import wetWeather from "../../shared/tunes/2860-amv-gt3-wet-weather.json";
import topSpeed from "../../shared/tunes/2860-amv-gt3-top-speed.json";
import stableBeginner from "../../shared/tunes/2860-amv-gt3-stable-beginner.json";
import nordschleife from "../../shared/tunes/2860-amv-gt3-nordschleife.json";
import spa from "../../shared/tunes/2860-amv-gt3-spa.json";
import type { TuneSettings, RaceStrategy, GameId } from "../../shared/types";

interface CatalogTune {
  id: string;
  name: string;
  author: string;
  carOrdinal: number;
  category: string;
  trackOrdinal?: number;
  description: string;
  strengths: string[];
  weaknesses: string[];
  bestTracks?: string[];
  strategies?: RaceStrategy[];
  settings: TuneSettings;
}

const TUNE_CATALOG: CatalogTune[] = [
  balancedCircuit,
  aggressiveCircuit,
  wetWeather,
  topSpeed,
  stableBeginner,
  nordschleife,
  spa,
] as CatalogTune[];

function getCatalogTuneById(id: string): CatalogTune | undefined {
  return TUNE_CATALOG.find((t) => t.id === id);
}

/** Forza's TuneSettings has a specific shape that the built-in Forza UI expects.
 *  ACC / AC-EVO / F1 save raw game-specific JSON blobs instead, so validation
 *  is skipped for those games — any object shape is accepted. */
function validateForzaTuneSettings(settings: any): boolean {
  if (!settings || typeof settings !== "object") return false;
  const required = [
    "tires", "gearing", "alignment", "antiRollBars", "springs",
    "damping", "aero", "differential", "brakes",
  ];
  for (const key of required) {
    if (!settings[key] || typeof settings[key] !== "object") return false;
  }
  if (
    typeof settings.tires.frontPressure !== "number" ||
    typeof settings.tires.rearPressure !== "number"
  ) return false;
  if (typeof settings.gearing.finalDrive !== "number") return false;
  if (
    typeof settings.brakes.balance !== "number" ||
    typeof settings.brakes.pressure !== "number"
  ) return false;
  return true;
}

function validateSettingsForGame(gameId: GameId, settings: any): boolean {
  if (gameId === "fm-2023") return validateForzaTuneSettings(settings);
  return settings != null && typeof settings === "object";
}

/** Parse JSON text columns from a DB tune row into proper arrays/objects */
interface ParsedTune {
  id: number;
  gameId: string;
  name: string;
  author: string;
  carOrdinal: number;
  category: string;
  description: string;
  settings: Record<string, unknown> | null;
  strengths: string[];
  weaknesses: string[];
  bestTracks: string[];
  strategies: unknown[];
  unitSystem: string;
  source: string;
  catalogId: string | null;
  trackOrdinal: number | null;
  createdAt: string;
  lapId: number | null;
}

function parseTuneRow(row: any): ParsedTune {
  return {
    ...row,
    strengths: row.strengths ? JSON.parse(row.strengths) : [],
    weaknesses: row.weaknesses ? JSON.parse(row.weaknesses) : [],
    bestTracks: row.bestTracks ? JSON.parse(row.bestTracks) : [],
    strategies: row.strategies ? JSON.parse(row.strategies) : [],
    settings: row.settings ? JSON.parse(row.settings) : null,
  };
}

// ── Setup-file import helpers (ACC & AC-EVO) ─────────────────────────────────

/** Locations where ACC / AC-EVO store user setup files under the user's profile. */
async function getSetupsBaseDir(gameId: "acc" | "ac-evo"): Promise<string | null> {
  const home = homedir();
  const gameDir =
    gameId === "acc"
      ? "Assetto Corsa Competizione"
      : "Assetto Corsa EVO";
  const candidates = [
    resolve(home, "Documents", gameDir, "Setups"),
    resolve(home, "OneDrive", "Documents", gameDir, "Setups"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

interface SetupFileListing {
  carModel: string;
  trackName: string;
  fileName: string;
  absolutePath: string;
}

function listSetupFiles(baseDir: string): SetupFileListing[] {
  const out: SetupFileListing[] = [];
  let carDirs: string[];
  try {
    carDirs = readdirSync(baseDir).filter((d) =>
      statSync(resolve(baseDir, d)).isDirectory(),
    );
  } catch {
    return out;
  }
  for (const carModel of carDirs) {
    const carPath = resolve(baseDir, carModel);
    let trackDirs: string[];
    try {
      trackDirs = readdirSync(carPath).filter((d) =>
        statSync(resolve(carPath, d)).isDirectory(),
      );
    } catch {
      continue;
    }
    for (const trackName of trackDirs) {
      const trackPath = resolve(carPath, trackName);
      let files: string[];
      try {
        files = readdirSync(trackPath).filter((f) => f.toLowerCase().endsWith(".json"));
      } catch {
        continue;
      }
      for (const fileName of files) {
        out.push({
          carModel,
          trackName,
          fileName,
          absolutePath: resolve(trackPath, fileName),
        });
      }
    }
  }
  return out;
}

const CarOrdinalQuerySchema = z.object({
  gameId: GameIdSchema.optional(),
  carOrdinal: z.coerce.number().int().optional(),
});

const CreateTuneSchema = z.object({
  gameId: GameIdSchema,
  name: z.string().min(1),
  author: z.string().min(1),
  carOrdinal: z.number().int(),
  category: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
  trackOrdinal: z.number().int().optional(),
  description: z.string().optional().default(""),
  strengths: z.array(z.string()).optional(),
  weaknesses: z.array(z.string()).optional(),
  bestTracks: z.array(z.string()).optional(),
  strategies: z.array(z.unknown()).optional(),
  unitSystem: z.enum(["metric", "imperial"]).optional().default("metric"),
  source: z.enum(["user", "catalog-clone", "imported-file"]).optional().default("user"),
  catalogId: z.string().optional(),
});

const AssignmentParamsSchema = z.object({
  carOrdinal: z.string().transform(val => parseInt(val, 10)),
  trackOrdinal: z.string().transform(val => parseInt(val, 10)),
});

const SetAssignmentSchema = z.object({
  carOrdinal: z.number().int(),
  trackOrdinal: z.number().int(),
  tuneId: z.number().int(),
});

const LapTuneSchema = z.object({
  tuneId: z.number().int().nullable(),
});

const ImportFileSchema = z.object({
  gameId: z.enum(["acc", "ac-evo"]),
  filePath: z.string().min(1),
  name: z.string().optional(),
  author: z.string().optional(),
  carOrdinal: z.number().int(),
  category: z.string().optional().default("circuit"),
});

export const tuneRoutes = new Hono()
  // ─── Tune CRUD ───────────────────────────────────────────────────────────────

  // GET /api/tunes — list user tunes, optional ?gameId= and ?carOrdinal= filters
  .get("/api/tunes",
    zValidator("query", CarOrdinalQuerySchema),
    async (c) => {
      const { gameId, carOrdinal } = c.req.valid("query");
      const rows = await getTunes({ gameId, carOrdinal });
      return c.json(rows.map(parseTuneRow));
    }
  )

  // GET /api/tunes/:id — get single tune
  .get("/api/tunes/:id",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await getTuneById(id);
      if (!row) return c.json({ error: "Tune not found" }, 404);
      return c.json(parseTuneRow(row));
    }
  )

  // POST /api/tunes — create tune
  .post("/api/tunes",
    zValidator("json", CreateTuneSchema),
    async (c) => {
      const body = c.req.valid("json");
      if (!validateSettingsForGame(body.gameId, body.settings)) {
        return c.json({ error: "Invalid settings structure" }, 400);
      }
      const id = await insertTune({
        gameId: body.gameId,
        name: body.name,
        author: body.author,
        carOrdinal: body.carOrdinal,
        category: body.category,
        trackOrdinal: body.trackOrdinal,
        description: body.description,
        strengths: body.strengths ? JSON.stringify(body.strengths) : undefined,
        weaknesses: body.weaknesses ? JSON.stringify(body.weaknesses) : undefined,
        bestTracks: body.bestTracks ? JSON.stringify(body.bestTracks) : undefined,
        strategies: body.strategies ? JSON.stringify(body.strategies) : undefined,
        settings: JSON.stringify(body.settings),
        unitSystem: body.unitSystem,
        source: body.source,
        catalogId: body.catalogId,
      });
      const created = await getTuneById(id);
      return c.json(parseTuneRow(created), 201);
    }
  )

  // PUT /api/tunes/:id — update tune
  .put("/api/tunes/:id",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const existing = await getTuneById(id);
      if (!existing) return c.json({ error: "Tune not found" }, 404);

      const body = await c.req.json();
      if (body.settings && !validateSettingsForGame(existing.gameId as GameId, body.settings)) {
        return c.json({ error: "Invalid settings structure" }, 400);
      }
      const data: Record<string, any> = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.author !== undefined) data.author = body.author;
      if (body.carOrdinal !== undefined) data.carOrdinal = body.carOrdinal;
      if (body.category !== undefined) data.category = body.category;
      if (body.trackOrdinal !== undefined) data.trackOrdinal = body.trackOrdinal;
      if (body.description !== undefined) data.description = body.description;
      if (body.strengths !== undefined) data.strengths = JSON.stringify(body.strengths);
      if (body.weaknesses !== undefined) data.weaknesses = JSON.stringify(body.weaknesses);
      if (body.bestTracks !== undefined) data.bestTracks = JSON.stringify(body.bestTracks);
      if (body.strategies !== undefined) data.strategies = JSON.stringify(body.strategies);
      if (body.settings !== undefined) data.settings = JSON.stringify(body.settings);
      if (body.unitSystem !== undefined) data.unitSystem = body.unitSystem;
      const updated = await updateTune(id, data);
      if (!updated) return c.json({ error: "Tune not found" }, 404);
      const row = await getTuneById(id);
      return c.json(parseTuneRow(row));
    }
  )

  // DELETE /api/tunes/:id — delete tune
  .delete("/api/tunes/:id",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const deleted = await deleteTune(id);
      if (!deleted) return c.json({ error: "Tune not found" }, 404);
      return c.json({ success: true });
    }
  )

  // POST /api/tunes/import — same as POST /api/tunes (batch-ish helper, kept for
  // compatibility with the JSON paste flow in TuneForm)
  .post("/api/tunes/import",
    zValidator("json", CreateTuneSchema),
    async (c) => {
      const body = c.req.valid("json");
      if (!validateSettingsForGame(body.gameId, body.settings)) {
        return c.json({ error: "Invalid settings structure" }, 400);
      }
      const id = await insertTune({
        gameId: body.gameId,
        name: body.name,
        author: body.author,
        carOrdinal: body.carOrdinal,
        category: body.category,
        trackOrdinal: body.trackOrdinal,
        description: body.description,
        strengths: body.strengths ? JSON.stringify(body.strengths) : undefined,
        weaknesses: body.weaknesses ? JSON.stringify(body.weaknesses) : undefined,
        bestTracks: body.bestTracks ? JSON.stringify(body.bestTracks) : undefined,
        strategies: body.strategies ? JSON.stringify(body.strategies) : undefined,
        settings: JSON.stringify(body.settings),
        unitSystem: body.unitSystem,
        source: body.source,
        catalogId: body.catalogId,
      });
      const created = await getTuneById(id);
      return c.json(parseTuneRow(created), 201);
    }
  )

  // POST /api/tunes/clone/:catalogId — clone a catalog tune into DB (Forza only)
  .post("/api/tunes/clone/:catalogId", async (c) => {
    const catalogId = c.req.param("catalogId");
    const catalogTune = getCatalogTuneById(catalogId);
    if (!catalogTune) return c.json({ error: "Catalog tune not found" }, 404);

    const id = await insertTune({
      gameId: "fm-2023",
      name: `${catalogTune.name} (copy)`,
      author: catalogTune.author,
      carOrdinal: catalogTune.carOrdinal,
      category: catalogTune.category,
      trackOrdinal: catalogTune.trackOrdinal,
      description: catalogTune.description,
      strengths: JSON.stringify(catalogTune.strengths ?? []),
      weaknesses: JSON.stringify(catalogTune.weaknesses ?? []),
      bestTracks: JSON.stringify(catalogTune.bestTracks ?? []),
      strategies: JSON.stringify(catalogTune.strategies ?? []),
      settings: JSON.stringify(catalogTune.settings),
      unitSystem: "metric",
      source: "catalog-clone",
      catalogId: catalogTune.id,
    });

    const created = await getTuneById(id);
    return c.json(parseTuneRow(created), 201);
  })

  // POST /api/tunes/:id/duplicate — clone an existing user tune into a fresh row
  .post("/api/tunes/:id/duplicate",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const existing = await getTuneById(id);
      if (!existing) return c.json({ error: "Tune not found" }, 404);

      const newId = await insertTune({
        gameId: existing.gameId,
        name: `${existing.name} (copy)`,
        author: existing.author,
        carOrdinal: existing.carOrdinal,
        category: existing.category,
        trackOrdinal: existing.trackOrdinal ?? undefined,
        description: existing.description,
        strengths: existing.strengths ?? undefined,
        weaknesses: existing.weaknesses ?? undefined,
        bestTracks: existing.bestTracks ?? undefined,
        strategies: existing.strategies ?? undefined,
        settings: existing.settings,
        unitSystem: existing.unitSystem,
        source: existing.source,
        catalogId: existing.catalogId ?? undefined,
      });
      const created = await getTuneById(newId);
      return c.json(parseTuneRow(created), 201);
    }
  )

  // ─── Setup-file discovery (ACC & AC-EVO) ─────────────────────────────────────

  // GET /api/tunes/setup-files?gameId=acc — list setup .json files found
  // under the user's Documents/Assetto Corsa Competizione/Setups (or AC EVO)
  .get("/api/tunes/setup-files",
    zValidator("query", z.object({ gameId: z.enum(["acc", "ac-evo"]) })),
    async (c) => {
      const { gameId } = c.req.valid("query");
      const baseDir = await getSetupsBaseDir(gameId);
      if (!baseDir) {
        return c.json({ baseDir: null, files: [], error: "Setups folder not found" });
      }
      return c.json({ baseDir, files: listSetupFiles(baseDir) });
    }
  )

  // POST /api/tunes/import-file — read a setup file from disk, save as tune
  .post("/api/tunes/import-file",
    zValidator("json", ImportFileSchema),
    async (c) => {
      const body = c.req.valid("json");
      const baseDir = await getSetupsBaseDir(body.gameId);
      if (!baseDir) return c.json({ error: "Setups folder not found" }, 404);

      // Guard: the provided absolute path must live under the setups base dir.
      // Resolve symlinks on both sides so a symlink inside Setups can't point
      // outside it, and compare with a trailing separator so a sibling dir
      // with a shared prefix (e.g. "SetupsEvil") can't pass.
      const absPath = resolve(body.filePath);
      if (!existsSync(absPath)) return c.json({ error: "File not found" }, 404);

      let realPath: string;
      let realBase: string;
      try {
        realPath = realpathSync(absPath);
        realBase = realpathSync(resolve(baseDir));
      } catch (err: any) {
        if (err?.code === "ENOENT") return c.json({ error: "File not found" }, 404);
        return c.json({ error: `Read failed: ${err.message}` }, 500);
      }
      if (!(realPath + sep).startsWith(realBase + sep)) {
        return c.json({ error: "Path must be inside the Setups folder" }, 400);
      }

      let raw: string;
      try { raw = readFileSync(realPath, "utf-8"); }
      catch (err: any) { return c.json({ error: `Read failed: ${err.message}` }, 500); }

      let parsed: any;
      try { parsed = JSON.parse(raw); }
      catch (err: any) { return c.json({ error: `Invalid JSON: ${err.message}` }, 400); }

      // Default name: file stem; description notes origin.
      const fileName = realPath.split(/[\\/]/).pop() ?? "imported";
      const name = body.name ?? fileName.replace(/\.json$/i, "");

      const id = await insertTune({
        gameId: body.gameId,
        name,
        author: body.author ?? "Imported",
        carOrdinal: body.carOrdinal,
        category: body.category,
        description: `Imported from ${fileName}`,
        settings: JSON.stringify(parsed),
        unitSystem: "metric",
        source: "imported-file",
      });
      const created = await getTuneById(id);
      return c.json(parseTuneRow(created), 201);
    }
  )

  // ─── Catalog ─────────────────────────────────────────────────────────────────

  // GET /api/catalog/tunes — return static TUNE_CATALOG (Forza only)
  .get("/api/catalog/tunes",
    zValidator("query", CarOrdinalQuerySchema),
    (c) => {
      const { carOrdinal } = c.req.valid("query");
      if (carOrdinal !== undefined) {
        return c.json(TUNE_CATALOG.filter((t) => t.carOrdinal === carOrdinal));
      }
      return c.json(TUNE_CATALOG);
    }
  )

  // ─── Assignments ─────────────────────────────────────────────────────────────

  // GET /api/tune-assignments — list all, optional ?gameId= and ?carOrdinal= filter
  .get("/api/tune-assignments",
    zValidator("query", CarOrdinalQuerySchema),
    async (c) => {
      const { gameId, carOrdinal } = c.req.valid("query");
      return c.json(await getTuneAssignments({ gameId, carOrdinal }));
    }
  )

  // GET /api/tune-assignments/:carOrdinal/:trackOrdinal — get specific assignment
  .get("/api/tune-assignments/:carOrdinal/:trackOrdinal",
    zValidator("param", AssignmentParamsSchema),
    async (c) => {
      const { carOrdinal, trackOrdinal } = c.req.valid("param");
      const assignment = await getTuneAssignment(carOrdinal, trackOrdinal);
      if (!assignment) return c.json({ error: "Assignment not found" }, 404);
      return c.json(assignment);
    }
  )

  // PUT /api/tune-assignments — set/update assignment
  .put("/api/tune-assignments",
    zValidator("json", SetAssignmentSchema),
    async (c) => {
      const { carOrdinal, trackOrdinal, tuneId } = c.req.valid("json");
      await setTuneAssignment(carOrdinal, trackOrdinal, tuneId);
      const assignment = await getTuneAssignment(carOrdinal, trackOrdinal);
      return c.json(assignment);
    }
  )

  // DELETE /api/tune-assignments/:carOrdinal/:trackOrdinal — remove assignment
  .delete("/api/tune-assignments/:carOrdinal/:trackOrdinal",
    zValidator("param", AssignmentParamsSchema),
    async (c) => {
      const { carOrdinal, trackOrdinal } = c.req.valid("param");
      const deleted = await deleteTuneAssignment(carOrdinal, trackOrdinal);
      if (!deleted) return c.json({ error: "Assignment not found" }, 404);
      return c.json({ success: true });
    }
  )

  // ─── Lap tune override ──────────────────────────────────────────────────────

  // PATCH /api/laps/:id/tune — set or clear tune for specific lap
  .patch("/api/laps/:id/tune",
    zValidator("param", IdParamSchema),
    zValidator("json", LapTuneSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { tuneId } = c.req.valid("json");
      const updated = await updateLapTune(id, tuneId);
      if (!updated) return c.json({ error: "Lap not found" }, 404);
      return c.json({ success: true });
    }
  );

