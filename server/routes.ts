import { Hono } from "hono";
import { cors } from "hono/cors";
import { udpListener } from "./udp";
import { wsManager } from "./ws";
import { lapDetector } from "./lap-detector";
import { loadSettings, saveSettings } from "./settings";
import {
  getLaps,
  getLapById,
  deleteLap,
  getSessions,
  getCorners,
  saveCorners,
  getFirstLapIdForTrack,
  getTrackOutline as getDbTrackOutline,
  getTrackOutlineSectors,
  hasRecordedOutline,
  getAnalysis,
  saveAnalysis,
} from "./db/queries";
import {
  CAR_CLASS_NAMES,
  DRIVETRAIN_NAMES,
  type TelemetryPacket,
} from "../shared/types";
import { generateExport } from "./export";
import { compareLaps } from "./comparison";
import { detectCorners, type Corner } from "./corner-detection";
import { carMap, getCarName, trackMap, getTrackName } from "../shared/car-data";
import { getTrackOutlineByOrdinal, hasTrackOutline, hasRecordedOutline, getTrackSectorsByOrdinal, getStartYaw, deleteRecordedOutline } from "../shared/track-outlines/index";
import { trackMap as trackInfoMap } from "../shared/car-data";
import { namedSegments } from "../shared/track-outlines/named-segments";
import { buildAnalystPrompt } from "./ai/analyst-prompt";

const app = new Hono();

// Enable CORS for dev
app.use("/*", cors());

// GET /api/status
app.get("/api/status", (c) => {
  const session = lapDetector.session;
  return c.json({
    udpReceiving: udpListener.receiving,
    packetsPerSec: udpListener.packetsPerSec,
    connectedClients: wsManager.connectedClients,
    droppedPackets: udpListener.droppedPackets,
    udpPort: udpListener.port,
    currentSession: session
      ? {
          id: session.sessionId,
          carOrdinal: session.carOrdinal,
          trackOrdinal: session.trackOrdinal,
          createdAt: "",
        }
      : null,
  });
});

// GET /api/settings
app.get("/api/settings", (c) => {
  const settings = loadSettings();
  return c.json({ ...settings, udpPort: udpListener.port });
});

// PUT /api/settings
app.put("/api/settings", async (c) => {
  const body = await c.req.json();
  const current = loadSettings();

  // Whitelist fields — only allow known settings to be updated
  const merged = {
    udpPort: body.udpPort ?? current.udpPort,
    temperatureUnit: body.temperatureUnit ?? current.temperatureUnit,
    speedUnit: body.speedUnit ?? current.speedUnit,
    tireTemperatureThresholds: {
      cold: body.tireTemperatureThresholds?.cold ?? current.tireTemperatureThresholds.cold,
      warm: body.tireTemperatureThresholds?.warm ?? current.tireTemperatureThresholds.warm,
      hot: body.tireTemperatureThresholds?.hot ?? current.tireTemperatureThresholds.hot,
    },
  };

  // Validate port
  const port = merged.udpPort;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return c.json({ error: "Port must be between 1024-65535" }, 400);
  }

  // Validate temperature unit
  if (merged.temperatureUnit !== "F" && merged.temperatureUnit !== "C") {
    return c.json({ error: "temperatureUnit must be 'F' or 'C'" }, 400);
  }

  // Validate speed unit
  if (merged.speedUnit !== "mph" && merged.speedUnit !== "kmh") {
    return c.json({ error: "speedUnit must be 'mph' or 'kmh'" }, 400);
  }

  // Validate threshold ordering
  const t = merged.tireTemperatureThresholds;
  if (t.cold >= t.warm || t.warm >= t.hot) {
    return c.json({ error: "Thresholds must be in order: cold < warm < hot" }, 400);
  }

  try {
    // Only restart UDP if port actually changed
    if (port !== udpListener.port) {
      await udpListener.restart(port);
    }
    saveSettings(merged);
    return c.json(merged);
  } catch {
    return c.json({ error: `Failed to bind to port ${port}` }, 500);
  }
});

