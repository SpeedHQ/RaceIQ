import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, copyFileSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "../paths";
import { accRecorder, replayRecording } from "../games/acc/recorder";
import { getAllAccCars, getAccCarClass } from "../../shared/acc-car-data";
import { getAccCarSpecs } from "../../shared/acc-car-specs";
import { accReader } from "../index";
import { PHYSICS, GRAPHICS, STATIC } from "../games/acc/structs";
import { readWString } from "../games/acc/utils";
import { getAccSharedTrackName } from "../../shared/acc-track-data";

let accReplayHandle: { stop: () => void; frameCount: number } | null = null;

interface YtMeta {
  uploadDate: string;
  downloadUrl: string;
  cachedAt: string;
}

// ── ACC Setups — shared/tunes/acc/{source}/{track}/{car}.json ──

interface AccSetup {
  name: string;
  carModel: string;
  carClass?: string;
  trackName: string;
  driveUrl?: string;
  videoUrl?: string;
  notes?: string;
  author?: string;
  lapTime?: string;
  date?: string;
  setupFile?: string;
  hasRace?: boolean;
  hasQuali?: boolean;
  hasSafe?: boolean;
  hasWet?: boolean;
  source?: string;
}

interface AccSourceMeta {
  name: string;
  slug: string;
  url?: string;
}

const ACC_TUNES_DIR = resolve(SHARED_DIR, "tunes", "acc");
const ACC_SETUP_FILES_DIR = resolve(ACC_TUNES_DIR, "files");

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[-_\s]/g, "").toLowerCase();

function getAccSourceDirs(): { slug: string; meta: AccSourceMeta; dir: string }[] {
  if (!existsSync(ACC_TUNES_DIR)) return [];
  return readdirSync(ACC_TUNES_DIR)
    .filter((d) => {
      const p = resolve(ACC_TUNES_DIR, d);
      return statSync(p).isDirectory() && d !== "files" && existsSync(resolve(p, "_source.json"));
    })
    .map((d) => ({
      slug: d,
      meta: JSON.parse(readFileSync(resolve(ACC_TUNES_DIR, d, "_source.json"), "utf-8")),
      dir: resolve(ACC_TUNES_DIR, d),
    }));
}

/** Load setups for a specific track across all sources */
function loadAccSetupsByTrack(trackSlug: string): AccSetup[] {
  const needle = norm(trackSlug);
  const all: AccSetup[] = [];
  for (const { slug: sourceSlug, dir: sourceDir } of getAccSourceDirs()) {
    // Find matching track directory
    let trackDirs: string[];
    try { trackDirs = readdirSync(sourceDir).filter((d) => statSync(resolve(sourceDir, d)).isDirectory()); } catch { continue; }
    for (const td of trackDirs) {
      if (norm(td) !== needle && !norm(td).includes(needle) && !needle.includes(norm(td))) continue;
      // Load all car files in this track dir
      const carFiles = readdirSync(resolve(sourceDir, td)).filter((f) => f.endsWith(".json"));
      for (const cf of carFiles) {
        const setups: Omit<AccSetup, "source">[] = JSON.parse(readFileSync(resolve(sourceDir, td, cf), "utf-8"));
        all.push(...setups.map((s) => ({ ...s, source: sourceSlug })));
      }
    }
  }
  return all;
}

/** Load all setups across all sources (for unfiltered queries) */
function loadAllAccSetups(): AccSetup[] {
  const all: AccSetup[] = [];
  for (const { slug: sourceSlug, dir: sourceDir } of getAccSourceDirs()) {
    let trackDirs: string[];
    try { trackDirs = readdirSync(sourceDir).filter((d) => statSync(resolve(sourceDir, d)).isDirectory()); } catch { continue; }
    for (const td of trackDirs) {
      const carFiles = readdirSync(resolve(sourceDir, td)).filter((f) => f.endsWith(".json"));
      for (const cf of carFiles) {
        const setups: Omit<AccSetup, "source">[] = JSON.parse(readFileSync(resolve(sourceDir, td, cf), "utf-8"));
        all.push(...setups.map((s) => ({ ...s, source: sourceSlug })));
      }
    }
  }
  return all;
}



const CreateSetupSchema = z.object({
  name: z.string().min(1),
  carModel: z.string().min(1),
  trackName: z.string().min(1),
  driveUrl: z.string().optional(),
  videoUrl: z.string().optional(),
  notes: z.string().optional(),
  author: z.string().optional(),
  lapTime: z.string().optional(),
  date: z.string().optional(),
  setupFile: z.string().optional(),
});

const ReplayStartSchema = z.object({
  path: z.string().min(1),
  speed: z.number().optional(),
  loop: z.boolean().optional(),
});

// ── YouTube metadata proxy ────────────────────────────────────────────────

const DOWNLOAD_HOSTS = ["drive.google.com", "docs.google.com", "onedrive.live.com", "1drv.ms", "dropbox.com", "mega.nz", "mega.co.nz"];

