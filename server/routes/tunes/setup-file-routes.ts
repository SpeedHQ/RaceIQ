import { zValidator } from "@hono/zod-validator";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { resolve, sep } from "node:path";
import { z } from "zod";

import { getAllAccCars } from "../../../shared/racing/cars/acc"
import { getAccSetupFolderKeys, getAccTrackBySetupFolder } from "../../../shared/racing/tracks/catalogs/acc"
import { getAllAcEvoCars } from "../../../shared/racing/cars/ac-evo"
import { getAcEvoSetupFolderAliases, getAcEvoSetupFolderKeys, getAcEvoTrackBySetupFolder } from "../../../shared/racing/tracks/catalogs/ac-evo"
import { AccSetupJsonSchema, setupFileFormat, setupFileRejectReason } from "../../../shared/racing/setups/file-formats";
import { getTuneById, insertTune } from "../../db/tune-queries";
import { carSlugFromPresetId, formatCarSetup, readCarSetupFile, summarizeCarSetup } from "../../games/ac-evo/carsetup";
import { parseCarSetup } from "../../games/ac-evo/carsetup-wire";
import { getSetupsBaseDir, resolveGuardedSetupFile } from "../../setups/file-guard";
import { getAcEvoCarRanges } from "../../setups/rules/catalog";
import { parseTuneRow, sanitisePathSegment } from "../tune-shared";

interface SetupFileListing { carModel: string; trackName: string; fileName: string; absolutePath: string; }

function listSetupFiles(baseDir: string): SetupFileListing[] {
  const out: SetupFileListing[] = [];
  let carDirs: string[];
  try { carDirs = readdirSync(baseDir).filter((d) => statSync(resolve(baseDir, d)).isDirectory()); }
  catch { return out; }
  for (const carModel of carDirs) {
    const carPath = resolve(baseDir, carModel);
    let trackDirs: string[];
    try { trackDirs = readdirSync(carPath).filter((d) => statSync(resolve(carPath, d)).isDirectory()); }
    catch { continue; }
    for (const trackName of trackDirs) {
      const trackPath = resolve(carPath, trackName);
      let files: string[];
      try { files = readdirSync(trackPath).filter((f) => /\.(json|carsetup)$/i.test(f)); }
      catch { continue; }
      for (const fileName of files) out.push({ carModel, trackName, fileName, absolutePath: resolve(trackPath, fileName) });
    }
  }
  return out;
}

const ImportFileSchema = z.object({
  gameId: z.enum(["acc", "ac-evo"]), filePath: z.string().min(1), name: z.string().optional(),
  author: z.string().optional(), carOrdinal: z.number().int(), category: z.string().optional().default("circuit"),
});

const PlaceSetupSchema = z.object({
  gameId: z.enum(["acc", "ac-evo"]), carName: z.string().min(1).max(120), trackName: z.string().min(1).max(120),
  fileName: z.string().min(1).max(160), content: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  contentBase64: z.string().min(1).optional(),
}).superRefine((b, ctx) => {
  if ((b.content == null) === (b.contentBase64 == null)) {
    ctx.addIssue({ code: "custom", message: "Provide exactly one of content or contentBase64" }); return;
  }
  const fmt = setupFileFormat(b.gameId);
  const wantBinary = fmt.payload === "binary";
  if (wantBinary && b.contentBase64 == null) ctx.addIssue({ code: "custom", path: ["contentBase64"], message: `${fmt.gameLabel} setups must be sent as a base64 ${fmt.extension} (contentBase64)` });
  if (!wantBinary && b.content == null) ctx.addIssue({ code: "custom", path: ["content"], message: `${fmt.gameLabel} setups must be sent as JSON (content)` });
  if (!wantBinary && b.content != null) {
    let parsed: unknown = b.content;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); }
      catch (err: any) { ctx.addIssue({ code: "custom", path: ["content"], message: `Invalid setup JSON: ${err.message}` }); return; }
    }
    if (!AccSetupJsonSchema.safeParse(parsed).success) ctx.addIssue({ code: "custom", path: ["content"], message: "That JSON isn't a saved setup — it needs a carName and basicSetup" });
  }
  const hasExt = /\.[^.]+$/.test(b.fileName);
  const matchesGame = b.fileName.toLowerCase().endsWith(fmt.extension);
  if (hasExt && !matchesGame) {
    ctx.addIssue({ code: "custom", path: ["fileName"], message: setupFileRejectReason(b.gameId, b.fileName) ?? "Unsupported setup file" });
  }
});

