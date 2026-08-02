import type { TelemetryPacket, GameId } from "../../shared/types";
import { tryGetGame } from "../../shared/games/registry";
import type { ServerGameAdapter } from "../games/types";
import { fillNormSuspension } from "../telemetry/normalization";

// Fixed column order for CSV telemetry storage
const TELEMETRY_FIELDS: (keyof TelemetryPacket)[] = [
  "IsRaceOn","TimestampMS","EngineMaxRpm","EngineIdleRpm","CurrentEngineRpm",
  "AccelerationX","AccelerationY","AccelerationZ",
  "VelocityX","VelocityY","VelocityZ",
  "AngularVelocityX","AngularVelocityY","AngularVelocityZ",
  "Yaw","Pitch","Roll",
  "NormSuspensionTravelFL","NormSuspensionTravelFR","NormSuspensionTravelRL","NormSuspensionTravelRR",
  "TireSlipRatioFL","TireSlipRatioFR","TireSlipRatioRL","TireSlipRatioRR",
  "WheelRotationSpeedFL","WheelRotationSpeedFR","WheelRotationSpeedRL","WheelRotationSpeedRR",
  "WheelOnRumbleStripFL","WheelOnRumbleStripFR","WheelOnRumbleStripRL","WheelOnRumbleStripRR",
  "WheelInPuddleDepthFL","WheelInPuddleDepthFR","WheelInPuddleDepthRL","WheelInPuddleDepthRR",
  "SurfaceRumbleFL_2","SurfaceRumbleFR_2","SurfaceRumbleRL_2","SurfaceRumbleRR_2",
  "TireSlipCombinedFL_2",
  "TireTempFL","TireTempFR","TireTempRL","TireTempRR",
  "TireCarcassTempFL","TireCarcassTempFR","TireCarcassTempRL","TireCarcassTempRR",
  "TireCarcassTempLeftFL","TireCarcassTempLeftFR","TireCarcassTempLeftRL","TireCarcassTempLeftRR",
  "TireCarcassTempMiddleFL","TireCarcassTempMiddleFR","TireCarcassTempMiddleRL","TireCarcassTempMiddleRR",
  "TireCarcassTempRightFL","TireCarcassTempRightFR","TireCarcassTempRightRL","TireCarcassTempRightRR",
  "TireSurfaceTempInnerFL","TireSurfaceTempInnerFR","TireSurfaceTempInnerRL","TireSurfaceTempInnerRR",
  "TireSurfaceTempMiddleFL","TireSurfaceTempMiddleFR","TireSurfaceTempMiddleRL","TireSurfaceTempMiddleRR",
  "TireSurfaceTempOuterFL","TireSurfaceTempOuterFR","TireSurfaceTempOuterRL","TireSurfaceTempOuterRR",
  "Boost","Fuel","DistanceTraveled","BestLap","LastLap","CurrentLap","CurrentRaceTime",
  "LapNumber","RacePosition","Accel","Brake","Clutch","HandBrake","Gear","Steer",
  "NormDrivingLine","NormAIBrakeDiff",
  "TireWearFL","TireWearFR","TireWearRL","TireWearRR",
  "SurfaceRumbleFL","SurfaceRumbleFR","SurfaceRumbleRL","SurfaceRumbleRR",
  "TireSlipAngleFL","TireSlipAngleFR","TireSlipAngleRL","TireSlipAngleRR",
  "TireCombinedSlipFL","TireCombinedSlipFR","TireCombinedSlipRL","TireCombinedSlipRR",
  "SuspensionTravelMFL","SuspensionTravelMFR","SuspensionTravelMRL","SuspensionTravelMRR",
  "CarOrdinal","CarClass","CarPerformanceIndex","DrivetrainType","NumCylinders",
  "PositionX","PositionY","PositionZ","Speed","Power","Torque","TrackOrdinal",
  "DrsActive","ErsStoreEnergy","ErsDeployMode","ErsDeployed","ErsHarvested",
  "WeatherType","TrackTemp","AirTemp","RainPercent",
  "BrakeTempFrontLeft","BrakeTempFrontRight","BrakeTempRearLeft","BrakeTempRearRight",
  "TirePressureFrontLeft","TirePressureFrontRight","TirePressureRearLeft","TirePressureRearRight",
  "TyreCompound",
];