// GET /api/laps
app.get("/api/laps", (c) => {
  const lapList = getLaps();
  return c.json(lapList);
});

// GET /api/laps/:id
app.get("/api/laps/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid lap ID" }, 400);

  const lap = getLapById(id);
  if (!lap) return c.json({ error: "Lap not found" }, 404);

  return c.json(lap);
});

// GET /api/laps/:id/export — plain-text summary designed for pasting into
// an LLM conversation for driving/tuning advice
app.get("/api/laps/:id/export", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid lap ID" }, 400);

  const lap = getLapById(id);
  if (!lap) return c.json({ error: "Lap not found" }, 404);

  const packets = lap.telemetry;
  if (packets.length === 0) {
    return c.json({ error: "No telemetry data" }, 400);
  }

  const exportText = generateExport(lap, packets);
  return c.text(exportText);
});

// POST /api/laps/:id/analyse — AI-powered lap analysis via Claude CLI
app.post("/api/laps/:id/analyse", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid lap ID" }, 400);

  const url = new URL(c.req.url);
  const regenerate = url.searchParams.get("regenerate") === "true";

  // Check cache first
  if (!regenerate) {
    const cached = getAnalysis(id);
    if (cached) {
      return c.json({ analysis: cached, cached: true });
    }
  }

  const lap = getLapById(id);
  if (!lap) return c.json({ error: "Lap not found" }, 404);
  if (lap.telemetry.length === 0) {
    return c.json({ error: "No telemetry data" }, 400);
  }

  // Get corner definitions for the track
  const trackOrdinal = lap.trackOrdinal ?? 0;
  const corners = trackOrdinal > 0 ? getCorners(trackOrdinal) : [];

  // Build prompt
  const prompt = buildAnalystPrompt(lap, lap.telemetry, corners);

  // Spawn claude CLI, pipe prompt via stdin
  try {
    const proc = Bun.spawn(["claude", "-p", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Write prompt to stdin (Bun.spawn stdin is a FileSink)
    proc.stdin.write(prompt);
    proc.stdin.end();

    // Start reading stdout concurrently before awaiting exit
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();

    // Set up timeout (90 seconds)
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, 90_000);

    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (timedOut) {
      return c.json({ error: "Analysis timed out" }, 504);
    }

    if (exitCode !== 0) {
      const stderr = await stderrPromise;
      console.error("[AI] Claude CLI failed:", stderr);
      return c.json({ error: "AI analysis failed. Is Claude CLI installed and authenticated?" }, 500);
    }

    const analysis = await stdoutPromise;
    if (!analysis.trim()) {
      return c.json({ error: "AI returned empty response" }, 500);
    }

    // Cache the result
    saveAnalysis(id, analysis.trim());

    return c.json({ analysis: analysis.trim(), cached: false });
  } catch (err) {
    console.error("[AI] Failed to spawn claude:", err);
    return c.json(
      { error: "Failed to run Claude CLI. Make sure 'claude' is installed and in PATH." },
      500
    );
  }
});

// DELETE /api/laps/:id
app.delete("/api/laps/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid lap ID" }, 400);

  const deleted = deleteLap(id);
  if (!deleted) return c.json({ error: "Lap not found" }, 404);

  return c.json({ success: true });
});

// GET /api/sessions
app.get("/api/sessions", (c) => {
  const sessionList = getSessions();
  return c.json(sessionList);
});

