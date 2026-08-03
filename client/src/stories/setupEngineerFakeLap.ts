import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { TuneIssue } from "../../../shared/tuning/issues";
import { fakeAccPacket } from "./fakeData";

/** Generates a plausible full-lap telemetry array by varying distance/steer/tyre
 * fields across N frames — used by Setup Engineer live/review Storybook stories,
 * which need a real-shaped lap rather than a single packet. */
export function generateFakeLapTelemetry(frames = 600): TelemetryPacket[] {
  const out: TelemetryPacket[] = [];
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    const steer = Math.sin(t * Math.PI * 8) * 0.6;
    // Trace a closed, non-circular loop so the track map has a real shape to
    // draw — otherwise every frame reuses fakeAccPacket's single position and
    // the track/position marker never renders. Angle sweeps a full turn (2π)
    // over the lap; the harmonics make it kidney-shaped rather than a plain
    // circle, and Yaw is the path tangent (angle + 90°).
    const ang = t * Math.PI * 2;
    const r = 300 + 90 * Math.sin(ang * 2) + 45 * Math.cos(ang * 3);
    const posX = 120.5 + r * Math.cos(ang);
    const posZ = 340.2 + r * Math.sin(ang);
    out.push({
      ...fakeAccPacket,
      PositionX: posX,
      PositionY: 0,
      PositionZ: posZ,
      Yaw: ang + Math.PI / 2,
      DistanceTraveled: t * 4200,
      CurrentLap: t * 92.3,
      Steer: steer,
      Brake: t % 0.3 < 0.05 ? 0.8 : 0,
      Speed: 40 + 30 * Math.sin(t * Math.PI * 4),
      TireTempFL: 82 + 10 * Math.sin(t * Math.PI * 3),
      TireTempFR: 85 + 10 * Math.sin(t * Math.PI * 3 + 1),
      TireTempRL: 80 + 8 * Math.cos(t * Math.PI * 3),
      TireTempRR: 83 + 8 * Math.cos(t * Math.PI * 3 + 1),
      TireWearFL: 0.25 + t * 0.04,
      TireWearFR: 0.26 + t * 0.045,
      TireWearRL: 0.3 + t * 0.03,
      TireWearRR: 0.29 + t * 0.032,
      Fuel: 62 - t * 2.8, // burns down over the lap from a ~62L tank
    } as TelemetryPacket);
  }
  return out;
}

export const fakeSectorTimes = {
  times: [29.845, 31.8, 30.696],
  sectorCount: 3,
  boundaryIndices: [195, 400],
  sectorStarts: [0, 195 / 600, 400 / 600],
  firstDist: 0,
  lapDist: 4200,
};

export const fakeTuneIssues: TuneIssue[] = [
  { kind: "brake-lockup", severity: "critical", corner: "T4", distanceFrac: 0.18, detail: "FL locking under braking (-0.24 slip)", lapNumber: 12 },
  { kind: "oversteer", severity: "warn", corner: "T7", distanceFrac: 0.42, detail: "Rear steps out on corner exit", lapNumber: 12 },
  { kind: "understeer", severity: "warn", corner: "T9", distanceFrac: 0.61, detail: "Front pushes wide mid-corner", lapNumber: 12 },
  { kind: "tyre-pressure", severity: "info", detail: "Average tyre pressure trending low across the stint", lapNumber: 12 },
];