function findDownloadLink(description: string): string {
  const links = description.match(/https?:\/\/[^\s]+/g) ?? [];
  for (const link of links) {
    try {
      const host = new URL(link).hostname;
      if (DOWNLOAD_HOSTS.some(h => host.includes(h))) return link;
    } catch {}
  }
  return "";
}

async function fetchYtMeta(videoId: string): Promise<YtMeta> {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
  });
  const html = await res.text();

  const dateM = html.match(/"uploadDate":"([^"]+)"/);
  const uploadDate = dateM ? dateM[1].slice(0, 10) : "";

  const marker = '"shortDescription":"';
  const idx = html.indexOf(marker);
  let downloadUrl = "";
  if (idx !== -1) {
    let desc = "";
    let i = idx + marker.length;
    while (i < html.length) {
      const c = html[i], c2 = html[i + 1];
      if (c === "\\" && c2 === '"') { desc += '"'; i += 2; }
      else if (c === "\\" && c2 === "n") { desc += "\n"; i += 2; }
      else if (c === "\\" && c2 === "\\") { desc += "\\"; i += 2; }
      else if (c === '"') break;
      else { desc += c; i++; }
    }
    downloadUrl = findDownloadLink(desc);
  }

  return { uploadDate, downloadUrl, cachedAt: new Date().toISOString() };
}

