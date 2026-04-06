import { Hono } from "hono";
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";

import { lapDetector } from "../lap-detector";
import { wsManager } from "../ws";
import { USER_TRACKS_DIR } from "../paths";
import { getUpdateState, startUpdateCheckSchedule, checkForUpdate, applyUpdate } from "../update-check";

// Check for updates on startup and then every 4 hours
startUpdateCheckSchedule();
import {
  findForzaInstall,
  parseForzaZip,
  decompressForzaLZX,
} from "../../shared/lib/forza-lzx";
import { scanRecordedFiles } from "../../shared/track-data";

// ---------------------------------------------------------------------------
// FM2023 extraction state
// ---------------------------------------------------------------------------

const FM2023_OUT_DIR = resolve(USER_TRACKS_DIR, "fm-2023/extracted");

const extractionState = {
  status: "idle" as "idle" | "running" | "done" | "error",
  installed: !!findForzaInstall(),
  extracted: 0,
  failed: 0,
  total: 0,
  current: "",
  error: "",
};

// Check if already extracted on startup
try {
  if (existsSync(FM2023_OUT_DIR)) {
    const csvs = readdirSync(FM2023_OUT_DIR).filter(
      (f) => f.startsWith("recorded-") && f.endsWith(".csv"),
    );
    if (csvs.length > 0) {
      extractionState.status = "done";
      extractionState.extracted = csvs.length;
    }
  }
} catch {}

// ---------------------------------------------------------------------------
// FM2023 extraction helpers
// ---------------------------------------------------------------------------

function parseMlpWaypoints(
  data: Buffer,
): { x: number[]; z: number[] } | null {
  const text = data.toString("utf8", 0, Math.min(1024, data.length));
  const startIdx = text.indexOf("MLPDataStart:");
  if (startIdx === -1) return null;

  const headerEnd = text.indexOf("MLPDataEnd:");
  const header = text.substring(
    startIdx + "MLPDataStart:\n".length,
    headerEnd > 0 ? headerEnd : 1024,
  );

  let wpXOffset = -1,
    wpYOffset = -1,
    count = 0;

  for (const line of header.split("\n")) {
    const m = line.trim().match(/^(\w+):(\w+):(\d+):(\d+):\s+(\d+)$/);
    if (!m) continue;
    if (m[1] === "fWaypointX") {
      wpXOffset = parseInt(m[5]);
      count = parseInt(m[3]);
    }
    if (m[1] === "fWaypointY") wpYOffset = parseInt(m[5]);
  }

  if (wpXOffset < 0 || wpYOffset < 0 || count === 0) return null;

  const needed = Math.max(wpXOffset, wpYOffset) + count * 4;
  if (data.length < needed) {
    count = Math.min(
      Math.floor((data.length - wpXOffset) / 4),
      Math.floor((data.length - wpYOffset) / 4),
    );
    if (count < 50) return null;
  }

  const x: number[] = [],
    z: number[] = [];
  for (let i = 0; i < count; i++) {
    x.push(data.readFloatLE(wpXOffset + i * 4));
    z.push(data.readFloatLE(wpYOffset + i * 4));
  }
  return { x, z };
}

