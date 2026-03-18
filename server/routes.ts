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
} from "./db/queries";
import {
  CAR_CLASS_NAMES,
  DRIVETRAIN_NAMES,
  type TelemetryPacket,
} from "../shared/types";

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
