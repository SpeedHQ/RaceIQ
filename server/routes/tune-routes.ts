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

import type { TuneSettings, RaceStrategy, GameId } from "../../shared/types";
import {
  getCommunityTunes,
  getCommunityTuneById,
} from "../db/community-tune-queries";
import { syncCommunityTunes } from "../community-tunes-sync";
import { getLaptimes, syncLaptimes } from "../laptimes-sync";
import { getLapById } from "../db/queries";
import { detectCorners } from "../corner-detection";
import { telemetryToSymptoms } from "../ai/tune-symptoms";
import { requestTuneIntents } from "../ai/tune-intent";
import { applyIntents } from "../ai/tune-rules";
import { writeSetupFile } from "../ai/tune-writer";

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
  source: "community";
  sourceName: string;
  gameId: string;
}

/** Map a community_tunes DB row to the catalog shape the client renders. */
function communityRowToCatalog(row: {
  id: string;
  gameId: string;
  carOrdinal: number;
  trackOrdinal: number | null;
  name: string;
  author: string;
  category: string;
  description: string;
  sourceName: string;
  settings: string;
}): CatalogTune {
  return {
    id: row.id,
    name: row.name,
    author: row.author,
    carOrdinal: row.carOrdinal,
    category: row.category,
    trackOrdinal: row.trackOrdinal ?? undefined,
    description: row.description,
    strengths: [],
    weaknesses: [],
    settings: JSON.parse(row.settings) as TuneSettings,
    source: "community",
    sourceName: row.sourceName,
    gameId: row.gameId,
  };
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
  gameId: GameIdSchema,
  carOrdinal: z.number().int(),
  trackOrdinal: z.number().int(),
  tuneId: z.number().int(),
});

const AssignmentQuerySchema = z.object({
  gameId: GameIdSchema,
});

const LapTuneSchema = z.object({
  tuneId: z.number().int().nullable(),
});

// All CreateTuneSchema fields optional, minus gameId — a tune's game must not
// be changeable via update.
const UpdateTuneSchema = CreateTuneSchema.omit({ gameId: true }).partial();

const ImportFileSchema = z.object({
  gameId: z.enum(["acc", "ac-evo"]),
  filePath: z.string().min(1),
  name: z.string().optional(),
  author: z.string().optional(),
  carOrdinal: z.number().int(),
  category: z.string().optional().default("circuit"),
});