async function runExtraction() {
  const forzaDir = findForzaInstall();
  if (!forzaDir) {
    extractionState.status = "error";
    extractionState.error = "Forza Motorsport 2023 not found";
    return;
  }

  extractionState.status = "running";
  extractionState.extracted = 0;
  extractionState.failed = 0;
  extractionState.error = "";

  try {
    const { entries: trackEntries } = parseForzaZip(
      `${forzaDir}/media/base/ai/tracks.zip`,
    );

    const ordinalMap = new Map<string, number[]>();
    for (const entry of trackEntries) {
      const match = entry.name.match(
        /^(\w+)\/(ribbon_\d+)\/difficulty\/track_(\d+)_/,
      );
      if (match) {
        const key = `${match[1]}/${match[2]}`;
        const ordinal = parseInt(match[3], 10);
        if (!ordinalMap.has(key)) ordinalMap.set(key, []);
        const ords = ordinalMap.get(key)!;
        if (!ords.includes(ordinal)) ords.push(ordinal);
      }
    }

    mkdirSync(FM2023_OUT_DIR, { recursive: true });

    const tracksDir = `${forzaDir}/media/pcfamily/tracks`;
    const trackDirs = readdirSync(tracksDir).filter((d) =>
      existsSync(resolve(tracksDir, d, "ribbon_00.zip")),
    );

    const allRibbons: { trackDir: string; ribbonFile: string }[] = [];
    for (const trackDir of trackDirs) {
      const ribbons = readdirSync(resolve(tracksDir, trackDir)).filter((f) =>
        /^ribbon_\d+\.zip$/.test(f),
      );
      for (const r of ribbons) allRibbons.push({ trackDir, ribbonFile: r });
    }

    extractionState.total = allRibbons.length;

    for (const { trackDir, ribbonFile } of allRibbons) {
      const ribbonName = ribbonFile.replace(".zip", "");
      const mapKey = `${trackDir}/${ribbonName}`;
      extractionState.current = `${trackDir}/${ribbonName}`;

      const ordinals = ordinalMap.get(mapKey);
      if (!ordinals || ordinals.length === 0) continue;

      try {
        const { buf, entries } = parseForzaZip(
          resolve(tracksDir, trackDir, ribbonFile),
        );
        const geoEntry = entries.find((e) => e.name === "AI/Track.geo");
        if (!geoEntry) continue;

        const compressed = buf.subarray(
          geoEntry.dataStart,
          geoEntry.dataStart + geoEntry.compSize,
        );
        const decompressed = decompressForzaLZX(
          compressed,
          geoEntry.uncompSize,
        );
        const waypoints = parseMlpWaypoints(decompressed);
        if (!waypoints) {
          extractionState.failed++;
          continue;
        }

        for (const ordinal of ordinals) {
          const csv =
            "x,z\n" +
            waypoints.x
              .map((x, i) => `${x.toFixed(4)},${waypoints.z[i].toFixed(4)}`)
              .join("\n");
          writeFileSync(
            resolve(FM2023_OUT_DIR, `recorded-${ordinal}.csv`),
            csv,
          );
          extractionState.extracted++;
        }
      } catch {
        extractionState.failed++;
      }

      await new Promise((r) => setTimeout(r, 0));
    }

    extractionState.status = "done";
    extractionState.current = "";
    scanRecordedFiles();
  } catch (e: any) {
    extractionState.status = "error";
    extractionState.error = e.message || "Unknown error";
  }
}

// ---------------------------------------------------------------------------
// F1 2025 extraction state
// ---------------------------------------------------------------------------

const F1_25_OUT_DIR = resolve(USER_TRACKS_DIR, "f1-2025/extracted");

function findF1Install(): string | null {
  const vdfPath =
    "C:/Program Files (x86)/Steam/steamapps/libraryfolders.vdf";
  if (!existsSync(vdfPath)) return null;
  try {
    const content = readFileSync(vdfPath, "utf8");
    const pathRegex = /"path"\s+"([^"]+)"/g;
    let match;
    while ((match = pathRegex.exec(content)) !== null) {
      const libPath = match[1].replace(/\\\\/g, "/").replace(/\\/g, "/");
      const f1Path = `${libPath}/steamapps/common/F1 25`;
      if (existsSync(f1Path)) return f1Path;
    }
  } catch {}
  return null;
}

const f1ExtractionState = {
  status: "idle" as "idle" | "running" | "done" | "error",
  installed: !!findF1Install(),
  extracted: 0,
  failed: 0,
  total: 28,
  current: "",
  error: "",
};

try {
  if (existsSync(F1_25_OUT_DIR)) {
    const csvs = readdirSync(F1_25_OUT_DIR).filter(
      (f) => f.startsWith("recorded-") && f.endsWith(".csv"),
    );
    if (csvs.length > 0) {
      f1ExtractionState.status = "done";
      f1ExtractionState.extracted = csvs.length;
    }
  }
} catch {}

