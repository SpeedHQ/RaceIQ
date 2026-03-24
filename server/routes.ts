import { Hono } from "hono";
import { cors } from "hono/cors";
import { udpListener } from "./udp";
import { wsManager } from "./ws";
import { lapDetector } from "./lap-detector";
import { loadSettings, saveSettings, PartialSettingsSchema } from "./settings";
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
  updateTrackOutlineSectors,
  hasRecordedOutline,
  getTrackOutlineMetadata,
  getAnalysis,
  saveAnalysis,
  getProfiles,
  insertProfile,
  updateProfile,
  deleteProfile,
} from "./db/queries";
import {
  DRIVETRAIN_NAMES,
  type TelemetryPacket,
} from "../shared/types";
import type { Tune } from "../shared/types";
import { generateExport } from "./export";
import { compareLaps } from "./comparison";
import { detectCorners, type Corner } from "./corner-detection";
import { carMap, getCarName, getCarSpecs, trackMap, getTrackName } from "../shared/car-data";
import { getTrackOutlineByOrdinal, getBundledOutlineByOrdinal, hasTrackOutline, hasRecordedOutline, getTrackSectorsByOrdinal, getStartYaw, deleteRecordedOutline, getTrackBoundariesByOrdinal, getTrackCurbs, extractCurbSegments, recordCurbData } from "../shared/track-outlines/index";
import { trackMap as trackInfoMap } from "../shared/car-data";
import { namedSegments } from "../shared/track-outlines/named-segments";
import { buildAnalystPrompt } from "./ai/analyst-prompt";
import { tuneRoutes } from "./routes/tune-routes";
import { getTuneById as getDbTune } from "./db/tune-queries";

const app = new Hono();

// Enable CORS for dev
app.use("/*", cors());

// Mount tune routes
app.route("/", tuneRoutes);

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

  // Validate incoming partial settings
  const parseResult = PartialSettingsSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: parseResult.error.issues.map((i) => i.message).join(", ") }, 400);
  }

  const current = loadSettings();
  const merged = { ...current, ...parseResult.data };

  // Deep merge nested objects
  if (parseResult.data.tireTempCelsiusThresholds) {
    merged.tireTempCelsiusThresholds = { ...current.tireTempCelsiusThresholds, ...parseResult.data.tireTempCelsiusThresholds };
  }

  // Validate threshold ordering
  const t = merged.tireTempCelsiusThresholds;
  if (t.cold >= t.warm || t.warm >= t.hot) {
    return c.json({ error: "Thresholds must be in order: cold < warm < hot" }, 400);
  }

  // Validate ascending order for array thresholds
  for (const [name, arr] of [["tireHealthThresholds", merged.tireHealthThresholds.values], ["suspensionThresholds", merged.suspensionThresholds.values]] as const) {
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] <= arr[i - 1]) return c.json({ error: `${name} must be in ascending order` }, 400);
    }
  }

  try {
    // Only restart UDP if port actually changed
    if (merged.udpPort !== udpListener.port) {
      await udpListener.restart(merged.udpPort);
    }
    saveSettings(merged);
    return c.json(merged);
  } catch {
    return c.json({ error: `Failed to bind to port ${merged.udpPort}` }, 500);
  }
});

// GET /api/profiles
app.get("/api/profiles", (c) => {
  return c.json(getProfiles());
});

// POST /api/profiles
app.post("/api/profiles", async (c) => {
  const body = await c.req.json();
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "Name is required" }, 400);
  const id = insertProfile(name);
  return c.json({ id, name }, 201);
});

// PATCH /api/profiles/:id
app.patch("/api/profiles/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid profile ID" }, 400);
  const body = await c.req.json();
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "Name is required" }, 400);
  const ok = updateProfile(id, name);
  if (!ok) return c.json({ error: "Profile not found" }, 404);
  return c.json({ id, name });
});

// DELETE /api/profiles/:id
app.delete("/api/profiles/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid profile ID" }, 400);
  // Block deleting the last profile
  const all = getProfiles();
  if (all.length <= 1) return c.json({ error: "Cannot delete the last profile" }, 400);
  const ok = deleteProfile(id);
  if (!ok) return c.json({ error: "Profile not found" }, 404);
  return c.json({ ok: true });
});