const AutoTuneSchema = z.object({
  gameId: z.enum(["acc", "ac-evo"]),
  stintId: z.number().int(),
  // Optional: when omitted, we still derive symptoms/intents from the lap and
  // return a recommendation, but we can't apply it to a setup or write to disk.
  filePath: z.string().min(1).optional(),
  trackName: z.string().optional(),
  // When true, compute symptoms/intents/applied without writing to disk.
  preview: z.boolean().optional().default(false),
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
    zValidator("json", UpdateTuneSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const existing = await getTuneById(id);
      if (!existing) return c.json({ error: "Tune not found" }, 404);

      const body = c.req.valid("json");
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
    const catalogTune = await getCommunityTuneById(catalogId).then((row) =>
      row ? communityRowToCatalog(row) : undefined,
    );
    if (!catalogTune) return c.json({ error: "Catalog tune not found" }, 404);

    const id = await insertTune({
      gameId: catalogTune.gameId,
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
      if (!realPath.toLowerCase().endsWith(".json")) {
        return c.json({ error: "Only .json setup files can be imported" }, 400);
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

  // POST /api/tunes/auto — auto-tune pipeline: derive symptoms from a stint's
  // telemetry, ask the AI for tune intents, apply them to a source setup file's
  // JSON, and (unless preview) write the result next to the source. Returns the
  // symptoms, intents, and audit trail so the UI can show the reasoning.
  .post("/api/tunes/auto",
    zValidator("json", AutoTuneSchema),
    async (c) => {
      const body = c.req.valid("json");

      // 1. Load the stint's telemetry.
      const lap = await getLapById(body.stintId);
      if (!lap) return c.json({ error: "Stint not found" }, 404);
      const packets = lap.telemetry;
      if (packets.length < 30) {
        return c.json({ error: "Not enough telemetry to analyse this stint" }, 400);
      }

      // 2. Resolve + guard the source setup file (must live under Setups).
      //    The setup file is optional: without one we can still derive a
      //    recommendation from the lap, we just can't apply it or write to disk.
      const hasSetup = !!body.filePath;
      let baseDir: string | null = null;
      let realPath: string | null = null;
      let sourceSetup: any = null;

      if (hasSetup) {
        baseDir = await getSetupsBaseDir(body.gameId);
        if (!baseDir) return c.json({ error: "Setups folder not found" }, 404);
        const absPath = resolve(body.filePath!);
        if (!existsSync(absPath)) return c.json({ error: "Setup file not found" }, 404);

        let realBase: string;
        try {
          realPath = realpathSync(absPath);
          realBase = realpathSync(resolve(baseDir));
        } catch (err: any) {
          if (err?.code === "ENOENT") return c.json({ error: "Setup file not found" }, 404);
          return c.json({ error: `Read failed: ${err.message}` }, 500);
        }
        if (!(realPath + sep).startsWith(realBase + sep)) {
          return c.json({ error: "Path must be inside the Setups folder" }, 400);
        }
        if (!realPath.toLowerCase().endsWith(".json")) {
          return c.json({ error: "Only .json setup files can be auto-tuned" }, 400);
        }

        try { sourceSetup = JSON.parse(readFileSync(realPath, "utf-8")); }
        catch (err: any) { return c.json({ error: `Invalid setup JSON: ${err.message}` }, 400); }
      }

      // 3. Symptoms → intents → applied setup.
      const corners = detectCorners(packets);
      const symptoms = telemetryToSymptoms(packets, corners);

      let intents;
      let model: string;
      try {
        const res = await requestTuneIntents(body.gameId, symptoms, body.trackName);
        intents = res.intents;
        model = res.model;
      } catch (err: any) {
        return c.json({ error: err?.message ?? "AI request failed" }, 502);
      }

      // Without a source setup we can only surface the recommended intents;
      // apply/skip and disk writes require a setup to modify.
      if (!hasSetup) {
        return c.json({
          symptoms, intents, applied: [], skipped: [], model,
          written: null, preview: true, hasSetup: false,
        });
      }

      const { setup, applied, skipped } = applyIntents(body.gameId, sourceSetup, intents);

      // 4. Write the result unless this is a preview.
      let written = null;
      if (!body.preview) {
        try {
          written = writeSetupFile(baseDir!, realPath!, setup);
        } catch (err: any) {
          return c.json({ error: `Write failed: ${err.message}` }, 500);
        }
      }

      return c.json({ symptoms, intents, applied, skipped, model, written, preview: !!body.preview, hasSetup: true });
    }
  )

  // ─── Catalog ─────────────────────────────────────────────────────────────────

  // GET /api/catalog/tunes — community tunes for the game named in the
  // X-Game-Id header (no fm-2023 fallback: without a header, no tunes).
  .get("/api/catalog/tunes",
    zValidator("query", CarOrdinalQuerySchema),
    async (c) => {
      const { carOrdinal } = c.req.valid("query");
      const gameId = c.req.header("x-game-id") as GameId | undefined;

      const communityRows = gameId ? await getCommunityTunes(gameId) : [];
      const tunes = communityRows.map(communityRowToCatalog);

      if (carOrdinal !== undefined) {
        return c.json(tunes.filter((t) => t.carOrdinal === carOrdinal));
      }
      return c.json(tunes);
    }
  )

  // POST /api/tunes/community/refresh — force a CDN sync now
  .post("/api/tunes/community/refresh", async (c) => {
    const result = await syncCommunityTunes({ force: true });
    return c.json(result);
  })

  // GET /api/laptimes — community leaderboard reference lap times for the game
  // named in the X-Game-Id header (no fallback: without a header, no times).
  .get("/api/laptimes", async (c) => {
    const gameId = c.req.header("x-game-id") as GameId | undefined;
    return c.json(gameId ? getLaptimes(gameId) : []);
  })

  // POST /api/laptimes/refresh — force a CDN sync now
  .post("/api/laptimes/refresh", async (c) => {
    const result = await syncLaptimes({ force: true });
    return c.json(result);
  })

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
    zValidator("query", AssignmentQuerySchema),
    async (c) => {
      const { carOrdinal, trackOrdinal } = c.req.valid("param");
      const { gameId } = c.req.valid("query");
      const assignment = await getTuneAssignment(gameId, carOrdinal, trackOrdinal);
      if (!assignment) return c.json({ error: "Assignment not found" }, 404);
      return c.json(assignment);
    }
  )

  // PUT /api/tune-assignments — set/update assignment
  .put("/api/tune-assignments",
    zValidator("json", SetAssignmentSchema),
    async (c) => {
      const { gameId, carOrdinal, trackOrdinal, tuneId } = c.req.valid("json");
      await setTuneAssignment(gameId, carOrdinal, trackOrdinal, tuneId);
      const assignment = await getTuneAssignment(gameId, carOrdinal, trackOrdinal);
      return c.json(assignment);
    }
  )

  // DELETE /api/tune-assignments/:carOrdinal/:trackOrdinal — remove assignment
  .delete("/api/tune-assignments/:carOrdinal/:trackOrdinal",
    zValidator("param", AssignmentParamsSchema),
    zValidator("query", AssignmentQuerySchema),
    async (c) => {
      const { carOrdinal, trackOrdinal } = c.req.valid("param");
      const { gameId } = c.req.valid("query");
      const deleted = await deleteTuneAssignment(gameId, carOrdinal, trackOrdinal);
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