// GET /api/laps/:id1/compare/:id2 — distance-aligned delta comparison.
// Auto-detects corners on first use, caches them in DB for the track.
app.get("/api/laps/:id1/compare/:id2", (c) => {
  const id1 = parseInt(c.req.param("id1"), 10);
  const id2 = parseInt(c.req.param("id2"), 10);
  if (isNaN(id1) || isNaN(id2)) {
    return c.json({ error: "Invalid lap IDs" }, 400);
  }
  if (id1 === id2) {
    return c.json({ error: "Cannot compare a lap with itself" }, 400);
  }

  const lapA = getLapById(id1);
  if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);

  const lapB = getLapById(id2);
  if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);

  if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0) {
    return c.json({ error: "One or both laps have no telemetry data" }, 400);
  }

  // Get corner definitions for the track (use lapA's track)
  const trackOrdinal = lapA.trackOrdinal ?? 0;
  let corners = getCorners(trackOrdinal);

  // Auto-detect if no stored corners and we have a track
  if (corners.length === 0 && trackOrdinal > 0) {
    corners = detectCorners(lapA.telemetry);
    if (corners.length > 0) {
      saveCorners(trackOrdinal, corners, true);
    }
  }

  const result = compareLaps(lapA.telemetry, lapB.telemetry, corners);

  // Transform to client-expected shape
  return c.json({
    lapA: { lapNumber: lapA.lapNumber, lapTime: lapA.lapTime, isValid: lapA.isValid, trackOrdinal: lapA.trackOrdinal, carOrdinal: lapA.carOrdinal },
    lapB: { lapNumber: lapB.lapNumber, lapTime: lapB.lapTime, isValid: lapB.isValid, trackOrdinal: lapB.trackOrdinal, carOrdinal: lapB.carOrdinal },
    traces: {
      distance: result.distances,
      speedA: result.lapA.speed,
      speedB: result.lapB.speed,
      throttleA: result.lapA.throttle,
      throttleB: result.lapB.throttle,
      brakeA: result.lapA.brake,
      brakeB: result.lapB.brake,
      rpmA: result.lapA.rpm,
      rpmB: result.lapB.rpm,
      tireWearA: result.lapA.tireWear,
      tireWearB: result.lapB.tireWear,
    },
    timeDelta: result.timeDelta,
    corners: result.cornerDeltas,
    telemetryA: lapA.telemetry,
    telemetryB: lapB.telemetry,
  });
});

// GET /api/tracks/:trackOrdinal/corners — get stored corners or auto-detect
app.get("/api/tracks/:trackOrdinal/corners", (c) => {
  const trackOrdinal = parseInt(c.req.param("trackOrdinal"), 10);
  if (isNaN(trackOrdinal)) {
    return c.json({ error: "Invalid track ordinal" }, 400);
  }

  let corners = getCorners(trackOrdinal);

  // If no stored corners, try to auto-detect from a lap on this track
  if (corners.length === 0) {
    const lapId = getFirstLapIdForTrack(trackOrdinal);
    if (lapId !== null) {
      const lap = getLapById(lapId);
      if (lap && lap.telemetry.length > 0) {
        corners = detectCorners(lap.telemetry);
        if (corners.length > 0) {
          saveCorners(trackOrdinal, corners, true);
        }
      }
    }
  }

  return c.json(corners);
});

// PUT /api/tracks/:trackOrdinal/corners — save/update corner definitions
app.put("/api/tracks/:trackOrdinal/corners", async (c) => {
  const trackOrdinal = parseInt(c.req.param("trackOrdinal"), 10);
  if (isNaN(trackOrdinal)) {
    return c.json({ error: "Invalid track ordinal" }, 400);
  }

  const body = await c.req.json<Corner[]>();

  if (!Array.isArray(body)) {
    return c.json({ error: "Body must be an array of corner definitions" }, 400);
  }

  // Validate each corner
  for (const corner of body) {
    if (
      typeof corner.index !== "number" ||
      typeof corner.label !== "string" ||
      typeof corner.distanceStart !== "number" ||
      typeof corner.distanceEnd !== "number"
    ) {
      return c.json(
        { error: "Each corner must have index, label, distanceStart, distanceEnd" },
        400
      );
    }
    if (corner.distanceEnd <= corner.distanceStart) {
      return c.json(
        { error: `Corner ${corner.label}: distanceEnd must be > distanceStart` },
        400
      );
    }
  }

  saveCorners(trackOrdinal, body, false);
  return c.json({ success: true, count: body.length });
});