// GET /api/stats — aggregate stats across all laps
app.get("/api/stats", (c) => {
  const allLaps = getLaps();
  const validLaps = allLaps.filter((l) => l.isValid && l.lapTime > 0);

  // Total distance: sum track length * laps per track
  const lapsByTrack = new Map<number, number>();
  for (const lap of allLaps) {
    if (lap.trackOrdinal && lap.lapTime > 0) {
      lapsByTrack.set(lap.trackOrdinal, (lapsByTrack.get(lap.trackOrdinal) ?? 0) + 1);
    }
  }
  let totalDistanceMeters = 0;
  for (const [trackOrd, count] of lapsByTrack) {
    const outline = getTrackOutlineByOrdinal(trackOrd);
    if (outline && outline.length > 1) {
      let trackLen = 0;
      for (let i = 1; i < outline.length; i++) {
        const dx = outline[i].x - outline[i - 1].x;
        const dz = outline[i].z - outline[i - 1].z;
        trackLen += Math.sqrt(dx * dx + dz * dz);
      }
      totalDistanceMeters += trackLen * count;
    }
  }

  // Total time driven
  const totalTime = allLaps.reduce((s, l) => s + (l.lapTime > 0 ? l.lapTime : 0), 0);

  return c.json({
    totalLaps: allLaps.length,
    validLaps: validLaps.length,
    totalDistanceMeters,
    totalTimeSec: totalTime,
    uniqueTracks: lapsByTrack.size,
    uniqueCars: new Set(allLaps.map((l) => l.carOrdinal).filter(Boolean)).size,
  });
});

