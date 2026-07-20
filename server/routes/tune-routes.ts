import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "fs";
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
import {
  getLapById,
  getLapsForTuningSession,
  getImportableLapsForTuningSession,
  importLapsToTuningSession,
} from "../db/queries";
import { getAccSetupFolderKeys, getAccTrackBySetupFolder } from "../../shared/acc-track-data";
import { getAcEvoSetupFolderKeys, getAcEvoTrackBySetupFolder } from "../../shared/ac-evo-track-data";
import { getAllAccCars } from "../../shared/acc-car-data";
import { getAllAcEvoCars } from "../../shared/ac-evo-car-data";
import { getTrackLengthMeters } from "../../shared/track-data";
import { suggestLapTarget } from "../../shared/lap-target";
import {
  createTuningSession,
  getTuningSession,
  listTuningSessions,
  updateTuningSession,
  setSessionHead,
} from "../db/tuning-session-queries";
import { getActiveTuningSession, setActiveTuningSession } from "../tuning-active";
import { deriveFuelPerLap, deriveTyreWear, type LapMetric } from "../tuning-lap-metrics";
import {
  createTuningTest,
  listTuningTests,
  nextVersion,
  getTuningTest,
  getLapCountsByTest,
  updateTuningTestSetupSnapshot,
  setTuningTestNote,
  setTuningTestNotes,
  deleteTestSubtree,
  restoreTestSubtree,
} from "../db/tuning-test-queries";
import { recordAction, listActions } from "../db/tuning-action-queries";
import { undoLastAction } from "../tuning-undo";
import { detectCorners } from "../corner-detection";
import { telemetryToSymptoms } from "../ai/tune-symptoms";
import { symptomsToIssues } from "../ai/tune-issues";
import { requestTuneIntents } from "../ai/tune-intent";
import { symptomsToIntents } from "../ai/tune-recommend";
import { applyIntents } from "../ai/tune-rules";
import { writeSetupFile } from "../ai/tune-writer";
import { setLiveIssuesEnabled } from "../pipeline";
import { loadSettings } from "../settings";
import { getChatMemory, tuneSessionThreadId, CHAT_RESOURCE_ID, saveChatMessages } from "../ai/chat-agent";
import { getSetupsBaseDir, resolveGuardedSetupFile, captureF1SetupFromLaps, type AccGameId } from "../ai/setup-engineer-context";
import { nextFreeLabel } from "../ai/version-label";
import { resolveLapF1Setup, f1SetupFingerprint, summarizeF1Setup } from "../ai/f1-setup-identity";
import { buildGoogleReasoningProviderOptions } from "../ai/google-provider-options";
import { streamAgentTurnResponse } from "../ai/agent-stream";
import { setupEngineerAgent, buildSetupEngineerSystemPrompt } from "../../mastra/agents/setup-engineer";
import { RequestContext } from "@mastra/core/request-context";
import { setupEngineerTurnWorkflow } from "../../mastra/workflows/setup-engineer-turn";
import { getSecret } from "../keystore";
import { MessageList } from "@mastra/core/agent";

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
// getSetupsBaseDir now lives in ../ai/setup-engineer-context so the Setup
// Engineer tools (mastra/tools/setup-engineer.ts) can import just that small
// module instead of this whole route file.

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