// GET /api/cars/:ordinal
app.get("/api/cars/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const car = carMap.get(ordinal);
  if (!car) return c.json({ error: "Car not found" }, 404);

  return c.json({ ordinal, ...car, name: `${car.year} ${car.make} ${car.model}` });
});

// GET /api/tracks/:ordinal (info)
app.get("/api/tracks/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const track = trackMap.get(ordinal);
  if (!track) return c.json({ error: "Track not found" }, 404);

  return c.json({ ordinal, ...track });
});

// GET /api/car-name/:ordinal — plain text
app.get("/api/car-name/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.text("Unknown car");
  return c.text(getCarName(ordinal));
});

// GET /api/track-name/:ordinal — plain text
app.get("/api/track-name/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.text("Unknown track");
  return c.text(getTrackName(ordinal));
});

// GET /api/track-sector-boundaries/:ordinal — returns s1End/s2End fractions for timing
app.get("/api/track-sector-boundaries/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  // Try DB first, then bundled sectors
  const dbSectors = getTrackOutlineSectors(ordinal);
  if (dbSectors) return c.json(dbSectors);

  const bundled = getTrackSectorsByOrdinal(ordinal);
  return c.json(bundled);
});

// GET /api/tracks — list all tracks with outline availability
app.get("/api/tracks", (c) => {
  const tracks = Array.from(trackInfoMap.entries()).map(([ordinal, info]) => ({
    ordinal,
    name: info.name,
    location: info.location,
    country: info.country,
    variant: info.variant,
    lengthKm: info.lengthKm,
    hasOutline: hasTrackOutline(ordinal) || hasRecordedOutline(ordinal),
  }));
  // Sort: tracks with outlines first, then alphabetically
  tracks.sort((a, b) => {
    if (a.hasOutline !== b.hasOutline) return a.hasOutline ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return c.json(tracks);
});

// User-edited segments storage — one JSON file per track in shared/track-outlines/segments/
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { resolve } from "path";

const TRACK_DATA_DIR = resolve(__dirname, "../shared/track-outlines/tracks");
const userSegmentsStore: Map<number, any[]> = new Map();

// Load user segments from track data files on startup
if (existsSync(TRACK_DATA_DIR)) {
  try {
    for (const file of readdirSync(TRACK_DATA_DIR)) {
      if (!file.endsWith(".json")) continue;
      const ordinal = parseInt(file.replace(".json", ""), 10);
      if (isNaN(ordinal)) continue;
      const filePath = resolve(TRACK_DATA_DIR, `${ordinal}.json`);
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      if (data?.segments && Array.isArray(data.segments)) {
        userSegmentsStore.set(ordinal, data.segments);
      }
    }
  } catch {}
}

function loadTrackDataFile(ordinal: number): { outline?: any[]; segments?: any[] } | null {
  const filePath = resolve(TRACK_DATA_DIR, `${ordinal}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch { return null; }
}

function saveTrackDataFile(ordinal: number, updates: { outline?: { x: number; z: number }[]; segments?: any[] }) {
  try {
    if (!existsSync(TRACK_DATA_DIR)) mkdirSync(TRACK_DATA_DIR, { recursive: true });
    const trackInfo = trackInfoMap.get(ordinal);
    const name = trackInfo?.name ?? `Track ${ordinal}`;

    // Merge with existing data
    const existing = loadTrackDataFile(ordinal) ?? {};
    const payload: any = { name, ordinal, ...existing, ...updates };
    if (updates.outline) payload.points = updates.outline.length;

    writeFileSync(resolve(TRACK_DATA_DIR, `${ordinal}.json`), JSON.stringify(payload));
    console.log(`[Track] Saved track data for ${name} (${ordinal})`);
  } catch (e) {
    console.error("[Track] Failed to save track data:", e);
  }
}

function saveUserSegmentsForTrack(ordinal: number, segments: any[]) {
  saveTrackDataFile(ordinal, { segments });
}

// PUT /api/tracks/:trackOrdinal/segments — save user-edited segments
app.put("/api/tracks/:trackOrdinal/segments", async (c) => {
  const trackOrdinal = parseInt(c.req.param("trackOrdinal"), 10);
  if (isNaN(trackOrdinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const body = await c.req.json();
  if (!body.segments || !Array.isArray(body.segments)) {
    return c.json({ error: "segments array required" }, 400);
  }
  userSegmentsStore.set(trackOrdinal, body.segments);
  saveUserSegmentsForTrack(trackOrdinal, body.segments);
  return c.json({ success: true, count: body.segments.length });
});

// GET /api/track-sectors/:ordinal — returns user-edited, named, or auto-detected segments.
app.get("/api/track-sectors/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  // 1. User-edited segments (highest priority)
  const userSegs = userSegmentsStore.get(ordinal);
  if (userSegs && userSegs.length > 0) {
    return c.json({ segments: userSegs, totalDist: 0, source: "user" });
  }

  // 2. Hand-curated named segments from code
  const trackInfo = trackInfoMap.get(ordinal);
  if (trackInfo) {
    const named = namedSegments[trackInfo.name];
    if (named) {
      return c.json({
        segments: named.map((s) => ({
          ...s,
          startIdx: 0,
          endIdx: 0,
          distStart: 0,
          distEnd: 0,
        })),
        totalDist: 0,
        source: "named",
      });
    }
  }

  // Fall back to auto-detection from outline curvature
  let outline = getTrackOutlineByOrdinal(ordinal);
  if (!outline) {
    const recorded = getDbTrackOutline(ordinal);
    if (recorded) {
      outline = recorded.map((p: { x: number; z: number }) => ({ x: p.x, z: p.z }));
    }
  }
  if (!outline || outline.length < 20) return c.json({ segments: [] });

  const n = outline.length;

  // Compute cumulative distance
  const dists = [0];
  for (let i = 1; i < n; i++) {
    const dx = outline[i].x - outline[i - 1].x;
    const dz = outline[i].z - outline[i - 1].z;
    dists.push(dists[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  const totalDist = dists[n - 1];

  // Compute curvature at each point using angle change over a window
  const window = Math.max(3, Math.floor(n / 80));
  const signedCurvature: number[] = [];
  const curvature: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - window + n) % n;
    const next = (i + window) % n;
    const dx1 = outline[i].x - outline[prev].x;
    const dz1 = outline[i].z - outline[prev].z;
    const dx2 = outline[next].x - outline[i].x;
    const dz2 = outline[next].z - outline[i].z;
    const angle1 = Math.atan2(dz1, dx1);
    const angle2 = Math.atan2(dz2, dx2);
    let diff = angle2 - angle1;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    signedCurvature.push(diff);
    curvature.push(Math.abs(diff));
  }

  // Smooth curvature
  const smoothWindow = Math.max(2, Math.floor(n / 60));
  const smoothed: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = -smoothWindow; j <= smoothWindow; j++) {
      sum += curvature[(i + j + n) % n];
    }
    smoothed.push(sum / (smoothWindow * 2 + 1));
  }

  // Threshold: 54th percentile — slightly above median to avoid classifying
  // gentle curves as corners, making corner starts tighter and straights longer
  const sorted = [...smoothed].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(n * 0.54)];

  // Build segments by classifying each point
  type Seg = { type: "corner" | "straight"; startIdx: number; endIdx: number; startFrac: number; endFrac: number };
  const segments: Seg[] = [];
  let currentType: "corner" | "straight" = smoothed[0] > threshold ? "corner" : "straight";
  let segStart = 0;

  for (let i = 1; i < n; i++) {
    const type = smoothed[i] > threshold ? "corner" : "straight";
    if (type !== currentType) {
      segments.push({ type: currentType, startFrac: segStart / n, endFrac: i / n, startIdx: segStart, endIdx: i });
      currentType = type;
      segStart = i;
    }
  }
  segments.push({ type: currentType, startFrac: segStart / n, endFrac: 1, startIdx: segStart, endIdx: n - 1 });

  // Merge tiny segments (< 1.5% of track) into neighbor
  const pass1: Seg[] = [];
  for (const seg of segments) {
    if ((seg.endFrac - seg.startFrac) < 0.015 && pass1.length > 0) {
      pass1[pass1.length - 1].endFrac = seg.endFrac;
      pass1[pass1.length - 1].endIdx = seg.endIdx;
    } else {
      pass1.push({ ...seg });
    }
  }

  // Consolidate adjacent same-type segments
  const merged: Seg[] = [];
  for (const seg of pass1) {
    if (merged.length > 0 && merged[merged.length - 1].type === seg.type) {
      merged[merged.length - 1].endFrac = seg.endFrac;
      merged[merged.length - 1].endIdx = seg.endIdx;
    } else {
      merged.push({ ...seg });
    }
  }

  // Name segments with direction for corners
  let cornerNum = 1;
  let straightNum = 1;
  const named = merged.map((seg) => {
    let name: string;
    let direction: "left" | "right" | null = null;

    if (seg.type === "corner") {
      // Sum signed curvature over the segment to determine direction
      let sumCurv = 0;
      for (let i = seg.startIdx; i <= Math.min(seg.endIdx, n - 1); i++) {
        sumCurv += signedCurvature[i];
      }
      direction = sumCurv > 0 ? "right" : "left";
      name = `T${cornerNum++} ${direction === "left" ? "L" : "R"}`;
    } else {
      name = `S${straightNum++}`;
    }

    return {
      ...seg,
      name,
      direction,
      distStart: dists[seg.startIdx],
      distEnd: seg.endIdx < n ? dists[seg.endIdx] : totalDist,
    };
  });

  return c.json({ segments: named, totalDist });
});

// POST /api/tracks/:trackOrdinal/recompute-outline — rebuild outline from stored laps
import {
  filterLapOutliers,
  normalizeToFixedPoints,
  averageOutlines,
  smoothOutline,
  computeSectorsFromGeometry,
} from "./lap-detector";
import { saveTrackOutline } from "./db/queries";

app.post("/api/tracks/:trackOrdinal/recompute-outline", async (c) => {
  const trackOrdinal = parseInt(c.req.param("trackOrdinal"), 10);
  if (isNaN(trackOrdinal)) return c.json({ error: "Invalid ordinal" }, 400);

  // Check for ?lapId= query param to use a single lap directly
  const lapIdParam = new URL(c.req.url).searchParams.get("lapId");

  if (lapIdParam) {
    // Single lap mode — use its telemetry directly as the outline
    const lapId = parseInt(lapIdParam, 10);
    const lapData = getLapById(lapId);
    if (!lapData || !lapData.telemetry) {
      return c.json({ error: `Lap ${lapId} not found` }, 404);
    }

    let raw: { x: number; z: number }[] = [];
    for (const p of lapData.telemetry) {
      if (p.PositionX === 0 && p.PositionZ === 0) continue;
      raw.push({ x: p.PositionX, z: p.PositionZ });
    }
    if (raw.length < 50) {
      return c.json({ error: "Not enough telemetry data" }, 400);
    }

    // Light smoothing to clean up noise while preserving shape
    let outline = smoothOutline(raw, 5);

    const sectors = computeSectorsFromGeometry(outline);
    saveTrackOutline(trackOrdinal, outline, sectors);
    saveTrackDataFile(trackOrdinal, { outline });

    return c.json({
      success: true,
      lapsUsed: 1,
      lapId,
      points: outline.length,
      message: `Saved outline from lap ${lapId} (${outline.length} points)`,
    });
  }

  // Multi-lap mode — average best laps
  const allLaps = getLaps().filter(
    (l) => l.trackOrdinal === trackOrdinal && l.lapTime > 0
  );
  if (allLaps.length === 0) {
    return c.json({ error: "No laps found for this track" }, 404);
  }

  const sorted = [...allLaps].sort((a, b) => a.lapTime - b.lapTime);
  const bestLaps = sorted.slice(0, 10);

  const SAMPLE_POINTS = 1000;
  const normalized: { x: number; z: number; speed: number }[][] = [];
  const startPositions: { x: number; z: number }[] = [];

  for (const lapMeta of bestLaps) {
    const lapData = getLapById(lapMeta.id);
    if (!lapData || !lapData.telemetry || lapData.telemetry.length < 50) continue;

    let raw: { x: number; z: number; speed: number }[] = [];
    for (const p of lapData.telemetry) {
      if (p.PositionX === 0 && p.PositionZ === 0) continue;
      raw.push({ x: p.PositionX, z: p.PositionZ, speed: (p.Speed ?? 0) * 2.23694 });
    }
    raw = filterLapOutliers(raw);
    if (raw.length < 50) continue;

    const norm = normalizeToFixedPoints(raw, SAMPLE_POINTS);
    if (norm.length === SAMPLE_POINTS) {
      normalized.push(norm);
      const last = raw[raw.length - 1];
      startPositions.push({ x: last.x, z: last.z });
    }
  }

  if (normalized.length === 0) {
    return c.json({ error: "No usable telemetry data" }, 400);
  }

  const averaged = averageOutlines(normalized);
  let outline = smoothOutline(smoothOutline(averaged, 9), 7);

  if (startPositions.length > 0) {
    let sx = 0, sz = 0;
    for (const p of startPositions) { sx += p.x; sz += p.z; }
    const avgStart = { x: sx / startPositions.length, z: sz / startPositions.length };

    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < outline.length; i++) {
      const dx = outline[i].x - avgStart.x;
      const dz = outline[i].z - avgStart.z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx > 0) {
      outline = [...outline.slice(bestIdx), ...outline.slice(0, bestIdx)];
    }
  }

  const sectors = computeSectorsFromGeometry(outline);
  saveTrackOutline(trackOrdinal, outline, sectors);
  saveTrackDataFile(trackOrdinal, { outline });

  return c.json({
    success: true,
    lapsUsed: normalized.length,
    points: outline.length,
    message: `Recomputed outline from ${normalized.length} laps (${SAMPLE_POINTS} points)`,
  });
});

// GET /api/tracks/:trackOrdinal/leaderboard — fastest laps grouped by PI class
app.get("/api/tracks/:trackOrdinal/leaderboard", (c) => {
  const trackOrdinal = parseInt(c.req.param("trackOrdinal"), 10);
  if (isNaN(trackOrdinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const trackLaps = getLaps().filter(
    (l) => l.trackOrdinal === trackOrdinal && l.lapTime > 0
  );

  // For each lap, get car info from first telemetry packet
  const entries: {
    lapId: number;
    lapNumber: number;
    lapTime: number;
    carOrdinal: number;
    carName: string;
    carClass: string;
    pi: number;
  }[] = [];

  for (const lap of trackLaps) {
    const lapData = getLapById(lap.id);
    if (!lapData?.telemetry?.length) continue;
    const first = lapData.telemetry[0];
    const pi = first.CarPerformanceIndex ?? 0;
    const cls = CAR_CLASS_NAMES[first.CarClass] ?? "?";
    const carName = getCarName(lap.carOrdinal ?? first.CarOrdinal ?? 0);
    entries.push({
      lapId: lap.id,
      lapNumber: lap.lapNumber,
      lapTime: lap.lapTime,
      carOrdinal: lap.carOrdinal ?? first.CarOrdinal ?? 0,
      carName,
      carClass: cls,
      pi,
    });
  }

  // Group by PI class bracket: D(100-299), C(300-399), B(400-499), A(500-599), S1(600-699), S2(700-799), R(800-899), P(900-998), X(999)
  const piClass = (pi: number): string => {
    if (pi >= 999) return "X";
    if (pi >= 900) return "P";
    if (pi >= 800) return "R";
    if (pi >= 700) return "S2";
    if (pi >= 600) return "S1";
    if (pi >= 500) return "A";
    if (pi >= 400) return "B";
    if (pi >= 300) return "C";
    return "D";
  };

  const grouped: Record<string, typeof entries> = {};
  for (const e of entries) {
    const cls = piClass(e.pi);
    if (!grouped[cls]) grouped[cls] = [];
    grouped[cls].push(e);
  }

  // Sort each group by lap time, keep top 5 per class
  const result: Record<string, typeof entries> = {};
  const classOrder = ["X", "P", "R", "S2", "S1", "A", "B", "C", "D"];
  for (const cls of classOrder) {
    if (grouped[cls]) {
      result[cls] = grouped[cls].sort((a, b) => a.lapTime - b.lapTime).slice(0, 5);
    }
  }

  return c.json(result);
});

// GET /api/track-calibration/:ordinal — calibration status
import { getCalibrationStatus, getNormalizedPosition } from "./track-calibration";
app.get("/api/track-calibration/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);
  return c.json(getCalibrationStatus(ordinal));
});

// GET /api/fuel-history — fuel usage per lap
app.get("/api/fuel-history", (c) => {
  return c.json(lapDetector.fuelHistory);
});

// GET /api/tire-wear-history — tire wear per lap
app.get("/api/tire-wear-history", (c) => {
  return c.json(lapDetector.tireWearHistory);
});

// GET /api/grip-history — server-side grip ring buffer
app.get("/api/grip-history", (c) => {
  return c.json(wsManager.getGripHistory());
});

// GET /api/telemetry-history — full 60s telemetry history
app.get("/api/telemetry-history", (c) => {
  return c.json(wsManager.getTelemetryHistory());
});

// DELETE /api/laps — bulk delete. Iterates individually because deleteLap
// also cleans up associated telemetry blobs.
app.delete("/api/laps", (c) => {
  const laps = getLaps();
  let count = 0;
  for (const lap of laps) {
    if (deleteLap(lap.id)) count++;
  }
  return c.json({ deleted: count });
});

// GET /api/track-outline/:ordinal — track outline coordinates.
// Returns { points, recorded } so the client knows if coords are Forza-native
// (recorded=true, direct plotting) or external (recorded=false, distance-based mapping).
app.get("/api/track-outline/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const startYaw = getStartYaw(ordinal);

  // 1. Prefer DB-recorded outlines (recomputed or captured from telemetry — Forza coords)
  const dbOutline = getDbTrackOutline(ordinal);
  if (dbOutline) return c.json({ points: dbOutline, recorded: true, startYaw });

  // 2. Recorded outlines from bundled data (in Forza coords)
  if (hasRecordedOutline(ordinal)) {
    return c.json({ points: getTrackOutlineByOrdinal(ordinal), recorded: true, startYaw });
  }

  // 3. Bundled external outlines (different coord system — need distance mapping)
  const bundled = getTrackOutlineByOrdinal(ordinal);
  if (bundled) return c.json({ points: bundled, recorded: false, startYaw });

  return c.json({ error: "No outline available" }, 404);
});

// DELETE /api/track-outline/:ordinal — delete recorded outline for a track
app.delete("/api/track-outline/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const deleted = deleteRecordedOutline(ordinal);
  return c.json({ success: true, hadRecorded: deleted });
});

export default app;