// GET /api/laps
app.get("/api/laps", (c) => {
  const profileIdParam = c.req.query("profileId");
  const profileIdParsed = profileIdParam ? parseInt(profileIdParam, 10) : undefined;
  const profileId = profileIdParsed !== undefined && !isNaN(profileIdParsed) ? profileIdParsed : undefined;
  const lapList = getLaps(profileId);
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
      return c.json({
        analysis: cached.analysis,
        cached: true,
        usage: {
          inputTokens: cached.inputTokens,
          outputTokens: cached.outputTokens,
          costUsd: cached.costUsd,
          durationMs: cached.durationMs,
          model: cached.model,
        },
      });
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

  // Load user settings for unit conversion
  const settings = loadSettings();
  // Look up tune for this lap
  let parsedTune: Tune | undefined;
  if (lap.tuneId) {
    const dbTune = getDbTune(lap.tuneId);
    if (dbTune) {
      parsedTune = {
        ...dbTune,
        strengths: dbTune.strengths ? JSON.parse(dbTune.strengths) : [],
        weaknesses: dbTune.weaknesses ? JSON.parse(dbTune.weaknesses) : [],
        bestTracks: dbTune.bestTracks ? JSON.parse(dbTune.bestTracks) : [],
        strategies: dbTune.strategies ? JSON.parse(dbTune.strategies) : [],
        settings: JSON.parse(dbTune.settings),
      } as Tune;
    }
  }

  // Build prompt
  const prompt = buildAnalystPrompt(lap, lap.telemetry, corners, settings.unit, parsedTune);

  // Spawn claude CLI, pipe prompt via stdin
  try {
    const proc = Bun.spawn(["claude", "-p", "-", "--model", "haiku", "--output-format", "json"], {
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

    const raw = await stdoutPromise;
    if (!raw.trim()) {
      return c.json({ error: "AI returned empty response" }, 500);
    }

    // Parse the Claude CLI JSON envelope
    let envelope: any;
    try {
      envelope = JSON.parse(raw.trim());
    } catch {
      console.error("[AI] Claude returned invalid envelope:", raw.slice(0, 200));
      return c.json({ error: "AI returned invalid response format" }, 500);
    }

    const resultText = envelope.result ?? "";
    if (!resultText.trim()) {
      return c.json({ error: "AI returned empty result" }, 500);
    }

    // Extract the analysis JSON from the result (may be wrapped in markdown fences)
    let jsonStr = resultText.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // Validate analysis JSON
    try {
      JSON.parse(jsonStr);
    } catch {
      console.error("[AI] Claude returned invalid analysis JSON:", jsonStr.slice(0, 200));
      return c.json({ error: "AI returned invalid analysis format" }, 500);
    }

    // Extract usage stats
    const usage = {
      inputTokens: (envelope.usage?.input_tokens ?? 0) +
        (envelope.usage?.cache_read_input_tokens ?? 0) +
        (envelope.usage?.cache_creation_input_tokens ?? 0),
      outputTokens: envelope.usage?.output_tokens ?? 0,
      costUsd: envelope.total_cost_usd ?? 0,
      durationMs: envelope.duration_ms ?? 0,
      model: Object.keys(envelope.modelUsage ?? {})[0] ?? "unknown",
    };

    // Cache the validated JSON string with usage
    saveAnalysis(id, jsonStr, usage);

    return c.json({ analysis: jsonStr, cached: false, usage });
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

// GET /api/cars — list all cars
app.get("/api/cars", (c) => {
  const cars = Array.from(carMap.entries()).map(([ordinal, car]) => ({
    ordinal,
    name: `${car.year} ${car.make} ${car.model}`,
    specs: getCarSpecs(ordinal),
  }));
  cars.sort((a, b) => a.name.localeCompare(b.name));
  return c.json(cars);
});

// GET /api/cars/:ordinal
app.get("/api/cars/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const car = carMap.get(ordinal);
  if (!car) return c.json({ error: "Car not found" }, 404);

  return c.json({ ordinal, ...car, name: `${car.year} ${car.make} ${car.model}`, specs: getCarSpecs(ordinal) });
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
// Also includes trackLength (meters) computed from the outline so the client
// can show live sector times without needing to complete a full lap first.
app.get("/api/track-sector-boundaries/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  // Try DB first, then bundled sectors
  const dbSectors = getTrackOutlineSectors(ordinal);
  const bundled = dbSectors ?? getTrackSectorsByOrdinal(ordinal);

  // Compute track length from outline
  let trackLength = 0;
  const outline = getTrackOutlineByOrdinal(ordinal);
  if (outline && outline.length > 1) {
    for (let i = 1; i < outline.length; i++) {
      const dx = outline[i].x - outline[i - 1].x;
      const dz = outline[i].z - outline[i - 1].z;
      trackLength += Math.sqrt(dx * dx + dz * dz);
    }
  }

  return c.json({ ...bundled, trackLength });
});

// PUT /api/track-sector-boundaries/:ordinal — update s1End/s2End fractions
app.put("/api/track-sector-boundaries/:ordinal", async (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const body = await c.req.json();
  const { s1End, s2End } = body;
  if (typeof s1End !== "number" || typeof s2End !== "number") {
    return c.json({ error: "s1End and s2End numbers required" }, 400);
  }
  if (s1End <= 0 || s1End >= s2End || s2End >= 1) {
    return c.json({ error: "Invalid sector boundaries: need 0 < s1End < s2End < 1" }, 400);
  }

  const updated = updateTrackOutlineSectors(ordinal, { s1End, s2End });
  if (!updated) return c.json({ error: "No outline found for track" }, 404);

  saveTrackDataFile(ordinal, { sectors: { s1End, s2End } });
  return c.json({ success: true, s1End, s2End });
});

// GET /api/tracks — list all tracks with outline availability
app.get("/api/tracks", (c) => {
  const tracks = Array.from(trackInfoMap.entries()).map(([ordinal, info]) => {
    const hasOutline = hasTrackOutline(ordinal) || hasRecordedOutline(ordinal);
    const metadata = hasOutline ? getTrackOutlineMetadata(ordinal) : null;
    return {
      ordinal,
      name: info.name,
      location: info.location,
      country: info.country,
      variant: info.variant,
      lengthKm: info.lengthKm,
      hasOutline,
      createdAt: metadata?.createdAt ?? null,
    };
  });
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

function saveTrackDataFile(ordinal: number, updates: { outline?: { x: number; z: number }[]; segments?: any[]; sectors?: { s1End: number; s2End: number } }) {
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

  const rawLaps: { x: number; z: number; speed: number }[][] = [];
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

    rawLaps.push(raw);
    const last = raw[raw.length - 1];
    startPositions.push({ x: last.x, z: last.z });
  }

  // Normalize all laps to the same point count (max raw count) for averaging
  const maxPoints = Math.max(...rawLaps.map(l => l.length));
  const normalized = rawLaps.map(l =>
    l.length === maxPoints ? l : normalizeToFixedPoints(l, maxPoints)
  );

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
    message: `Recomputed outline from ${normalized.length} laps (${outline.length} points)`,
  });
});

// GET /api/tracks/:trackOrdinal/leaderboard — fastest laps grouped by PI class
app.get("/api/tracks/:trackOrdinal/leaderboard", (c) => {
  const trackOrdinal = parseInt(c.req.param("trackOrdinal"), 10);
  if (isNaN(trackOrdinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const profileIdParam = c.req.query("profileId");
  const profileIdParsed = profileIdParam ? parseInt(profileIdParam, 10) : undefined;
  const profileId = profileIdParsed !== undefined && !isNaN(profileIdParsed) ? profileIdParsed : undefined;

  const trackLaps = getLaps(profileId).filter(
    (l) => l.trackOrdinal === trackOrdinal && l.lapTime > 0
  );

  // Derive class letter from PI value
  const piClass = (pi: number): string => {
    if (pi >= 999) return "X";
    if (pi >= 900) return "P";
    if (pi >= 700) return "R";
    if (pi >= 600) return "S";
    if (pi >= 500) return "A";
    if (pi >= 400) return "B";
    if (pi >= 300) return "C";
    if (pi >= 200) return "D";
    return "E";
  };

  const entries = trackLaps.map((lap) => {
    const pi = lap.pi ?? 0;
    return {
      lapId: lap.id,
      lapNumber: lap.lapNumber,
      lapTime: lap.lapTime,
      carOrdinal: lap.carOrdinal ?? 0,
      carName: getCarName(lap.carOrdinal ?? 0),
      carClass: piClass(pi),
      pi,
      createdAt: lap.createdAt,
    };
  });

  const grouped: Record<string, typeof entries> = {};
  for (const e of entries) {
    const cls = piClass(e.pi);
    if (!grouped[cls]) grouped[cls] = [];
    grouped[cls].push(e);
  }

  // Sort each group by lap time, keep top 5 per class
  const result: Record<string, typeof entries> = {};
  const classOrder = ["X", "P", "R", "S", "A", "B", "C", "D", "E"];
  for (const cls of classOrder) {
    if (grouped[cls]) {
      result[cls] = grouped[cls].sort((a, b) => a.lapTime - b.lapTime).slice(0, 5);
    }
  }

  return c.json(result);
});

// GET /api/track-calibration/:ordinal — calibration status
import { getCalibrationStatus, getNormalizedPosition, transformToForzaSpace, computeStaticAlignment, refineAlignmentWithCurbs, clearCurbRefinement, calibrateFromPositions } from "./track-calibration";
app.get("/api/track-calibration/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);
  return c.json(getCalibrationStatus(ordinal));
});

// POST /api/track-calibration/:ordinal/from-lap — calibrate using a stored lap's positions
app.post("/api/track-calibration/:ordinal/from-lap", async (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const body = await c.req.json<{ lapId: number }>();
  if (!body?.lapId) return c.json({ error: "lapId required" }, 400);

  const lapData = getLapById(body.lapId);
  if (!lapData) return c.json({ error: "Lap not found" }, 404);
  if (lapData.trackOrdinal !== ordinal) return c.json({ error: "Lap is not from this track" }, 400);
  if (!lapData.telemetry || lapData.telemetry.length < 50) {
    return c.json({ error: "Lap has insufficient telemetry data" }, 400);
  }

  // Get the track outline
  const outline = getTrackOutlineByOrdinal(ordinal);
  if (!outline || outline.length === 0) return c.json({ error: "No outline available for this track" }, 400);

  // Extract positions from telemetry
  const positions = lapData.telemetry.map(p => ({ x: p.PositionX, z: p.PositionZ }));

  const success = calibrateFromPositions(ordinal, positions, outline);
  if (!success) return c.json({ error: "Calibration failed — not enough valid position points" }, 400);

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

// POST /api/laps/bulk-delete — selective bulk delete by IDs.
app.post("/api/laps/bulk-delete", async (c) => {
  const body = await c.req.json<{ ids?: number[] }>();
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: "ids array required" }, 400);
  }
  let count = 0;
  for (const id of ids) {
    if (typeof id === "number" && deleteLap(id)) count++;
  }
  return c.json({ deleted: count });
});

// DELETE /api/laps — bulk delete ALL. Iterates individually because deleteLap
// also cleans up associated telemetry blobs.
app.delete("/api/laps", (c) => {
  const laps = getLaps();
  let count = 0;
  for (const lap of laps) {
    if (deleteLap(lap.id)) count++;
  }
  return c.json({ deleted: count });
});

// GET /api/tracks/:ordinal/lap-sectors — compute sector times for all laps on a track.
// Uses the track's sector boundaries (s1End, s2End fractions) and each lap's telemetry
// to find where sector crossings happen and compute split times.
app.get("/api/tracks/:ordinal/lap-sectors", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  // Get sector boundaries
  const dbSectors = getTrackOutlineSectors(ordinal);
  const bundled = getTrackSectorsByOrdinal(ordinal);
  const sectors = dbSectors ?? bundled;
  if (!sectors?.s1End || !sectors?.s2End) return c.json({});

  const trackLaps = getLaps().filter((l) => l.trackOrdinal === ordinal && l.lapTime > 0);
  if (trackLaps.length === 0) return c.json({});

  const result: Record<number, { s1: number; s2: number; s3: number }> = {};

  for (const lapMeta of trackLaps) {
    const lapData = getLapById(lapMeta.id);
    if (!lapData?.telemetry || lapData.telemetry.length < 50) continue;

    const packets = lapData.telemetry;
    const startDist = packets[0].DistanceTraveled;
    const endDist = packets[packets.length - 1].DistanceTraveled;
    const totalDist = endDist - startDist;
    if (totalDist < 100) continue;

    let s1Time = 0;
    let s2Time = 0;
    let currentSector = 0;
    let sectorStartTime = packets[0].CurrentLap;

    for (const p of packets) {
      const frac = (p.DistanceTraveled - startDist) / totalDist;
      const expectedSector = frac < sectors.s1End ? 0 : frac < sectors.s2End ? 1 : 2;

      if (expectedSector > currentSector) {
        const sectorTime = p.CurrentLap - sectorStartTime;
        if (currentSector === 0) s1Time = sectorTime;
        else if (currentSector === 1) s2Time = sectorTime;
        sectorStartTime = p.CurrentLap;
        currentSector = expectedSector;
      }
    }

    if (s1Time > 0 && s2Time > 0) {
      const s3Time = lapMeta.lapTime - s1Time - s2Time;
      result[lapMeta.id] = { s1: s1Time, s2: s2Time, s3: Math.max(0, s3Time) };
    }
  }

  return c.json(result);
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

/**
 * Local boundary warping: for each boundary point, find the nearest curb point.
 * If within range, blend the boundary point toward the curb position.
 * Uses a Gaussian-like falloff so the warp is smooth.
 */
function warpBoundaryToCurbs(
  boundary: { x: number; z: number }[],
  curbPoints: { x: number; z: number }[],
  maxDist = 30, // max influence radius in meters
  strength = 0.7 // 0=no warp, 1=snap to curb
): void {
  if (curbPoints.length === 0) return;

  for (let i = 0; i < boundary.length; i++) {
    const bp = boundary[i];
    let nearestDist = Infinity;
    let nearestCurb: { x: number; z: number } | null = null;

    for (const cp of curbPoints) {
      const dx = bp.x - cp.x;
      const dz = bp.z - cp.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < nearestDist) {
        nearestDist = d;
        nearestCurb = cp;
      }
    }

    if (nearestCurb && nearestDist < maxDist) {
      // Gaussian falloff: full strength at 0, fades to 0 at maxDist
      const t = strength * Math.exp(-(nearestDist * nearestDist) / (2 * (maxDist / 3) ** 2));
      boundary[i] = {
        x: bp.x + (nearestCurb.x - bp.x) * t,
        z: bp.z + (nearestCurb.z - bp.z) * t,
      };
    }
  }
}

/**
 * Smooth a boundary using a moving average to remove jaggedness from warping.
 * Runs `passes` iterations of a 5-point weighted average.
 */
function smoothBoundary(boundary: { x: number; z: number }[], passes = 3): void {
  for (let p = 0; p < passes; p++) {
    const orig = boundary.map(pt => ({ ...pt }));
    for (let i = 2; i < boundary.length - 2; i++) {
      boundary[i] = {
        x: (orig[i - 2].x + orig[i - 1].x * 2 + orig[i].x * 4 + orig[i + 1].x * 2 + orig[i + 2].x) / 10,
        z: (orig[i - 2].z + orig[i - 1].z * 2 + orig[i].z * 4 + orig[i + 1].z * 2 + orig[i + 2].z) / 10,
      };
    }
  }
}

// GET /api/track-boundaries/:ordinal — track boundary edges (left/right + pit lane)
// Returns boundary data in the same coordinate system as the outline.
app.get("/api/track-boundaries/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const boundaries = getTrackBoundariesByOrdinal(ordinal);
  if (!boundaries) return c.json({ error: "No boundary data available" }, 404);

  // If we have a recorded Forza-coords outline AND a bundled TUMFTM outline,
  // compute static alignment so boundaries match without needing live driving.
  const recordedOutline = getDbTrackOutline(ordinal) ?? (hasRecordedOutline(ordinal) ? getTrackOutlineByOrdinal(ordinal) : null);
  const bundledOutline = getBundledOutlineByOrdinal(ordinal);
  if (recordedOutline && bundledOutline) {
    computeStaticAlignment(ordinal, bundledOutline, recordedOutline);

    // Refine alignment using curb data as boundary anchors (if available)
    const curbs = getTrackCurbs(ordinal);
    if (curbs && curbs.length > 0) {
      refineAlignmentWithCurbs(ordinal, bundledOutline, recordedOutline, boundaries, curbs);
    }
  }

  // Compute geometric center-line from midpoint of left/right edges
  const minLen = Math.min(boundaries.leftEdge.length, boundaries.rightEdge.length);
  const centerLine: { x: number; z: number }[] = [];
  for (let i = 0; i < minLen; i++) {
    centerLine.push({
      x: (boundaries.leftEdge[i].x + boundaries.rightEdge[i].x) / 2,
      z: (boundaries.leftEdge[i].z + boundaries.rightEdge[i].z) / 2,
    });
  }

  // Transform TUMFTM coords → Forza coords (uses live calibration or static alignment)
  const leftForza = transformToForzaSpace(ordinal, boundaries.leftEdge);
  const rightForza = transformToForzaSpace(ordinal, boundaries.rightEdge);
  const centerForza = transformToForzaSpace(ordinal, centerLine);
  const pitForza = boundaries.pitLane ? transformToForzaSpace(ordinal, boundaries.pitLane) : null;

  if (leftForza && rightForza && centerForza) {
    // Local warp: nudge boundary points toward nearby curb ground-truth positions
    // Curbs are not pre-assigned to sides — correlate each curb point with the nearest boundary edge
    const curbs = getTrackCurbs(ordinal);
    if (curbs && curbs.length > 0) {
      const allCurbPts = curbs.flatMap(c => c.points);
      // For each curb point, assign to whichever boundary edge is closer
      const leftCurbs: { x: number; z: number }[] = [];
      const rightCurbs: { x: number; z: number }[] = [];
      for (const cp of allCurbPts) {
        let leftDist = Infinity;
        let rightDist = Infinity;
        for (const lp of leftForza) {
          const d = (lp.x - cp.x) ** 2 + (lp.z - cp.z) ** 2;
          if (d < leftDist) leftDist = d;
        }
        for (const rp of rightForza) {
          const d = (rp.x - cp.x) ** 2 + (rp.z - cp.z) ** 2;
          if (d < rightDist) rightDist = d;
        }
        if (leftDist <= rightDist) {
          leftCurbs.push(cp);
        } else {
          rightCurbs.push(cp);
        }
      }
      warpBoundaryToCurbs(leftForza, leftCurbs);
      warpBoundaryToCurbs(rightForza, rightCurbs);
      smoothBoundary(leftForza, 5);
      smoothBoundary(rightForza, 5);
      // Recompute center from warped boundaries
      const warpedCenter = leftForza.map((lp, i) => ({
        x: (lp.x + (rightForza[i]?.x ?? lp.x)) / 2,
        z: (lp.z + (rightForza[i]?.z ?? lp.z)) / 2,
      }));
      return c.json({
        leftEdge: leftForza,
        rightEdge: rightForza,
        centerLine: warpedCenter,
        pitLane: pitForza,
        coordSystem: "forza",
      });
    }

    return c.json({
      leftEdge: leftForza,
      rightEdge: rightForza,
      centerLine: centerForza,
      pitLane: pitForza,
      coordSystem: "forza",
    });
  }

  // No transform available — return raw TUMFTM coords
  return c.json({
    leftEdge: boundaries.leftEdge,
    rightEdge: boundaries.rightEdge,
    centerLine,
    pitLane: boundaries.pitLane,
    coordSystem: "tumftm",
  });
});

// GET /api/track-curbs/:ordinal — curb/kerb positions detected from rumble strip data
app.get("/api/track-curbs/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const curbs = getTrackCurbs(ordinal);
  if (!curbs) return c.json({ error: "No curb data" }, 404);
  return c.json(curbs);
});

// POST /api/track-curbs/:ordinal/extract — extract curbs from all stored laps and recalibrate boundaries
app.post("/api/track-curbs/:ordinal/extract", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  // Find all laps for this track
  const trackLaps = getLaps().filter(l => l.trackOrdinal === ordinal && l.lapTime > 0);
  if (trackLaps.length === 0) return c.json({ error: "No laps found for this track" }, 404);

  let totalSegments = 0;
  let lapsWithCurbs = 0;

  for (const lap of trackLaps) {
    const lapData = getLapById(lap.id);
    if (!lapData?.telemetry || lapData.telemetry.length < 50) continue;

    const segments = extractCurbSegments(lapData.telemetry);
    if (segments.length > 0) {
      recordCurbData(ordinal, segments);
      totalSegments += segments.length;
      lapsWithCurbs++;
    }
  }

  const curbs = getTrackCurbs(ordinal);

  // Trigger boundary recalibration if we have curb data
  const boundaries = getTrackBoundariesByOrdinal(ordinal);
  const recordedOutline = getDbTrackOutline(ordinal) ?? (hasRecordedOutline(ordinal) ? getTrackOutlineByOrdinal(ordinal) : null);
  const bundledOutline = getBundledOutlineByOrdinal(ordinal);

  let calibrated = false;
  if (curbs && curbs.length > 0 && boundaries && recordedOutline && bundledOutline) {
    // Clear caches so alignment re-runs with fresh curb data
    clearCurbRefinement(ordinal);
    computeStaticAlignment(ordinal, bundledOutline, recordedOutline);
    refineAlignmentWithCurbs(ordinal, bundledOutline, recordedOutline, boundaries, curbs);
    calibrated = true;
  }

  return c.json({
    success: true,
    lapsScanned: trackLaps.length,
    lapsWithCurbs,
    totalSegments,
    curbSegments: curbs?.length ?? 0,
    calibrated,
    message: `Extracted curbs from ${lapsWithCurbs}/${trackLaps.length} laps, ${curbs?.length ?? 0} total segments. ${calibrated ? "Boundaries recalibrated." : "No boundary recalibration (missing data)."}`,
  });
});

