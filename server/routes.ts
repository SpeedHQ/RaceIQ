import { Hono } from "hono";
import { cors } from "hono/cors";
import { udpListener } from "./udp";
import { wsManager } from "./ws";
import { lapDetector } from "./lap-detector";
import { saveSettings } from "./settings";
import {
  getLaps,
  getLapById,
  deleteLap,
  getSessions,
  getCorners,
  saveCorners,
  getFirstLapIdForTrack,
} from "./db/queries";
import {
  CAR_CLASS_NAMES,
  DRIVETRAIN_NAMES,
  type TelemetryPacket,
} from "../shared/types";
import { compareLaps } from "./comparison";
import { detectCorners, type Corner } from "./corner-detection";
import { carMap, getCarName, trackMap, getTrackName } from "../shared/car-data";
import { getTrackOutlineByOrdinal, hasTrackOutline, getTrackSectorsByOrdinal } from "../shared/track-outlines/index";
import { trackMap as trackInfoMap } from "../shared/car-data";

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
  return c.json({ udpPort: udpListener.port });
});

// PUT /api/settings
app.put("/api/settings", async (c) => {
  const body = await c.req.json<{ udpPort?: number }>();
  const port = body.udpPort ?? udpListener.port;

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return c.json({ error: "Port must be between 1024-65535" }, 400);
  }

  try {
    await udpListener.restart(port);
    saveSettings({ udpPort: port });
    return c.json({ udpPort: port });
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

// GET /api/laps/:id/export — Claude-formatted text summary
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

// GET /api/laps/:id1/compare/:id2 — pre-computed comparison data
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
  return c.json(result);
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

// GET /api/tracks — list all tracks with outline availability
app.get("/api/tracks", (c) => {
  const tracks = Array.from(trackInfoMap.entries()).map(([ordinal, info]) => ({
    ordinal,
    name: info.name,
    location: info.location,
    country: info.country,
    variant: info.variant,
    lengthKm: info.lengthKm,
    hasOutline: hasTrackOutline(ordinal),
  }));
  // Sort: tracks with outlines first, then alphabetically
  tracks.sort((a, b) => {
    if (a.hasOutline !== b.hasOutline) return a.hasOutline ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return c.json(tracks);
});

// GET /api/track-sectors/:ordinal — auto-detect corners and straights from curvature
app.get("/api/track-sectors/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const outline = getTrackOutlineByOrdinal(ordinal);
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

  // Threshold: points above this are "corner", below are "straight"
  const sorted = [...smoothed].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(n * 0.5)]; // median

  // Build segments by classifying each point
  const segments: { type: "corner" | "straight"; startFrac: number; endFrac: number; startIdx: number; endIdx: number }[] = [];
  let currentType: "corner" | "straight" = smoothed[0] > threshold ? "corner" : "straight";
  let segStart = 0;

  for (let i = 1; i < n; i++) {
    const type = smoothed[i] > threshold ? "corner" : "straight";
    if (type !== currentType) {
      segments.push({
        type: currentType,
        startFrac: segStart / n,
        endFrac: i / n,
        startIdx: segStart,
        endIdx: i,
      });
      currentType = type;
      segStart = i;
    }
  }
  // Close last segment
  segments.push({
    type: currentType,
    startFrac: segStart / n,
    endFrac: 1,
    startIdx: segStart,
    endIdx: n - 1,
  });

  // Merge tiny segments (< 2% of track) into neighbors
  const minFrac = 0.02;
  const merged: typeof segments = [];
  for (const seg of segments) {
    const frac = seg.endFrac - seg.startFrac;
    if (frac < minFrac && merged.length > 0) {
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

// GET /api/fuel-history — fuel usage per lap
app.get("/api/fuel-history", (c) => {
  return c.json(lapDetector.fuelHistory);
});

// GET /api/grip-history — server-side grip ring buffer
app.get("/api/grip-history", (c) => {
  return c.json(wsManager.getGripHistory());
});

// GET /api/telemetry-history — full 60s telemetry history
app.get("/api/telemetry-history", (c) => {
  return c.json(wsManager.getTelemetryHistory());
});

// DELETE /api/laps — delete all laps
app.delete("/api/laps", (c) => {
  const laps = getLaps();
  let count = 0;
  for (const lap of laps) {
    if (deleteLap(lap.id)) count++;
  }
  return c.json({ deleted: count });
});

// GET /api/track-outline/:ordinal — bundled track outline coordinates
app.get("/api/track-outline/:ordinal", (c) => {
  const ordinal = parseInt(c.req.param("ordinal"), 10);
  if (isNaN(ordinal)) return c.json({ error: "Invalid ordinal" }, 400);

  const outline = getTrackOutlineByOrdinal(ordinal);
  if (!outline) return c.json({ error: "No outline available" }, 404);

  return c.json(outline);
});

/**
 * Generate a Claude-formatted lap export summary.
 */
function generateExport(
  lap: {
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    carOrdinal?: number;
    trackOrdinal?: number;
  },
  packets: TelemetryPacket[]
): string {
  const first = packets[0];
  const className = CAR_CLASS_NAMES[first.CarClass] ?? String(first.CarClass);
  const drivetrainName =
    DRIVETRAIN_NAMES[first.DrivetrainType] ?? String(first.DrivetrainType);

  // Speed calculations (m/s -> mph)
  const speeds = packets.map(
    (p) =>
      Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2) *
      2.237 // m/s to mph
  );
  const minSpeed = Math.min(...speeds);
  const maxSpeed = Math.max(...speeds);
  const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;

  // RPM
  const rpms = packets.map((p) => p.CurrentEngineRpm);
  const minRpm = Math.min(...rpms);
  const maxRpm = Math.max(...rpms);
  const avgRpm = rpms.reduce((a, b) => a + b, 0) / rpms.length;

  // Throttle/Brake (0-255 -> percentage)
  const throttles = packets.map((p) => p.Accel / 255);
  const avgThrottle = throttles.reduce((a, b) => a + b, 0) / throttles.length;
  const fullThrottle =
    throttles.filter((t) => t > 0.95).length / throttles.length;

  const brakes = packets.map((p) => p.Brake / 255);
  const avgBrake = brakes.reduce((a, b) => a + b, 0) / brakes.length;
  const fullBrake = brakes.filter((b) => b > 0.95).length / brakes.length;

  // Tire temps
  const avgTireTempFL =
    packets.reduce((a, p) => a + p.TireTempFL, 0) / packets.length;
  const avgTireTempFR =
    packets.reduce((a, p) => a + p.TireTempFR, 0) / packets.length;
  const avgTireTempRL =
    packets.reduce((a, p) => a + p.TireTempRL, 0) / packets.length;
  const avgTireTempRR =
    packets.reduce((a, p) => a + p.TireTempRR, 0) / packets.length;

  // Gear distribution
  const gearCounts = new Map<number, number>();
  for (const p of packets) {
    gearCounts.set(p.Gear, (gearCounts.get(p.Gear) ?? 0) + 1);
  }
  const gearDist = Array.from(gearCounts.entries())
    .filter(([gear]) => gear > 0) // Skip neutral/reverse
    .sort(([a], [b]) => a - b)
    .map(([gear, count]) => {
      const pct = ((count / packets.length) * 100).toFixed(0);
      const gearName = gear === 11 ? "R" : `${gear}`;
      return `${gearName}: ${pct}%`;
    })
    .join(" | ");

  // Top 5 braking zones by speed delta
  const brakingZones = findBrakingZones(packets, speeds);

  // Suspension travel
  const avgSuspFL =
    packets.reduce((a, p) => a + p.SuspensionTravelMetersFL, 0) /
    packets.length;
  const avgSuspFR =
    packets.reduce((a, p) => a + p.SuspensionTravelMetersFR, 0) /
    packets.length;
  const avgSuspRL =
    packets.reduce((a, p) => a + p.SuspensionTravelMetersRL, 0) /
    packets.length;
  const avgSuspRR =
    packets.reduce((a, p) => a + p.SuspensionTravelMetersRR, 0) /
    packets.length;

  // Tire wear (use last packet values)
  const last = packets[packets.length - 1];

  // Format lap time
  const mins = Math.floor(lap.lapTime / 60);
  const secs = lap.lapTime % 60;
  const lapTimeStr = `${mins}:${secs.toFixed(3).padStart(6, "0")}`;

  let output = `=== Forza Motorsport Lap Export ===
Car: #${first.CarOrdinal} | Class: ${className} (PI ${first.CarPerformanceIndex}) | Drivetrain: ${drivetrainName}
Track: #${lap.trackOrdinal ?? 0} | Lap: ${lap.lapNumber} | Time: ${lapTimeStr} | Valid: ${lap.isValid ? "Yes" : "No"}

--- Performance Summary ---
Speed (mph):    min=${minSpeed.toFixed(1)}  avg=${avgSpeed.toFixed(1)}  max=${maxSpeed.toFixed(1)}
RPM:            min=${Math.round(minRpm)}  avg=${Math.round(avgRpm)}  max=${Math.round(maxRpm)}
Throttle:       avg=${(avgThrottle * 100).toFixed(0)}%   full=${(fullThrottle * 100).toFixed(0)}%
Brake:          avg=${(avgBrake * 100).toFixed(0)}%   full=${(fullBrake * 100).toFixed(0)}%

--- Tire Temps (avg F) ---
FL: ${Math.round(avgTireTempFL)}  FR: ${Math.round(avgTireTempFR)}  RL: ${Math.round(avgTireTempRL)}  RR: ${Math.round(avgTireTempRR)}

--- Gear Distribution ---
${gearDist}

--- Braking Zones (top 5 by speed delta) ---
`;

  for (let i = 0; i < Math.min(5, brakingZones.length); i++) {
    const bz = brakingZones[i];
    output += `${i + 1}. Speed ${bz.startSpeed.toFixed(0)}->${bz.endSpeed.toFixed(0)} mph at ${bz.distance.toFixed(0)}m\n`;
  }

  output += `
--- Suspension Travel (avg meters) ---
FL: ${avgSuspFL.toFixed(2)}  FR: ${avgSuspFR.toFixed(2)}  RL: ${avgSuspRL.toFixed(2)}  RR: ${avgSuspRR.toFixed(2)}

--- Tire Wear ---
FL: ${last.TireWearFL.toFixed(2)}  FR: ${last.TireWearFR.toFixed(2)}  RL: ${last.TireWearRL.toFixed(2)}  RR: ${last.TireWearRR.toFixed(2)}

Paste this into a Claude conversation for tuning advice.`;

  return output;
}

interface BrakingZone {
  startSpeed: number;
  endSpeed: number;
  distance: number; // DistanceTraveled at brake point
}

function findBrakingZones(
  packets: TelemetryPacket[],
  speeds: number[]
): BrakingZone[] {
  const zones: BrakingZone[] = [];
  let inBraking = false;
  let brakeStartIdx = 0;
  let peakSpeed = 0;

  for (let i = 1; i < packets.length; i++) {
    const braking = packets[i].Brake > 50; // ~20% brake threshold

    if (braking && !inBraking) {
      // Start of braking zone
      inBraking = true;
      brakeStartIdx = i;
      peakSpeed = speeds[i - 1];
    } else if (!braking && inBraking) {
      // End of braking zone
      inBraking = false;
      const minSpeedInZone = Math.min(
        ...speeds.slice(brakeStartIdx, i)
      );
      const delta = peakSpeed - minSpeedInZone;
      if (delta > 10) {
        // Only record significant braking
        zones.push({
          startSpeed: peakSpeed,
          endSpeed: minSpeedInZone,
          distance: packets[brakeStartIdx].DistanceTraveled,
        });
      }
    }
  }

  // Sort by speed delta descending
  zones.sort(
    (a, b) =>
      b.startSpeed - b.endSpeed - (a.startSpeed - a.endSpeed)
  );
  return zones.slice(0, 5);
}

export default app;