async function runF1Extraction() {
  if (!findF1Install()) {
    f1ExtractionState.status = "error";
    f1ExtractionState.error = "F1 25 not found";
    return;
  }

  f1ExtractionState.status = "running";
  f1ExtractionState.extracted = 0;
  f1ExtractionState.failed = 0;
  f1ExtractionState.error = "";
  f1ExtractionState.current = "Starting...";

  try {
    const { extractF1Tracks } = await import("../games/f1-2025/extract-tracks");
    const result = await extractF1Tracks(F1_25_OUT_DIR, (progress) => {
      if (progress.type === "extracted") {
        f1ExtractionState.extracted++;
        f1ExtractionState.current = progress.track;
      } else if (progress.type === "skipped") {
        f1ExtractionState.failed++;
      } else if (progress.type === "total") {
        f1ExtractionState.total = progress.count;
      }
    });

    f1ExtractionState.status = "done";
    f1ExtractionState.current = "";
    f1ExtractionState.extracted = result.extracted;
    scanRecordedFiles();
  } catch (e: any) {
    f1ExtractionState.status = "error";
    f1ExtractionState.error = e.message || "Unknown error";
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const miscRoutes = new Hono()
  // GET /api/version — current version + update availability
  .get("/api/version", (c) => {
    return c.json(getUpdateState());
  })

  // POST /api/update/check — force a fresh update check and return result
  .post("/api/update/check", async (c) => {
    const result = await checkForUpdate();
    return c.json(result);
  })

  // POST /api/update/apply — download and apply the pending update, then restart
  .post("/api/update/apply", async (c) => {
    try {
      await applyUpdate(); // starts download, spawns swap script, then process exits
      return new Response(null, { status: 204 });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  })

  // GET /api/fuel-history
  .get("/api/fuel-history", (c) => {
    return c.json(lapDetector.fuelHistory);
  })

  // GET /api/tire-wear-history
  .get("/api/tire-wear-history", (c) => {
    return c.json(lapDetector.tireWearHistory);
  })

  // GET /api/grip-history
  .get("/api/grip-history", (c) => {
    return c.json(wsManager.getGripHistory());
  })

  // GET /api/telemetry-history
  .get("/api/telemetry-history", (c) => {
    return c.json(wsManager.getTelemetryHistory());
  })

  // GET /api/games/detection — combined game detection status
  .get("/api/games/detection", (c) => {
    return c.json({
      "fm-2023": {
        installed: extractionState.installed,
        extracted:
          extractionState.status === "done" && extractionState.extracted > 0,
        extractionStatus: extractionState.status,
        trackCount: extractionState.extracted,
      },
      "f1-2025": {
        installed: f1ExtractionState.installed,
        extracted:
          f1ExtractionState.status === "done" &&
          f1ExtractionState.extracted > 0,
        extractionStatus: f1ExtractionState.status,
        trackCount: f1ExtractionState.extracted,
      },
    });
  })

  // GET /api/extraction/status — FM2023 extraction status
  .get("/api/extraction/status", (c) => {
    return c.json(extractionState);
  })

  // POST /api/extraction/run — start FM2023 extraction
  .post("/api/extraction/run", async (c) => {
    if (extractionState.status === "running")
      return c.json({ error: "Extraction already in progress" }, 409);
    runExtraction();
    return c.json({ started: true });
  })

  // DELETE /api/extraction/data — delete FM2023 extracted data
  .delete("/api/extraction/data", (c) => {
    if (extractionState.status === "running")
      return c.json({ error: "Extraction in progress" }, 409);
    if (existsSync(FM2023_OUT_DIR)) {
      rmSync(FM2023_OUT_DIR, { recursive: true, force: true });
      mkdirSync(FM2023_OUT_DIR, { recursive: true });
    }
    extractionState.status = "idle";
    extractionState.extracted = 0;
    extractionState.failed = 0;
    scanRecordedFiles();
    return c.json({ deleted: true });
  })

  // GET /api/extraction/f1/status — F1 extraction status
  .get("/api/extraction/f1/status", (c) => {
    return c.json(f1ExtractionState);
  })

  // POST /api/extraction/f1/run — start F1 extraction
  .post("/api/extraction/f1/run", async (c) => {
    if (f1ExtractionState.status === "running")
      return c.json({ error: "Extraction already in progress" }, 409);
    runF1Extraction();
    return c.json({ started: true });
  })

  // DELETE /api/extraction/f1/data — delete F1 extracted data
  .delete("/api/extraction/f1/data", (c) => {
    if (f1ExtractionState.status === "running")
      return c.json({ error: "Extraction in progress" }, 409);
    if (existsSync(F1_25_OUT_DIR)) {
      rmSync(F1_25_OUT_DIR, { recursive: true, force: true });
      mkdirSync(F1_25_OUT_DIR, { recursive: true });
    }
    f1ExtractionState.status = "idle";
    f1ExtractionState.extracted = 0;
    f1ExtractionState.failed = 0;
    scanRecordedFiles();
    return c.json({ deleted: true });
  });