/**
 * Build a per-lap meta object capturing non-numeric/extended data.
 * Stored as a JSON line before the CSV header.
 */
// Fields on F1ExtendedData useful for live UI only — not worth storing per-lap
const F1_LIVE_ONLY_KEYS = new Set([
  "grid",
  "frontLeftWingDamage", "frontRightWingDamage", "rearWingDamage",
  "floorDamage", "diffuserDamage", "sidepodDamage",
  "drsFault", "ersFault", "gearBoxDamage", "engineDamage",
  "engineMGUHWear", "engineESWear", "engineCEWear",
  "engineICEWear", "engineMGUKWear", "engineTCWear",
]);

function buildMeta(packets: TelemetryPacket[]): Record<string, unknown> | null {
  if (packets.length === 0) return null;
  const first = packets[0];
  const meta: Record<string, unknown> = {};
  if (first.gameId) meta.gameId = first.gameId;
  if (first.acc) meta.acc = first.acc;
  if (first.f1) {
    const stripped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(first.f1)) {
      if (!F1_LIVE_ONLY_KEYS.has(k)) stripped[k] = v;
    }
    meta.f1 = stripped;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}


export function compressTelemetry(packets: TelemetryPacket[]): Buffer {
  const meta = buildMeta(packets);
  const csvHeader = TELEMETRY_FIELDS.join(",");
  const parts: string[] = [];
  if (meta) parts.push(JSON.stringify(meta));
  parts.push(csvHeader);
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    parts.push(TELEMETRY_FIELDS.map(f => p[f]).join(","));
  }
  return Buffer.from(Bun.gzipSync(Buffer.from(parts.join("\n"))));
}

/**
 * Decompress a stored telemetry blob back to packet array.
 * Detects optional JSON meta line (starts with '{') and stamps
 * gameId/acc/f1 back onto each packet.
 */

export function decompressTelemetry(blob: Buffer): TelemetryPacket[] {
  let decompressed: Uint8Array;
  try {
    decompressed = Bun.gunzipSync(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer);
  } catch (err) {
    console.error("[DB] Failed to decompress telemetry blob:", err);
    return [];
  }
  const text = new TextDecoder().decode(decompressed);
  const nl = text.indexOf("\n");
  if (nl === -1) return [];

  let meta: Record<string, unknown> | null = null;
  let headerStart = 0;
  const firstLine = text.slice(0, nl);

  // Detect JSON meta line (starts with '{')
  if (firstLine.charCodeAt(0) === 123) {
    try { meta = JSON.parse(firstLine); } catch {}
    headerStart = nl + 1;
  }

  const headerEnd = text.indexOf("\n", headerStart);
  if (headerEnd === -1) return [];
  const fields = text.slice(headerStart, headerEnd).split(",") as (keyof TelemetryPacket)[];
  const body = text.slice(headerEnd + 1);
  const lines = body.split("\n");
  const result: TelemetryPacket[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const vals = lines[i].split(",");
    const p = {} as TelemetryPacket;
    for (let j = 0; j < fields.length; j++) {
      if (vals[j] === "") continue;
      (p as any)[fields[j]] = Number(vals[j]);
    }
    if (meta) {
      if (meta.gameId) p.gameId = meta.gameId as GameId;
      if (meta.acc) p.acc = meta.acc as TelemetryPacket["acc"];
      if (meta.f1) p.f1 = meta.f1 as TelemetryPacket["f1"];
    }
    fillNormSuspension(
      p,
      p.gameId
        ? (tryGetGame(p.gameId) as Partial<ServerGameAdapter> | undefined)?.runtime?.normSuspensionTravelMm
        : undefined,
    );
    result[i] = p;
  }
  return result;
}