export const accRoutes = new Hono()

  // ── Sources ──────────────────────────────────────────────────────────────

  .get("/api/acc/sources", (c) => {
    return c.json(getAccSourceDirs().map(({ meta }) => meta));
  })

  // ── YouTube metadata (cached) ─────────────────────────────────────────────

  .get("/api/acc/yt-meta",
    zValidator("query", z.object({ videoId: z.string() })),
    async (c) => {
      const { videoId } = c.req.valid("query");
      if (!/^[\w-]{11}$/.test(videoId)) return c.json({ error: "Invalid video ID" }, 400);
      try {
        return c.json(await fetchYtMeta(videoId));
      } catch (err: any) {
        return c.json({ error: err.message }, 502);
      }
    }
  )

  // ── Setups ────────────────────────────────────────────────────────────────

  .get("/api/acc/setups",
    zValidator("query", z.object({ car: z.string().optional(), track: z.string().optional() })),
    (c) => {
      const { car, track } = c.req.valid("query");
      let setups = track ? loadAccSetupsByTrack(track) : loadAllAccSetups();
      if (car) setups = setups.filter((s) => s.carModel === car);
      return c.json(setups);
    }
  )

  // GET /api/acc/setups-by-track?ordinal=123 — match track ordinal to setup slugs
  .get("/api/acc/setups-by-track",
    zValidator("query", z.object({ ordinal: z.string() })),
    (c) => {
      const ordinal = parseInt(c.req.valid("query").ordinal, 10);
      if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);
      const slug = getAccSharedTrackName(ordinal);
      if (!slug) return c.json([]);
      return c.json(loadAccSetupsByTrack(slug));
    }
  )

  .post("/api/acc/setups",
    zValidator("json", CreateSetupSchema),
    (c) => {
      const body = c.req.valid("json");
      const sourceSlug = "custom";
      const trackSlug = body.trackName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
      const carSlug = body.carModel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");

      // Ensure source dir + _source.json exist
      const sourceDir = resolve(ACC_TUNES_DIR, sourceSlug);
      if (!existsSync(sourceDir)) mkdirSync(sourceDir, { recursive: true });
      const srcMeta = resolve(sourceDir, "_source.json");
      if (!existsSync(srcMeta)) writeFileSync(srcMeta, JSON.stringify({ name: "Custom", slug: sourceSlug, domain: "local", url: "", lastScraped: "" }, null, 2));

      // Read or create the car file
      const trackDir = resolve(sourceDir, trackSlug);
      if (!existsSync(trackDir)) mkdirSync(trackDir, { recursive: true });
      const carFile = resolve(trackDir, carSlug + ".json");
      const existing: AccSetup[] = existsSync(carFile) ? JSON.parse(readFileSync(carFile, "utf-8")) : [];
      existing.push(body as any);
      writeFileSync(carFile, JSON.stringify(existing, null, 2));
      return c.json(body, 201);
    }
  )

  .post("/api/acc/setups/install",
    zValidator("json", z.object({ carModel: z.string(), trackName: z.string(), setupFile: z.string() })),
    async (c) => {
    const { carModel, trackName, setupFile } = c.req.valid("json");

    const srcPath = resolve(ACC_SETUP_FILES_DIR, setupFile);
    if (!existsSync(srcPath)) return c.json({ error: "Setup file not found on disk" }, 404);

    const { homedir } = await import("os");
    const possiblePaths = [
      resolve(homedir(), "Documents", "Assetto Corsa Competizione", "Setups"),
      resolve(homedir(), "OneDrive", "Documents", "Assetto Corsa Competizione", "Setups"),
    ];

    let accSetupsDir: string | null = null;
    for (const p of possiblePaths) {
      if (existsSync(p)) { accSetupsDir = p; break; }
    }

    if (!accSetupsDir) {
      return c.json({ error: "ACC Setups folder not found. Checked: " + possiblePaths.join(", ") }, 404);
    }

    const destDir = resolve(accSetupsDir, carModel, trackName);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    const destPath = resolve(destDir, setupFile);
    copyFileSync(srcPath, destPath);

    return c.json({ installed: true, path: destPath });
  })

  // ── Cars ──────────────────────────────────────────────────────────────────

  .get("/api/acc/cars", (c) => {
    const cars = getAllAccCars().map((car) => ({
      ...car,
      specs: getAccCarSpecs(car.id) ?? null,
    }));
    cars.sort((a, b) => a.class.localeCompare(b.class) || a.name.localeCompare(b.name));
    return c.json(cars);
  })

  // Resolves the ACC class (GT3/GT4/TCX/…) for a car ordinal. Class is the
  // authoritative server-side fact; the client maps class → pressure window
  // (or other class-aware rules) locally.
  .get("/api/acc/cars/:ordinal/class", (c) => {
    const ord = Number(c.req.param("ordinal"));
    if (!Number.isFinite(ord)) return c.json({ class: null });
    return c.json({ class: getAccCarClass(ord) ?? null });
  })

  // ── Debug ─────────────────────────────────────────────────────────────────

  .get("/api/acc/debug/raw", (c) => {
    const bufs = accReader.getDebugBuffers?.();
    if (!bufs) {
      return c.json({ error: "ACC not connected or getDebugBuffers not available" }, 503);
    }
    const { physics, graphics, staticData } = bufs;

    const p: Record<string, number> = {};
    for (const [key, def] of Object.entries(PHYSICS)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      const { offset, type } = def as { offset: number; type: string };
      if (offset + 4 > physics.length) { p[key] = -999; continue; }
      p[key] = type === "f32" ? physics.readFloatLE(offset) : physics.readInt32LE(offset);
    }

    const g: Record<string, number | string> = {};
    for (const [key, def] of Object.entries(GRAPHICS)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      const d = def as { offset: number; type: string; size?: number };
      if (d.type === "wstring") {
        g[key] = readWString(graphics, d.offset, d.size!);
      } else {
        if (d.offset + 4 > graphics.length) { g[key] = -999; continue; }
        g[key] = d.type === "f32" ? graphics.readFloatLE(d.offset) : graphics.readInt32LE(d.offset);
      }
    }

    const s: Record<string, number | string> = {};
    for (const [key, def] of Object.entries(STATIC)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      const d = def as { offset: number; type: string; size?: number };
      if (d.type === "wstring") {
        s[key] = readWString(staticData, d.offset, d.size!);
      } else {
        if (d.offset + 4 > staticData.length) { s[key] = -999; continue; }
        s[key] = d.type === "f32" ? staticData.readFloatLE(d.offset) : staticData.readInt32LE(d.offset);
      }
    }

    const tempCandidates: { offset: number; value: number }[] = [];
    for (let i = 0; i <= physics.length - 4; i += 4) {
      const v = physics.readFloatLE(i);
      if (v >= 20 && v <= 200 && Number.isFinite(v)) {
        tempCandidates.push({ offset: i, value: Math.round(v * 100) / 100 });
      }
    }

    return c.json({ physics: p, graphics: g, static: s, tempCandidates });
  })

  // ── Recording / Replay ────────────────────────────────────────────────────

  .get("/api/acc/recording/status", (c) => {
    return c.json({
      recording: accRecorder.recording,
      frames: accRecorder.frameCount,
      path: accRecorder.path,
    });
  })

  .post("/api/acc/recording/start", (c) => {
    if (accRecorder.recording) {
      return c.json({ error: "Already recording" }, 409);
    }
    const path = accRecorder.start();
    return c.json({ started: true, path });
  })

  .post("/api/acc/recording/stop", async (c) => {
    if (!accRecorder.recording) {
      return c.json({ error: "Not recording" }, 409);
    }
    await accRecorder.stop();
    return c.json({ stopped: true, frames: accRecorder.frameCount, path: accRecorder.path });
  })

  .post("/api/acc/replay/start",
    zValidator("json", ReplayStartSchema),
    async (c) => {
      const body = c.req.valid("json");
      if (accReplayHandle) {
        accReplayHandle.stop();
        accReplayHandle = null;
      }
      try {
        const handle = await replayRecording(body.path, {
          speed: body.speed,
          loop: body.loop,
        });
        accReplayHandle = handle;
        return c.json({ started: true, frames: handle.frameCount });
      } catch (err: any) {
        return c.json({ error: err.message }, 400);
      }
    }
  )

  .post("/api/acc/replay/stop", (c) => {
    if (!accReplayHandle) {
      return c.json({ error: "No replay active" }, 409);
    }
    accReplayHandle.stop();
    accReplayHandle = null;
    return c.json({ stopped: true });
  })

  .get("/api/acc/recordings", (c) => {
    const dir = resolve(process.cwd(), "test", "artifacts", "laps");
    if (!existsSync(dir)) return c.json([]);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".bin"))
      .map((f) => {
        const fullPath = resolve(dir, f);
        const stat = statSync(fullPath);
        return { name: f, path: fullPath, size: stat.size, created: stat.birthtime };
      })
      .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
    return c.json(files);
  });