const LiveAnalysisSchema = z.object({
  enabled: z.boolean(),
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

const PlaceSetupSchema = z.object({
  gameId: z.enum(["acc", "ac-evo"]),
  // Car folder = the setup's own carName key (e.g. "mclaren_720s_gt3_evo").
  carName: z.string().min(1).max(120),
  // Track folder — driver-chosen (ACC setup JSON carries no track).
  trackName: z.string().min(1).max(120),
  fileName: z.string().min(1).max(160),
  // The dropped setup JSON, as an object or raw string.
  content: z.union([z.string(), z.record(z.string(), z.unknown())]),
});

const TuningSessionQuerySchema = z.object({
  gameId: GameIdSchema,
  includeArchived: z.coerce.boolean().optional().default(false),
});

const CreateTuningSessionSchema = z.object({
  gameId: GameIdSchema,
  name: z.string().min(1).max(120),
  carOrdinal: z.number().int().nullable().optional(),
  trackOrdinal: z.number().int().nullable().optional(),
  carName: z.string().max(200).nullable().optional(),
  trackName: z.string().max(200).nullable().optional(),
  baseSetupPath: z.string().max(1000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const UpdateTuningSessionSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  notes: z.string().max(2000).nullable().optional(),
  baseSetupPath: z.string().max(1000).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const CreateTuningTestSchema = z.object({
  label: z.string().min(1).max(200),
  setupPath: z.string().max(1000).nullable().optional(),
  parentTestId: z.number().int().nullable().optional(),
  // AppliedChange[] from the autotune engine. Kept as an unknown array — the
  // client serialises whatever the engine returned; the server stores it as JSON.
  appliedChanges: z.array(z.unknown()).nullable().optional(),
  driverComment: z.string().max(2000).nullable().optional(),
  engine: z.enum(["rules", "llm"]).nullable().optional(),
});

/** PATCH a single version node — its free-text driver note and/or the
 *  engineer/AI note (independent fields, either or both may be sent). */
const UpdateTuningTestSchema = z.object({
  driverComment: z.string().max(2000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const AddBaseSchema = z.object({
  setupPath: z.string().min(1).max(1000),
  label: z.string().min(1).max(200).optional(),
  setHead: z.boolean().optional(),
});

/** Path params `:id/:testId` — same integer coercion as `IdParamSchema`, for
 *  routes scoped to one setup version within a session (delete/restore). */
const TestParamSchema = z.object({
  id: z
    .string()
    .transform((val) => parseInt(val, 10))
    .refine((n) => Number.isInteger(n), "id must be an integer"),
  testId: z
    .string()
    .transform((val) => parseInt(val, 10))
    .refine((n) => Number.isInteger(n), "testId must be an integer"),
});

/** `?includeDeleted=1` escape hatch (design Phase 8) — everywhere else the
 *  `/tests` list stays trash-free by default. */
const IncludeDeletedQuerySchema = z.object({
  includeDeleted: z.string().optional(),
});


const ImportLapsSchema = z.object({
  lapIds: z.array(z.number().int()).min(1).max(500),
  tuningTestId: z.number().int().nullable().optional(),
});

const AutoTuneSchema = z.object({
  gameId: z.enum(["acc", "ac-evo"]),
  stintId: z.number().int(),
  // Required: ACC/AC-EVO only expose setups the driver saved in-game, and the
  // recommendation applies changes relative to that base setup. No base setup,
  // no meaningful recommendation — the caller must pick or create one first.
  filePath: z.string().min(1),
  trackName: z.string().optional(),
  // When true, compute symptoms/intents/applied without writing to disk.
  preview: z.boolean().optional().default(false),
  // Filename (without path) for the written setup. Sanitised server-side.
  // When omitted, the source name + "-autotune" is used.
  saveAsName: z.string().min(1).max(120).optional(),
  // Live auto mode: overwrite the named file in place (single reload target)
  // instead of writing a fresh, auto-incremented file.
  overwrite: z.boolean().optional().default(false),
  // Recommendation engine. "rules" (default) is the deterministic, LLM-free
  // path (tune-recommend.ts); "llm" keeps requestTuneIntents as an opt-in
  // second opinion. Default rules — the local model 400s and rules need no key.
  engine: z.enum(["rules", "llm"]).optional().default("rules"),
  // Optional free-text driver feel; biases the deterministic engine, appended
  // verbatim to the LLM prompt path. Capped to keep the payload small.
  driverNotes: z.string().max(500).optional(),
});

const TuneChatBodySchema = z.object({
  messages: z.array(z.any()),
  // Compact text summary of whatever lap review the driver currently has open
  // in the Review Laps dashboard (client's TuneReviewDashboard), rebuilt on
  // every lap switch and resent with every turn — lets the agent see exactly
  // what the driver is looking at without a tool round-trip. Capped well
  // above the builder's realistic output (a handful of sectors/corners/issues
  // renders to a few hundred bytes) as a defensive payload-size guard.
  extendedContext: z.string().max(8000).optional(),
});

// Setup-file guard, session-symptom, and applied-changes-markdown helpers
// (formerly local) now live in ../ai/setup-engineer-context — the Setup
// Engineer tools (mastra/tools/setup-engineer.ts) share the exact same
// implementations via loadActiveTuningContext, so /chat and the tools can't
// disagree about what "the active setup" is.

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

  // GET /api/tunes/setup-files?gameId=acc — list saved setup .json files under
  // the user's Documents/Assetto Corsa Competizione/Setups (or AC EVO).
  // MUST be registered before /api/tunes/:id or that route swallows it.
  .get("/api/tunes/setup-files",
    zValidator("query", z.object({ gameId: z.enum(["acc", "ac-evo"]) })),
    async (c) => {
      const { gameId } = c.req.valid("query");
      // Canonical track roster for this game, data-driven from tracks.csv
      // (setupFolder column) — the "place a dropped setup" track picker.
      const tracks = gameId === "acc" ? getAccSetupFolderKeys() : getAcEvoSetupFolderKeys();
      // Friendly display name per setup-folder key (e.g. "barcelona" → "Barcelona"),
      // resolved from tracks.csv. Falls back to the key for anything not in the CSV.
      const trackByKey = gameId === "acc" ? getAccTrackBySetupFolder : getAcEvoTrackBySetupFolder;
      const trackNames: Record<string, string> = {};
      for (const key of tracks) {
        const t = trackByKey(key);
        // Include the variant (GP / Indy / …) so layout variants of the same
        // circuit (e.g. Brands Hatch GP vs Indy) don't collapse to one label.
        trackNames[key] = t ? (t.variant ? `${t.name} ${t.variant}` : t.name) : key;
      }
      // Canonical car roster (model slug + friendly name) from cars.csv, so the
      // picker can offer every car — not only ones the driver already saved a
      // setup for — and show the friendly name instead of the raw slug.
      const cars = (gameId === "acc" ? getAllAccCars() : getAllAcEvoCars())
        .map((car) => ({ model: car.model, name: car.name }));
      const baseDir = await getSetupsBaseDir(gameId);
      if (!baseDir) {
        return c.json({ baseDir: null, files: [], tracks, trackNames, cars, error: "Setups folder not found" });
      }
      return c.json({ baseDir, files: listSetupFiles(baseDir), tracks, trackNames, cars });
    }
  )

  // POST /api/tunes/place-setup — write a dropped setup into the user's Setups
  // folder (Setups/<car>/<track>/<file>.json) so it becomes a usable base, instead
  // of rejecting files that aren't already saved in-game. car/track/file are
  // sanitised to single path segments so the write can't escape the Setups dir.
  .post("/api/tunes/place-setup",
    zValidator("json", PlaceSetupSchema),
    async (c) => {
      const body = c.req.valid("json");
      const baseDir = await getSetupsBaseDir(body.gameId);
      if (!baseDir) return c.json({ error: "Setups folder not found" }, 404);

      // Sanitise each path segment: no separators, no traversal, no reserved chars.
      const clean = (s: string) => s.replace(/[<>:"/\\|?* -]/g, "").trim();
      const car = clean(body.carName);
      const track = clean(body.trackName);
      let file = clean(body.fileName);
      if (!file.toLowerCase().endsWith(".json")) file += ".json";
      const bad = (s: string) => !s || s === "." || s === "..";
      if (bad(car) || bad(track) || bad(file.replace(/\.json$/i, ""))) {
        return c.json({ error: "Invalid car, track, or file name" }, 400);
      }

      // Validate/normalise the setup JSON.
      let json: unknown;
      try {
        json = typeof body.content === "string" ? JSON.parse(body.content) : body.content;
      } catch (err: any) {
        return c.json({ error: `Invalid setup JSON: ${err.message}` }, 400);
      }

      const realBase = realpathSync(resolve(baseDir));
      const trackDir = resolve(realBase, car, track);
      const target = resolve(trackDir, file);
      // Defence in depth: the resolved target must stay under the Setups dir.
      if (!(target + sep).startsWith(realBase + sep)) {
        return c.json({ error: "Resolved path escapes the Setups folder" }, 400);
      }

      // Don't clobber an existing setup — reuse it if the same name is already there.
      if (existsSync(target)) {
        return c.json({ absolutePath: target, carModel: car, trackName: track, fileName: file, placed: false });
      }
      try {
        mkdirSync(trackDir, { recursive: true });
        writeFileSync(target, JSON.stringify(json, null, 2), "utf-8");
      } catch (err: any) {
        return c.json({ error: `Couldn't write setup: ${err.message}` }, 500);
      }
      return c.json({ absolutePath: target, carModel: car, trackName: track, fileName: file, placed: true }, 201);
    }
  )

  // GET /api/tunes/:id — get single tune. Registered AFTER the static
  // /api/tunes/* GET routes (e.g. setup-files) so it doesn't swallow them.
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

      // Always compute the deterministic recommendation — it's pure and cheap.
      // In rules mode it's the answer; in llm mode it rides along as an
      // LLM-free second opinion the UI can show next to the model's picks.
      const rulesIntents = symptomsToIntents(symptoms, body.gameId, { driverNotes: body.driverNotes });

      let intents;
      let model: string;
      let llmFreeIntents: typeof rulesIntents | null = null;
      if (body.engine === "llm") {
        try {
          const res = await requestTuneIntents(body.gameId, symptoms, body.trackName);
          // res.intents is the full TuneIntentsSchema shape ({summary, intents});
          // the route (and AutoTunePanel) only wants the flat intent list.
          intents = res.intents.intents;
          model = res.model;
        } catch (err: any) {
          return c.json({ error: err?.message ?? "AI request failed" }, 502);
        }
        llmFreeIntents = rulesIntents;
      } else {
        // Deterministic path — no provider, no key, no network. This is the
        // default one-button flow.
        intents = rulesIntents;
        model = "rules";
      }

      // Without a source setup we can only surface the recommended intents;
      // apply/skip and disk writes require a setup to modify.
      if (!hasSetup) {
        return c.json({
          symptoms, intents, rulesIntents: llmFreeIntents, applied: [], skipped: [], model,
          written: null, preview: true, hasSetup: false,
        });
      }

      const { setup, applied, skipped } = applyIntents(body.gameId, sourceSetup, intents);

      // 4. Write the result unless this is a preview.
      let written = null;
      if (!body.preview) {
        try {
          written = writeSetupFile(baseDir!, realPath!, setup, body.saveAsName, body.overwrite);
        } catch (err: any) {
          return c.json({ error: `Write failed: ${err.message}` }, 500);
        }
      }

      return c.json({ symptoms, intents, rulesIntents: llmFreeIntents, applied, skipped, model, written, preview: !!body.preview, hasSetup: true });
    }
  )

  // GET /api/laps/:id/issues — per-lap tune issue feed, derived the same way
  // as /api/tunes/auto's symptoms step (corners → symptoms → issues) but
  // without needing a setup file. Legacy laps with no stored telemetry (or
  // too little of it) return an empty feed rather than erroring.
  .get("/api/laps/:id/issues",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);

      const packets = lap.telemetry;
      if (packets.length < 30) return c.json([]);

      const corners = detectCorners(packets);
      const symptoms = telemetryToSymptoms(packets, corners);
      const issues = symptomsToIssues(symptoms, lap.lapNumber);
      return c.json(issues);
    }
  )

  // POST /api/live-analysis — toggle the pipeline's live transient issue
  // detector (Phase 4). Off by default: costs nothing extra per packet and
  // omits _liveIssues from the WS broadcast entirely.
  .post("/api/live-analysis",
    zValidator("json", LiveAnalysisSchema),
    async (c) => {
      const { enabled } = c.req.valid("json");
      setLiveIssuesEnabled(enabled);
      return c.json({ enabled });
    }
  )

  // ─── Tuning sessions (Setup Engineer front door, plan §6a) ─────────────────

  // GET /api/tuning-sessions?gameId= — list the driver's tuning sessions.
  .get("/api/tuning-sessions",
    zValidator("query", TuningSessionQuerySchema),
    async (c) => {
      const { gameId, includeArchived } = c.req.valid("query");
      return c.json(await listTuningSessions(gameId, { includeArchived }));
    }
  )

  // POST /api/tuning-sessions — create a session (from a base setup or a
  // live/recorded session seed; car/track supplied as names or ordinals).
  // Seeds the v1 "base" tuning test from baseSetupPath when one was supplied.
  .post("/api/tuning-sessions",
    zValidator("json", CreateTuningSessionSchema),
    async (c) => {
      const body = c.req.valid("json");
      const id = await createTuningSession(body);
      // Seed v1 "base" only when the session was created from a base setup —
      // an ordinal-seeded session has no setup file to version yet.
      if (body.baseSetupPath) {
        const baseTestId = await createTuningTest({
          tuningSessionId: id,
          version: 1,
          label: "base",
          setupPath: body.baseSetupPath,
          engine: null,
        });
        await setSessionHead(id, baseTestId);
      }
      const created = await getTuningSession(id);
      return c.json(created, 201);
    }
  )

  // POST /api/tuning-sessions/:id/activate — mark this session as the active
  // tuning session. Every lap recorded from now on is stamped with its id at
  // insert (server/tuning-active.ts + queries.ts::insertLap), so membership is
  // an explicit link independent of race sessionId — the session gathers laps
  // across every stint until deactivated.
  .post("/api/tuning-sessions/:id/activate",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      setActiveTuningSession(id);
      return c.json({ active: getActiveTuningSession() });
    }
  )

  // POST /api/tuning-sessions/:id/deactivate — clear the active tuning session,
  // but only if THIS id is the one currently active (so a stale unmount from an
  // old workspace can't clobber a session the driver has since switched to).
  .post("/api/tuning-sessions/:id/deactivate",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      if (getActiveTuningSession() === id) setActiveTuningSession(null);
      return c.json({ active: getActiveTuningSession() });
    }
  )

  // GET /api/tuning-sessions/:id/tests — the setup versions under evaluation
  // in this session (v1 base → latest), oldest-first.
  .get("/api/tuning-sessions/:id/tests",
    zValidator("param", IdParamSchema),
    zValidator("query", IncludeDeletedQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { includeDeleted } = c.req.valid("query");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const tests = await listTuningTests(id, { includeDeleted: includeDeleted === "1" });
      const counts = await getLapCountsByTest(id);
      return c.json(
        tests.map((t) => ({
          ...t,
          lapCount: counts.get(t.id)?.lapCount ?? 0,
          bestLapMs: counts.get(t.id)?.bestLapMs ?? null,
        }))
      );
    }
  )

  // POST /api/tuning-sessions/:id/tests — record a new setup version, typically
  // from a Save & recommend result (the written setup file + applied diff).
  .post("/api/tuning-sessions/:id/tests",
    zValidator("param", IdParamSchema),
    zValidator("json", CreateTuningTestSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const body = c.req.valid("json");
      const version = await nextVersion(id);
      const testId = await createTuningTest({
        tuningSessionId: id,
        version,
        label: body.label,
        setupPath: body.setupPath ?? null,
        parentTestId: body.parentTestId ?? null,
        appliedChanges: body.appliedChanges ? JSON.stringify(body.appliedChanges) : null,
        driverComment: body.driverComment ?? null,
        engine: body.engine ?? null,
      });
      const tests = await listTuningTests(id);
      const created = tests.find((t) => t.id === testId);
      return c.json(created, 201);
    }
  )

  // PATCH /api/tuning-sessions/:id/tests/:testId — edit a single version node's
  // free-text driver note (per-node annotation). Undoable via "edit-test-note".
  .patch("/api/tuning-sessions/:id/tests/:testId",
    zValidator("param", TestParamSchema),
    zValidator("json", UpdateTuningTestSchema),
    async (c) => {
      const { id, testId } = c.req.valid("param");
      const body = c.req.valid("json");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const test = await getTuningTest(testId);
      if (!test || test.tuningSessionId !== id) {
        return c.json({ error: "Version not found in this session" }, 404);
      }

      if (body.driverComment !== undefined) {
        const note = body.driverComment === "" ? null : body.driverComment;
        const prev = await setTuningTestNote(testId, note);
        try {
          await recordAction(id, "edit-test-note", { testId, prevDriverComment: prev });
        } catch (err: any) {
          console.error("[tune] Failed to log edit-test-note action:", err?.message);
        }
      }

      if (body.notes !== undefined) {
        const notes = body.notes === "" ? null : body.notes;
        const prev = await setTuningTestNotes(testId, notes);
        try {
          await recordAction(id, "edit-test-notes", { testId, prevNotes: prev });
        } catch (err: any) {
          console.error("[tune] Failed to log edit-test-notes action:", err?.message);
        }
      }

      return c.json(await getTuningTest(testId));
    }
  )

  // POST /api/tuning-sessions/:id/tests/:testId/delete — soft-delete a version
  // and its whole descendant subtree (design Phase 8). Reversible: status
  // flips to 'deleted' rather than removing rows, so the /restore route below
  // can flip it back. If the session head was inside the trashed subtree, it's
  // moved to the nearest surviving ancestor (or cleared, falling back to the
  // mainline tip via resolveActiveTestId).
  .post("/api/tuning-sessions/:id/tests/:testId/delete",
    zValidator("param", TestParamSchema),
    async (c) => {
      const { id, testId } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const test = await getTuningTest(testId);
      if (!test || test.tuningSessionId !== id) {
        return c.json({ error: "Version not found in this session" }, 404);
      }
      if (test.status === "deleted") {
        return c.json({ error: "Version is already deleted" }, 400);
      }

      const result = await deleteTestSubtree(id, testId, session.headTestId ?? null);

      try {
        await recordAction(id, "delete", {
          rootTestId: testId,
          testIds: result.deletedIds,
          prevHeadTestId: result.headMoved ? result.prevHeadTestId : null,
        });
      } catch (err: any) {
        console.error("[tune] Failed to log delete action:", err?.message);
      }

      try {
        const extra = result.deletedIds.length - 1;
        await saveChatMessages(tuneSessionThreadId(id), [
          { role: "user", markdown: `Delete **${test.label}** (v${test.version}) and its branch.` },
          {
            role: "assistant",
            markdown: `Deleted **${test.label}** (v${test.version})${extra > 0 ? ` and ${extra} child version${extra === 1 ? "" : "s"}` : ""} — restorable from the trash.`,
          },
        ]);
      } catch (err: any) {
        console.error("[tune] Failed to post delete note:", err?.message);
      }

      return c.json({ ok: true, deletedIds: result.deletedIds, headTestId: result.newHeadTestId });
    }
  )

  // POST /api/tuning-sessions/:id/tests/:testId/restore — flip a soft-deleted
  // subtree back to 'active' (design Phase 8's reversible half). Only nodes
  // currently 'deleted' within the target's subtree are restored.
  .post("/api/tuning-sessions/:id/tests/:testId/restore",
    zValidator("param", TestParamSchema),
    async (c) => {
      const { id, testId } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const test = await getTuningTest(testId);
      if (!test || test.tuningSessionId !== id) {
        return c.json({ error: "Version not found in this session" }, 404);
      }
      if (test.status !== "deleted") {
        return c.json({ error: "Version is not deleted" }, 400);
      }

      const restoredIds = await restoreTestSubtree(id, testId);

      try {
        await recordAction(id, "restore", { rootTestId: testId, testIds: restoredIds });
      } catch (err: any) {
        console.error("[tune] Failed to log restore action:", err?.message);
      }

      try {
        const extra = restoredIds.length - 1;
        await saveChatMessages(tuneSessionThreadId(id), [
          { role: "user", markdown: `Restore **${test.label}** (v${test.version}) from the trash.` },
          {
            role: "assistant",
            markdown: `Restored **${test.label}** (v${test.version})${extra > 0 ? ` and ${extra} child version${extra === 1 ? "" : "s"}` : ""}.`,
          },
        ]);
      } catch (err: any) {
        console.error("[tune] Failed to post restore note:", err?.message);
      }

      const restored = (await listTuningTests(id, { includeDeleted: true })).find((t) => t.id === testId);
      return c.json(restored, 200);
    }
  )

  // POST /api/tuning-sessions/:id/bases — add a second (or Nth) root to the
  // session's version forest from an existing Setups-folder file (design
  // Phase 4). Unlike branch/apply, the new node has parentTestId=null — it's
  // a fresh starting point, not a fork of anything already in the tree.
  // Posts the same kind of canned chat ack /head uses so the agent keeps
  // context on reload.
  .post("/api/tuning-sessions/:id/bases",
    zValidator("param", IdParamSchema),
    zValidator("json", AddBaseSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const body = c.req.valid("json");
      const guarded = await resolveGuardedSetupFile(session.gameId as AccGameId, body.setupPath);
      if (!guarded.ok) return c.json({ error: guarded.error }, guarded.status);

      const tests = await listTuningTests(id);
      const takenLabels = new Set(tests.map((t) => t.label));
      const label = nextFreeLabel(body.label ?? "base", takenLabels);

      const version = await nextVersion(id);
      const testId = await createTuningTest({
        tuningSessionId: id,
        version,
        label,
        setupPath: guarded.realPath,
        parentTestId: null,
        engine: null,
      });

      const prevHeadTestId = session.headTestId ?? null;
      if (body.setHead) await setSessionHead(id, testId);

      try {
        await recordAction(id, "add-base", { testId, prevHeadTestId: body.setHead ? prevHeadTestId : null });
      } catch (err: any) {
        console.error("[tune] Failed to log add-base action:", err?.message);
      }

      try {
        await saveChatMessages(tuneSessionThreadId(id), [
          { role: "user", markdown: `Add **${label}** (v${version}) as a new base.` },
          {
            role: "assistant",
            markdown: body.setHead
              ? `Added **${label}** (v${version}) as a new base and switched to it — I'll work from here.`
              : `Added **${label}** (v${version}) as a new base.`,
          },
        ]);
      } catch (err: any) {
        console.error("[tune] Failed to post add-base note:", err?.message);
      }

      const created = (await listTuningTests(id)).find((t) => t.id === testId);
      return c.json(created, 201);
    }
  )

  // POST /api/tuning-sessions/:id/capture-setup — F1's "Add base" affordance
  // (design Phase 10): F1 has no setup file to pick, so capture the current
  // `F1CarSetup` from the session's most recent lap's telemetry and stamp it
  // onto the active test (or a fresh base when the session has none yet).
  .post("/api/tuning-sessions/:id/capture-setup",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      if (session.gameId !== "f1-2025") {
        return c.json({ error: "Setup capture is only available for F1 2025 sessions" }, 400);
      }

      const captured = await captureF1SetupFromLaps(id);
      if (!captured) {
        return c.json({ error: "No lap with F1 setup telemetry found yet — drive a lap first." }, 400);
      }

      const tests = await listTuningTests(id);
      const activeTest = session.headTestId != null
        ? (tests.find((t) => t.id === session.headTestId) ?? (tests.length ? tests[tests.length - 1]! : null))
        : (tests.length ? tests[tests.length - 1]! : null);

      let testId: number;
      let label: string;
      let version: number;
      if (activeTest) {
        await updateTuningTestSetupSnapshot(activeTest.id, captured);
        testId = activeTest.id;
        label = activeTest.label;
        version = activeTest.version;
      } else {
        const takenLabels = new Set(tests.map((t) => t.label));
        label = nextFreeLabel("base", takenLabels);
        version = await nextVersion(id);
        testId = await createTuningTest({
          tuningSessionId: id,
          version,
          label,
          setupSnapshot: captured,
          parentTestId: null,
          engine: null,
        });
        await setSessionHead(id, testId);
      }

      try {
        await saveChatMessages(tuneSessionThreadId(id), [
          { role: "user", markdown: `Capture current car setup.` },
          { role: "assistant", markdown: `Captured the current setup into **${label}** (v${version}) from telemetry.` },
        ]);
      } catch (err: any) {
        console.error("[tune] Failed to post capture-setup note:", err?.message);
      }

      const updated = (await listTuningTests(id)).find((t) => t.id === testId);
      return c.json(updated, 200);
    }
  )

  // GET /api/tuning-sessions/:id/importable-laps — "Add laps from history"
  // (design Phase 6): laps matching this session's game + car + track that
  // aren't already stamped to any tuning session.
  .get("/api/tuning-sessions/:id/importable-laps",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const importable = await getImportableLapsForTuningSession(
        session.gameId as GameId,
        session.carOrdinal ?? null,
        session.trackOrdinal ?? null
      );

      if (session.gameId !== "f1-2025") {
        return c.json(importable);
      }

      // F1 only: attach setup fingerprint/summary so the import modal can
      // group laps by setup. Avoid loading telemetry for laps that already
      // have a `carSetup` snapshot — only null-carSetup laps pay that cost.
      const enriched = await Promise.all(
        importable.map(async (lap) => {
          let setup = resolveLapF1Setup({ carSetup: lap.carSetup ?? null });
          if (!setup && !lap.carSetup) {
            const full = await getLapById(lap.id);
            if (full) setup = resolveLapF1Setup({ carSetup: full.carSetup ?? null, telemetry: full.telemetry });
          }
          return {
            ...lap,
            setupFingerprint: setup ? f1SetupFingerprint(setup) : null,
            setupSummary: setup ? summarizeF1Setup(setup) : null,
          };
        })
      );
      return c.json(enriched);
    }
  )

  // POST /api/tuning-sessions/:id/import-laps — stamp a batch of history laps
  // onto this session (and optionally a specific branch/test), attaching them
  // to the aggregate the same way live-collected laps are. Posts a canned
  // chat ack so the agent picks the newly attached laps up on reload.
  .post("/api/tuning-sessions/:id/import-laps",
    zValidator("param", IdParamSchema),
    zValidator("json", ImportLapsSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const body = c.req.valid("json");

      if (session.gameId !== "f1-2025") {
        if (body.tuningTestId != null) {
          const test = await getTuningTest(body.tuningTestId);
          if (!test || test.tuningSessionId !== id) {
            return c.json({ error: "Tuning test not found in this session" }, 404);
          }
        }

        const importedIds = await importLapsToTuningSession(
          id,
          body.lapIds,
          body.tuningTestId ?? null
        );

        try {
          await recordAction(id, "import-laps", { lapIds: importedIds });
        } catch (err: any) {
          console.error("[tune] Failed to log import-laps action:", err?.message);
        }

        try {
          await saveChatMessages(tuneSessionThreadId(id), [
            {
              role: "user",
              markdown: `Import ${body.lapIds.length} lap${body.lapIds.length === 1 ? "" : "s"} from history.`,
            },
            {
              role: "assistant",
              markdown: `Imported ${importedIds.length} lap${importedIds.length === 1 ? "" : "s"} from history${
                body.tuningTestId != null ? " into the selected version" : " into the session baseline"
              }.`,
            },
          ]);
        } catch (err: any) {
          console.error("[tune] Failed to post import-laps note:", err?.message);
        }

        return c.json({ importedIds }, 201);
      }

      // F1: auto-sort laps into setups by fingerprint — body.tuningTestId is
      // ignored, each lap's own carSetup decides where it lands.
      const existingTests = await listTuningTests(id);
      const fpToTestId = new Map<string, number>();
      for (const t of existingTests) {
        if (!t.setupSnapshot) continue;
        try {
          const snap = JSON.parse(t.setupSnapshot);
          fpToTestId.set(f1SetupFingerprint(snap), t.id);
        } catch {
          // ignore malformed snapshot
        }
      }
      const takenLabels = new Set(existingTests.map((t) => t.label));

      // group key: testId (existing/newly-created) or null for baseline
      const groups = new Map<number | null, number[]>();
      for (const lapId of body.lapIds) {
        const full = await getLapById(lapId);
        if (!full) continue;
        const setup = resolveLapF1Setup({ carSetup: full.carSetup ?? null, telemetry: full.telemetry });

        let targetTestId: number | null;
        if (!setup) {
          targetTestId = null;
        } else {
          const fp = f1SetupFingerprint(setup);
          const existing = fpToTestId.get(fp);
          if (existing != null) {
            targetTestId = existing;
          } else {
            const version = await nextVersion(id);
            const label = nextFreeLabel("import", takenLabels);
            takenLabels.add(label);
            const newTestId = await createTuningTest({
              tuningSessionId: id,
              version,
              label,
              parentTestId: null,
              setupSnapshot: JSON.stringify(setup),
              engine: null,
            });
            fpToTestId.set(fp, newTestId);
            targetTestId = newTestId;
          }
        }

        const group = groups.get(targetTestId);
        if (group) group.push(lapId);
        else groups.set(targetTestId, [lapId]);
      }

      const importedIds: number[] = [];
      let bestGroupTestId: number | null | undefined;
      let bestGroupCount = -1;
      for (const [targetTestId, groupLapIds] of groups) {
        const ids = await importLapsToTuningSession(id, groupLapIds, targetTestId);
        importedIds.push(...ids);
        if (ids.length > bestGroupCount) {
          bestGroupCount = ids.length;
          bestGroupTestId = targetTestId;
        }
      }

      if (session.headTestId == null && bestGroupTestId != null && bestGroupCount > 0) {
        try {
          await setSessionHead(id, bestGroupTestId);
        } catch (err: any) {
          console.error("[tune] Failed to set session head after import:", err?.message);
        }
      }

      try {
        await recordAction(id, "import-laps", { lapIds: importedIds });
      } catch (err: any) {
        console.error("[tune] Failed to log import-laps action:", err?.message);
      }

      const distinctSetupCount = groups.size;
      try {
        await saveChatMessages(tuneSessionThreadId(id), [
          {
            role: "user",
            markdown: `Import ${body.lapIds.length} lap${body.lapIds.length === 1 ? "" : "s"} from history.`,
          },
          {
            role: "assistant",
            markdown: `Imported ${importedIds.length} lap${importedIds.length === 1 ? "" : "s"}, sorted into ${distinctSetupCount} setup${
              distinctSetupCount === 1 ? "" : "s"
            }.`,
          },
        ]);
      } catch (err: any) {
        console.error("[tune] Failed to post import-laps note:", err?.message);
      }

      return c.json({ importedIds }, 201);
    }
  )

  // POST /api/tuning-sessions/:id/head — check out a setup version as the
  // session's current head. Posts a deterministic canned ack into the chat
  // thread (best-effort) so the Setup Engineer agent keeps context on reload.
  .post("/api/tuning-sessions/:id/head", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid session id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const testId = Number(body?.testId);
    if (!Number.isFinite(testId)) return c.json({ error: "testId is required" }, 400);

    const test = await getTuningTest(testId);
    if (!test || test.tuningSessionId !== id) {
      return c.json({ error: "Version not found in this session" }, 404);
    }

    const session = await getTuningSession(id);
    const prevHeadTestId = session?.headTestId ?? null;
    await setSessionHead(id, testId);

    try {
      await recordAction(id, "set-head", { prevHeadTestId });
    } catch (err: any) {
      console.error("[tune] Failed to log set-head action:", err?.message);
    }

    // Record the checkout as its own user action + deterministic assistant ack
    // (a distinct pair, not merged into the prior turn) so the chat reads as a
    // real exchange and the agent keeps context on reload.
    try {
      await saveChatMessages(tuneSessionThreadId(id), [
        { role: "user", markdown: `Switch head to **${test.label}** (v${test.version}).` },
        {
          role: "assistant",
          markdown: `Switched to **${test.label}** (v${test.version}) as the current setup — I'll work from here.`,
        },
      ]);
    } catch (err: any) {
      console.error("[tune] Failed to post checkout note:", err?.message);
    }

    return c.json({ ok: true, headTestId: testId, label: test.label });
  })

  // GET /api/tuning-sessions/:id/actions — session action log, newest-first
  // (design Phase 9), for the History panel. Tiny rows (refs only), so the
  // whole session depth is returned unpaginated.
  .get("/api/tuning-sessions/:id/actions",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      return c.json(await listActions(id));
    }
  )

  // POST /api/tuning-sessions/:id/undo — reverse the newest not-yet-undone
  // action (design Phase 9). Applies the kind-specific inverse via
  // `undoLastAction` (shared with the AI's `undo_last_action` tool),
  // idempotent — a second call with nothing left pending is a no-op ok:true.
  .post("/api/tuning-sessions/:id/undo",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const result = await undoLastAction(id);

      if (result.undone) {
        try {
          await saveChatMessages(tuneSessionThreadId(id), [
            { role: "user", markdown: "Undo the last action." },
            {
              role: "assistant",
              markdown: result.warning ? `Undone — ${result.warning}` : `Undone (${result.kind}).`,
            },
          ]);
        } catch (err: any) {
          console.error("[tune] Failed to post undo note:", err?.message);
        }
      }

      return c.json(result);
    }
  )

  // GET /api/tuning-sessions/:id/lap-metrics — per-lap fuel/tyre metrics for the
  // laps this session owns (plan §2, Phase C). Derived server-side from each
  // lap's raw telemetry frames; returns a compact per-lap summary, not frame
  // dumps. Legacy laps with no stored telemetry omit their metric (never 0).
  // Tyre wear is the worst-tyre % worn at lap end, derived from the game's per-
  // tyre wear channel (see server/tuning-lap-metrics.ts); omitted when absent.
  .get("/api/tuning-sessions/:id/lap-metrics",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      // Same lap pool the workspace uses: laps explicitly linked to this tuning
      // session (migration v25), independent of race sessionId.
      const sessionLaps = await getLapsForTuningSession(id);

      const metrics: LapMetric[] = [];
      for (const lapMeta of sessionLaps) {
        const lap = await getLapById(lapMeta.id);
        const fuelPerLap = lap ? deriveFuelPerLap(lap.telemetry) : undefined;
        const tyreWear = lap ? deriveTyreWear(lap.telemetry) : undefined;
        const entry: LapMetric = { lapId: lapMeta.id };
        if (fuelPerLap != null) entry.fuelPerLap = fuelPerLap;
        if (tyreWear != null) entry.tyreWear = tyreWear;
        metrics.push(entry);
      }
      return c.json(metrics);
    }
  )

  // ─── Setup chat (plan §3, Phase 2) — a tool-using Setup Engineer agent, built
  //     fresh per request and bound to this session via closures (no shared
  //     mutable state, no runtimeContext). Its 5 tools (get_current_setup,
  //     get_symptoms, get_version_history, preview_change, apply_changes) are
  //     the ONLY action space: the model can't recommend or apply a knob the
  //     tools don't expose, and preview/apply always return the real
  //     deterministic result. apply_changes IS the old generate-from-chat path
  //     — the driver confirms in chat and the model calls it, instead of a
  //     separate endpoint. Same Mastra memory store + NDJSON stream + thread
  //     `tune-session-<id>` the previous monolithic-prompt chat used.

  // GET /api/tuning-sessions/:id/chat — thread history.
  //
  // Returns full AI-SDK v5 UIMessages (id/role/parts/metadata) instead of
  // flattened text, so a page reload restores tool-call/tool-result groups
  // and the token-usage footer exactly like a live turn does. `memory.recall`
  // only gives back the raw MastraDBMessage[] (DB shape); a MessageList is
  // Mastra's own converter from that DB shape to AI SDK v5 UIMessage shape —
  // same converter `toAISdkStream`/the agent use internally — so tool parts
  // (stored as MastraToolInvocationPart in content.parts) and any persisted
  // content.metadata (incl. usage, when present) round-trip faithfully rather
  // than being reconstructed by hand.
  .get("/api/tuning-sessions/:id/chat",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const memory = getChatMemory();
        const threadId = tuneSessionThreadId(id);
        const thread = await memory.getThreadById({ threadId });
        if (!thread) return c.json({ messages: [] });
        const result = await memory.recall({ threadId });
        const raw = result.messages ?? [];

        const list = new MessageList({ threadId, resourceId: CHAT_RESOURCE_ID });
        list.add(raw, "memory");
        const uiMessages = list.get.all.aiV5
          .ui()
          .filter((m) => m.role === "user" || m.role === "assistant");

        return c.json({ messages: uiMessages });
      } catch (err: any) {
        console.error("[TuneChat] Failed to load messages:", err.message);
        return c.json({ messages: [] });
      }
    }
  )

  // POST /api/tuning-sessions/:id/chat — send a message (streaming NDJSON).
  // Builds a fresh Setup Engineer Agent bound to this session's tools; the
  // agent decides for itself when to call get_current_setup / get_symptoms /
  // get_version_history / preview_change, and calls apply_changes once the
  // driver confirms (replacing the old separate generate-from-chat POST).
  .post("/api/tuning-sessions/:id/chat",
    zValidator("param", IdParamSchema),
    zValidator("json", TuneChatBodySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { messages, extendedContext } = c.req.valid("json");

      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const gameId = session.gameId as GameId;
      if (gameId !== "acc" && gameId !== "ac-evo" && gameId !== "f1-2025") {
        return c.json({ error: "The setup engineer only supports ACC, AC-EVO and F1 2025" }, 400);
      }

      // The Setup Engineer is now a shared singleton agent; per-session context
      // (car/track/sessionId the tools must receive) is injected per request as
      // a system message via buildSetupEngineerSystemPrompt.
      const agent = setupEngineerAgent;
      const sessionSystemPrompt = buildSetupEngineerSystemPrompt({
        gameId,
        sessionId: id,
        carName: session.carName,
        trackName: session.trackName,
        sessionName: session.name,
      });

      // Deterministic prerequisite gathering — force the read side (setup,
      // symptoms, track conditions, history) via the registered Mastra workflow
      // so the model always has current context and never has to call a read
      // tool or supply a session id. Studio-observable.
      const reqCtx = new RequestContext();
      reqCtx.set("gameId", gameId);
      reqCtx.set("sessionId", id);
      let gatheredContext = "";
      try {
        const prereqRun = await setupEngineerTurnWorkflow.createRun();
        const prereqResult = await prereqRun.start({ inputData: { sessionId: id }, requestContext: reqCtx });
        if (prereqResult.status === "success") gatheredContext = prereqResult.result.context;
      } catch (err: any) {
        console.error("[SetupEngineer] prereq workflow failed:", err?.message);
      }

      // Provider/key/model plumbing — inlined from startChatStream (see
      // ../ai/chat-stream.ts) since this route no longer uses the shared
      // NDJSON helper (assistant-ui speaks the AI SDK v5 UI-message-stream
      // protocol instead). Keep this block in sync with chat-stream.ts if
      // the provider matrix changes.
      const settings = loadSettings();
      const chatProvider = settings.chatProvider;
      if (chatProvider === "gemini") {
        const key = await getSecret("gemini-api-key");
        if (!key) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Chat." }, 400);
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
        delete process.env.OPENAI_BASE_URL;
      } else if (chatProvider === "openai") {
        const key = await getSecret("openai-api-key");
        if (!key) return c.json({ error: "OpenAI API key not set. Add it in Settings → AI Chat." }, 400);
        process.env.OPENAI_API_KEY = key;
        delete process.env.OPENAI_BASE_URL;
      } else if (chatProvider === "local") {
        process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
        process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
      }

      // Same model-label fallback chain chat-stream.ts uses, so thinking support
      // is detected off the model that will actually run.
      const chatModelLabel = settings.chatModel
        || (chatProvider === "openai"
          ? "gpt-4o-mini"
          : chatProvider === "local"
            ? "local-model"
            : "gemini-flash-latest");

      // Captured before the turn runs so the onFinish reasoning-patch below can
      // tell *this* turn's freshly-saved assistant row apart from any earlier
      // one (Mastra stamps createdAt at save time, so the new row's createdAt is
      // always >= this) — avoids racing/patching a previous turn's message.
      const turnStartedAt = Date.now();

      // System prompt segments, additive: session identity, deterministic
      // prereq-gathered context (setup/symptoms/history), then whatever lap
      // review the driver currently has open on screen (if any) — so the
      // agent's picture matches what the driver is looking at this turn.
      const systemSegments = [sessionSystemPrompt];
      if (gatheredContext) systemSegments.push(gatheredContext);
      if (extendedContext) systemSegments.push(extendedContext);

      const stream = await agent.stream(
        [{ role: "system", content: systemSegments.join("\n\n") }, ...messages],
        {
        memory: { thread: tuneSessionThreadId(id), resource: CHAT_RESOURCE_ID },
        requestContext: reqCtx,
        // Ask the model to stream its thought process so the tune chat can show a
        // live "thinking" block that auto-collapses once the reply text starts
        // (reasoning.tsx drives the collapse off the streamed reasoning parts).
        // toAISdkStream forwards reasoning parts into the UI-message stream by
        // default — the writer loop below relays every part — so enabling
        // reasoning here is the whole server-side wiring. Scoped to this route:
        // the main AiPanel keeps includeThoughts:false.
        providerOptions: {
          openai: { reasoningEffort: "medium" },
          google: buildGoogleReasoningProviderOptions(chatModelLabel, settings.chatThinkingBudget) as never,
        },
      });

      return streamAgentTurnResponse({
        agentStream: stream,
        originalMessages: messages,
        memory: getChatMemory(),
        threadId: tuneSessionThreadId(id),
        turnStartedAt,
      });
    }
  )

  // DELETE /api/tuning-sessions/:id/chat — clear the thread.
  .delete("/api/tuning-sessions/:id/chat",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const memory = getChatMemory();
        await memory.deleteThread(tuneSessionThreadId(id));
      } catch (err: any) {
        console.error("[TuneChat] Failed to clear thread:", err.message);
      }
      return c.json({ ok: true });
    }
  )

  // GET /api/tuning-sessions/:id — one session.
  // Ships a computed `lapTarget` (Phase 5, track-length-aware stint nudge):
  // advisory-only "how many laps is a full stint here", derived from the
  // session's best known lap time, falling back to track length / avg speed,
  // falling back to a fixed default. Decoupled from the confidence model.
  .get("/api/tuning-sessions/:id",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await getTuningSession(id);
      if (!row) return c.json({ error: "Tuning session not found" }, 404);

      const sessionLaps = await getLapsForTuningSession(id);
      const bestLap = sessionLaps.reduce<number | null>((best, l) => {
        if (!l.isValid || l.lapTime <= 0) return best;
        return best == null || l.lapTime < best ? l.lapTime : best;
      }, null);
      const trackLengthM = row.trackOrdinal != null ? getTrackLengthMeters(row.trackOrdinal, row.gameId) : null;
      const lapTarget = suggestLapTarget(bestLap, trackLengthM);

      return c.json({ ...row, lapTarget });
    }
  )

  // PATCH /api/tuning-sessions/:id — rename, note, re-point base setup, archive.
  .patch("/api/tuning-sessions/:id",
    zValidator("param", IdParamSchema),
    zValidator("json", UpdateTuningSessionSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const before = await getTuningSession(id);
      if (!before) return c.json({ error: "Tuning session not found" }, 404);

      const updated = await updateTuningSession(id, body);
      if (!updated) return c.json({ error: "Tuning session not found" }, 404);

      // Only record the prior value of fields this PATCH actually touched, so
      // undo restores exactly what changed rather than clobbering untouched
      // fields with a stale snapshot.
      const inverse: Record<string, unknown> = {};
      if (body.name !== undefined) inverse.name = before.name;
      if (body.notes !== undefined) inverse.notes = before.notes;
      if (body.baseSetupPath !== undefined) inverse.baseSetupPath = before.baseSetupPath;
      if (body.status !== undefined) inverse.status = before.status;
      if (Object.keys(inverse).length > 0) {
        try {
          await recordAction(id, "rename-note", inverse);
        } catch (err: any) {
          console.error("[tune] Failed to log rename-note action:", err?.message);
        }
      }

      return c.json(await getTuningSession(id));
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

