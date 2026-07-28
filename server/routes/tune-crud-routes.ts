import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { resolve, sep } from "path";
import { IdParamSchema } from "../../shared/schemas";
import { GameIdSchema } from "../../shared/types";
import { insertTune, getTunes, getTuneById, updateTune, deleteTune } from "../db/tune-queries";
import type { GameId } from "../../shared/types";
import { getCommunityTuneById } from "../db/community-tune-queries";
import { getLapById } from "../db/queries";
import { getAccSetupFolderKeys, getAccTrackBySetupFolder } from "../../shared/acc-track-data";
import { getAcEvoSetupFolderKeys, getAcEvoTrackBySetupFolder, getAcEvoSetupFolderAliases } from "../../shared/ac-evo-track-data";
import { getAllAccCars } from "../../shared/acc-car-data";
import { getAllAcEvoCars } from "../../shared/ac-evo-car-data";
import { detectCorners } from "../corner-detection";
import { telemetryToSymptoms } from "../ai/tune-symptoms";
import { requestTuneIntents } from "../ai/tune-intent";
import { symptomsToIntents } from "../ai/tune-recommend";
import { applyIntents, getAcEvoCarRanges } from "../ai/tune-rules";
import { writeSetupFile } from "../ai/tune-writer";
import { getSetupsBaseDir, resolveGuardedSetupFile } from "../ai/setup-engineer-context";
import { carSlugFromPresetId, formatCarSetup, parseCarSetup, readCarSetupFile, summarizeCarSetup } from "../games/ac-evo/carsetup";
import { communityRowToCatalog, CarOrdinalQuerySchema } from "./tune-shared";

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
        // .json = ACC / legacy AC EVO Documents setups; .carsetup = AC EVO
        // Saved Games\ACE\Car Setups binary setups.
        files = readdirSync(trackPath).filter((f) => /\.(json|carsetup)$/i.test(f));
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
  // The dropped setup JSON, as an object or raw string. ACC and legacy AC EVO
  // setups only.
  content: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  // A binary AC EVO `.carsetup`, base64-encoded. Mutually exclusive with
  // `content`: these files are protobuf wire format, not JSON, and
  // carsetup-writer.ts patches them by byte offset — so they must round-trip
  // byte-for-byte and can never be re-serialised.
  contentBase64: z.string().min(1).optional(),
}).refine((b) => (b.content == null) !== (b.contentBase64 == null), {
  message: "Provide exactly one of content or contentBase64",
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

export const tuneCrudRoutes = new Hono()
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
      // AC Evo saves setups per circuit, not per layout — every variant shares
      // one on-disk folder (Brands Hatch GP + Indy → "brands_hatch"). Expose the
      // alias group per track key so the picker matches files saved under any
      // sibling variant's folder. Derived in code from tracks.csv base names —
      // NOT extra CSV rows — so it applies to every multi-variant track. ACC
      // keeps distinct folders per variant, so no aliases there.
      const trackAliases: Record<string, string[]> = {};
      if (gameId === "ac-evo") {
        for (const key of tracks) {
          const aliases = getAcEvoSetupFolderAliases(key);
          if (aliases.length > 1) trackAliases[key] = aliases;
        }
      }
      const baseDir = await getSetupsBaseDir(gameId);
      if (!baseDir) {
        return c.json({ baseDir: null, files: [], tracks, trackNames, trackAliases, cars, error: "Setups folder not found" });
      }
      return c.json({ baseDir, files: listSetupFiles(baseDir), tracks, trackNames, trackAliases, cars });
    }
  )

  // GET /api/tunes/setup-file-content?gameId=acc&path=… — read one saved setup
  // file so the picker's "View" button can show its contents. Path is guarded
  // against the game's Setups dir (same realpath/symlink guard as /api/tunes/auto).
  // ACC/legacy .json → parsed object; AC EVO .carsetup → decoded wire tree text
  // + preset id. MUST be registered before /api/tunes/:id.
  .get("/api/tunes/setup-file-content",
    zValidator("query", z.object({ gameId: z.enum(["acc", "ac-evo"]), path: z.string().min(1) })),
    async (c) => {
      const { gameId, path } = c.req.valid("query");
      const guarded = await resolveGuardedSetupFile(gameId, path);
      if (!guarded.ok) return c.json({ error: guarded.error }, guarded.status);
      const fileName = guarded.realPath.split(/[\\/]/).pop() ?? "setup";
      if (guarded.realPath.toLowerCase().endsWith(".carsetup")) {
        const parsed = await readCarSetupFile(guarded.realPath);
        if (!parsed) return c.json({ error: "Couldn't decode .carsetup file" }, 400);
        // Setups live under <base>/<carModel>/<track>/<file> — the first path
        // segment names the car, which selects the extracted per-car range
        // table (same convention as /api/tunes/auto, see below). Ranges let
        // the viewer draw min/max bars like the AI analysis result; rows
        // without a known range simply render without a bar.
        let carModel: string | undefined;
        const baseDir = await getSetupsBaseDir(gameId);
        if (baseDir) {
          try {
            const realBase = realpathSync(resolve(baseDir));
            if ((guarded.realPath + sep).startsWith(realBase + sep)) {
              const relSegments = guarded.realPath.slice(realBase.length + 1).split(sep);
              if (relSegments.length >= 2) carModel = relSegments[0];
            }
          } catch { /* base dir vanished mid-request — render without ranges */ }
        }
        return c.json({
          fileName,
          kind: "carsetup" as const,
          presetId: parsed.presetId ?? null,
          formatted: formatCarSetup(parsed),
          sections: summarizeCarSetup(parsed, getAcEvoCarRanges(carModel)),
          setup: null,
        });
      }
      return c.json({ fileName, kind: "json" as const, presetId: null, formatted: null, sections: null, setup: guarded.setup });
    }
  )

  // POST /api/tunes/inspect-carsetup — decode a dropped binary `.carsetup`
  // (base64) far enough to name its car, without writing anything.
  //
  // Exists because a `.carsetup` identifies its own car via the preset id, but
  // only after a protobuf decode — which the browser can't do. Without this the
  // driver would have to retype a car folder the file already knows.
  .post("/api/tunes/inspect-carsetup",
    zValidator("json", z.object({ contentBase64: z.string().min(1) })),
    async (c) => {
      const { contentBase64 } = c.req.valid("json");
      const bytes = Buffer.from(contentBase64, "base64");
      const decoded = bytes.length > 0 ? parseCarSetup(bytes) : null;
      // Same gate as place-setup: an undecodable file, or one with no fields.
      if (!decoded || decoded.raw.length === 0) {
        return c.json({ error: "Couldn't decode that .carsetup file" }, 400);
      }
      // The slug IS the folder name AC EVO writes under `Car Setups/`, so it is
      // reported whether or not we recognise the car. Gating it on the roster
      // was wrong: shared/ac-evo-car-data is a static CSV that has to be
      // re-extracted after a game update (see the extract-ac-evo skill), so any
      // car newer than the CSV would leave the driver retyping a folder name the
      // file already states correctly.
      //
      // The roster lookup therefore only supplies the friendly display name.
      const slug = carSlugFromPresetId(decoded.presetId);
      const known = slug ? getAllAcEvoCars().find((car) => car.model === slug) : undefined;
      return c.json({
        presetId: decoded.presetId,
        carModel: slug,
        carName: known?.name ?? null,
        /** False when the car isn't in our roster — the folder is still right. */
        knownCar: known != null,
      });
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
      // Write path: this route's whole job is to put a file in the Setups
      // folder, so create it when missing (read routes never do).
      const baseDir = await getSetupsBaseDir(body.gameId, { create: true });
      if (!baseDir) return c.json({ error: "Setups folder not found" }, 404);

      // Sanitise each path segment: no separators, no traversal, no reserved chars.
      const clean = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f-]/g, "").trim();
      const car = clean(body.carName);
      const track = clean(body.trackName);
      let file = clean(body.fileName);
      // Preserve a known setup extension; anything else is treated as JSON, which
      // is what every pre-.carsetup dropped file was.
      const SETUP_EXT = /\.(json|carsetup)$/i;
      if (!SETUP_EXT.test(file)) file += ".json";
      const bad = (s: string) => !s || s === "." || s === "..";
      if (bad(car) || bad(track) || bad(file.replace(SETUP_EXT, ""))) {
        return c.json({ error: "Invalid car, track, or file name" }, 400);
      }

      // Decode the payload up front so a malformed file is rejected before any
      // directory is created. Binary stays a Buffer end to end — see the schema.
      let bytes: Buffer | null = null;
      let json: unknown;
      if (body.contentBase64 != null) {
        bytes = Buffer.from(body.contentBase64, "base64");
        if (bytes.length === 0) return c.json({ error: "Empty .carsetup file" }, 400);
        // Reject anything that isn't actually a decodable setup rather than
        // writing junk into the driver's game folder. Note `parseCarSetup`
        // returns an EMPTY tree (not null) for input it can't find any fields
        // in, so a null check alone would let junk through — require fields.
        const decoded = parseCarSetup(bytes);
        if (!decoded || decoded.raw.length === 0) {
          return c.json({ error: "Couldn't decode that .carsetup file" }, 400);
        }
        if (!/\.carsetup$/i.test(file)) file = `${file.replace(SETUP_EXT, "")}.carsetup`;
      } else {
        try {
          json = typeof body.content === "string" ? JSON.parse(body.content) : body.content;
        } catch (err: any) {
          return c.json({ error: `Invalid setup JSON: ${err.message}` }, 400);
        }
        if (/\.carsetup$/i.test(file)) {
          return c.json({ error: "A .carsetup must be sent as contentBase64, not JSON" }, 400);
        }
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
        // Binary is written verbatim: re-encoding a .carsetup would invalidate
        // the byte offsets carsetup-writer.ts patches against.
        if (bytes) writeFileSync(target, bytes);
        else writeFileSync(target, JSON.stringify(json, null, 2), "utf-8");
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
      let carModel: string | undefined;

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

        // Setups live under <base>/<carModel>/<track>/<file>.json — the first
        // path segment names the car, which selects per-car clamp tables.
        const relSegments = realPath.slice(realBase.length + 1).split(sep);
        if (relSegments.length >= 2) carModel = relSegments[0];
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
          const res = await requestTuneIntents(body.gameId, symptoms, body.trackName, carModel);
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

      const { setup, applied, skipped } = applyIntents(body.gameId, sourceSetup, intents, carModel);

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