// Car model configs — single source of truth for 3D model alignment + dimensions
const CAR_MODEL_CONFIGS_PATH = resolve(__dirname, "../data/car-model-configs.json");

function loadCarModelConfigs(): Record<string, any> {
  if (!existsSync(CAR_MODEL_CONFIGS_PATH)) return {};
  try { return JSON.parse(readFileSync(CAR_MODEL_CONFIGS_PATH, "utf-8")); }
  catch { return {}; }
}

// GET /api/car-model-configs — all car model configs
app.get("/api/car-model-configs", (c) => c.json(loadCarModelConfigs()));

// GET /api/car-model-configs/:ordinal — single car config
app.get("/api/car-model-configs/:ordinal", (c) => {
  const ordinal = c.req.param("ordinal");
  const configs = loadCarModelConfigs();
  return configs[ordinal] ? c.json(configs[ordinal]) : c.json({ error: "No config" }, 404);
});

// PUT /api/car-model-configs/:ordinal — update car model config (merges fields)
app.put("/api/car-model-configs/:ordinal", async (c) => {
  const ordinal = c.req.param("ordinal");
  if (!ordinal || isNaN(parseInt(ordinal))) return c.json({ error: "Invalid ordinal" }, 400);
  const body = await c.req.json();

  const configs = loadCarModelConfigs();
  configs[ordinal] = { ...configs[ordinal], ...body };
  writeFileSync(CAR_MODEL_CONFIGS_PATH, JSON.stringify(configs, null, 2));
  console.log(`[CarModel] Saved config for car ${ordinal}:`, body);
  return c.json({ success: true, config: configs[ordinal] });
});

// DELETE /api/track-outline/:ordinal — delete recorded outline for a track
app.delete("/api/track-outline/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const deleted = deleteRecordedOutline(ordinal);
  return c.json({ success: true, hadRecorded: deleted });
});

export default app;