export const tuneSetupFileRoutes = new Hono()
  .get("/api/tunes/setup-files",
    zValidator("query", z.object({ gameId: z.enum(["acc", "ac-evo"]) })),
    async (c) => {
      const { gameId } = c.req.valid("query");
      const tracks = gameId === "acc" ? getAccSetupFolderKeys() : getAcEvoSetupFolderKeys();
      const trackByKey = gameId === "acc" ? getAccTrackBySetupFolder : getAcEvoTrackBySetupFolder;
      const trackNames: Record<string, string> = {};
      for (const key of tracks) {
        const t = trackByKey(key);
        trackNames[key] = t ? (t.variant ? `${t.name} ${t.variant}` : t.name) : key;
      }
      const cars = (gameId === "acc" ? getAllAccCars() : getAllAcEvoCars()).map((car) => ({ model: car.model, name: car.name }));
      const trackAliases: Record<string, string[]> = {};
      if (gameId === "ac-evo") for (const key of tracks) {
        const aliases = getAcEvoSetupFolderAliases(key);
        if (aliases.length > 1) trackAliases[key] = aliases;
      }
      const baseDir = await getSetupsBaseDir(gameId);
      if (!baseDir) return c.json({ baseDir: null, files: [], tracks, trackNames, trackAliases, cars, error: "Setups folder not found" });
      return c.json({ baseDir, files: listSetupFiles(baseDir), tracks, trackNames, trackAliases, cars });
    })

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
        let carModel: string | undefined;
        const baseDir = await getSetupsBaseDir(gameId);
        if (baseDir) try {
          const realBase = realpathSync(resolve(baseDir));
          if ((guarded.realPath + sep).startsWith(realBase + sep)) {
            const relSegments = guarded.realPath.slice(realBase.length + 1).split(sep);
            if (relSegments.length >= 2) carModel = relSegments[0];
          }
        } catch { /* base dir vanished mid-request — render without ranges */ }
        return c.json({ fileName, kind: "carsetup" as const, presetId: parsed.presetId ?? null, formatted: formatCarSetup(parsed), sections: summarizeCarSetup(parsed, getAcEvoCarRanges(carModel)), setup: null });
      }
      return c.json({ fileName, kind: "json" as const, presetId: null, formatted: null, sections: null, setup: guarded.setup });
    })

  .post("/api/tunes/inspect-carsetup",
    zValidator("json", z.object({ contentBase64: z.string().min(1) })),
    async (c) => {
      const { contentBase64 } = c.req.valid("json");
      const bytes = Buffer.from(contentBase64, "base64");
      const decoded = bytes.length > 0 ? parseCarSetup(bytes) : null;
      if (!decoded || decoded.raw.length === 0) return c.json({ error: "Couldn't decode that .carsetup file" }, 400);
      const slug = carSlugFromPresetId(decoded.presetId);
      const known = slug ? getAllAcEvoCars().find((car) => car.model === slug) : undefined;
      return c.json({ presetId: decoded.presetId, carModel: slug, carName: known?.name ?? null, knownCar: known != null });
    })

  .post("/api/tunes/place-setup",
    zValidator("json", PlaceSetupSchema),
    async (c) => {
      const body = c.req.valid("json");
      const baseDir = await getSetupsBaseDir(body.gameId, { create: true });
      if (!baseDir) return c.json({ error: "Setups folder not found" }, 404);
      const car = sanitisePathSegment(body.carName);
      const track = sanitisePathSegment(body.trackName);
      let file = sanitisePathSegment(body.fileName);
      const SETUP_EXT = /\.(json|carsetup)$/i;
      const gameExt = setupFileFormat(body.gameId).extension;
      if (!SETUP_EXT.test(file)) file += gameExt;
      const bad = (s: string) => !s || s === "." || s === "..";
      if (bad(car) || bad(track) || bad(file.replace(SETUP_EXT, ""))) return c.json({ error: "Invalid car, track, or file name" }, 400);
      let bytes: Buffer | null = null;
      let json: unknown;
      if (body.contentBase64 != null) {
        bytes = Buffer.from(body.contentBase64, "base64");
        if (bytes.length === 0) return c.json({ error: "Empty .carsetup file" }, 400);
        const decoded = parseCarSetup(bytes);
        if (!decoded || decoded.raw.length === 0) return c.json({ error: "Couldn't decode that .carsetup file" }, 400);
        if (!/\.carsetup$/i.test(file)) file = `${file.replace(SETUP_EXT, "")}.carsetup`;
      } else {
        try { json = typeof body.content === "string" ? JSON.parse(body.content) : body.content; }
        catch (err: any) { return c.json({ error: `Invalid setup JSON: ${err.message}` }, 400); }
        if (!AccSetupJsonSchema.safeParse(json).success) return c.json({ error: "That JSON isn't a saved setup — it needs a carName and basicSetup" }, 400);
        if (/\.carsetup$/i.test(file)) return c.json({ error: "A .carsetup must be sent as contentBase64, not JSON" }, 400);
      }
      const realBase = realpathSync(resolve(baseDir));
      const trackDir = resolve(realBase, car, track);
      const target = resolve(trackDir, file);
      if (!(target + sep).startsWith(realBase + sep)) return c.json({ error: "Resolved path escapes the Setups folder" }, 400);
      if (existsSync(target)) return c.json({ absolutePath: target, carModel: car, trackName: track, fileName: file, placed: false });
      try {
        mkdirSync(trackDir, { recursive: true });
        if (bytes) writeFileSync(target, bytes);
        else writeFileSync(target, JSON.stringify(json, null, 2), "utf-8");
      } catch (err: any) { return c.json({ error: `Couldn't write setup: ${err.message}` }, 500); }
      return c.json({ absolutePath: target, carModel: car, trackName: track, fileName: file, placed: true }, 201);
    })

  .post("/api/tunes/import-file",
    zValidator("json", ImportFileSchema),
    async (c) => {
      const body = c.req.valid("json");
      const baseDir = await getSetupsBaseDir(body.gameId);
      if (!baseDir) return c.json({ error: "Setups folder not found" }, 404);
      const absPath = resolve(body.filePath);
      if (!existsSync(absPath)) return c.json({ error: "File not found" }, 404);
      let realPath: string;
      let realBase: string;
      try { realPath = realpathSync(absPath); realBase = realpathSync(resolve(baseDir)); }
      catch (err: any) {
        if (err?.code === "ENOENT") return c.json({ error: "File not found" }, 404);
        return c.json({ error: `Read failed: ${err.message}` }, 500);
      }
      if (!(realPath + sep).startsWith(realBase + sep)) return c.json({ error: "Path must be inside the Setups folder" }, 400);
      if (!realPath.toLowerCase().endsWith(".json")) return c.json({ error: "Only .json setup files can be imported" }, 400);
      let raw: string;
      try { raw = readFileSync(realPath, "utf-8"); }
      catch (err: any) { return c.json({ error: `Read failed: ${err.message}` }, 500); }
      let parsed: any;
      try { parsed = JSON.parse(raw); }
      catch (err: any) { return c.json({ error: `Invalid JSON: ${err.message}` }, 400); }
      const fileName = realPath.split(/[\\/]/).pop() ?? "imported";
      const name = body.name ?? fileName.replace(/\.json$/i, "");
      const id = await insertTune({ gameId: body.gameId, name, author: body.author ?? "Imported", carOrdinal: body.carOrdinal, category: body.category, description: `Imported from ${fileName}`, settings: JSON.stringify(parsed), unitSystem: "metric", source: "imported-file" });
      const created = await getTuneById(id);
      return c.json(parseTuneRow(created), 201);
    });
