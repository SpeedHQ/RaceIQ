import type { TuneIssue } from "../../../shared/racing/tuning/issues";
import type { SemanticAnalysisFrame } from "../components/analyse/track-map/types";

/** Generates a plausible full-lap semantic telemetry array for Setup Engineer
 * live/review stories. */
export function generateFakeLapTelemetry(frames = 600): SemanticAnalysisFrame[] {
  const out: SemanticAnalysisFrame[] = [];
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    const steer = Math.sin(t * Math.PI * 8) * 0.6;
    const ang = t * Math.PI * 2;
    const r = 300 + 90 * Math.sin(ang * 2) + 45 * Math.cos(ang * 3);
    const posX = 120.5 + r * Math.cos(ang);
    const posZ = 340.2 + r * Math.sin(ang);
    out.push({
      values: {
        "identity.track-ordinal": 7,
        "identity.car-ordinal": 301,
        "motion.position-x": posX,
        "motion.position-z": posZ,
        "motion.yaw": ang + Math.PI / 2,
        "motion.speed": 40 + 30 * Math.sin(t * Math.PI * 4),
        "inputs.steer": steer,
        "inputs.brake": t % 0.3 < 0.05 ? 0.8 : 0,
        "inputs.accel": 200,
        "timing.distance-traveled": t * 4200,
        "timing.current-lap": t * 92.3,
        "tire.temperature.average": [82 + 10 * Math.sin(t * Math.PI * 3), 85 + 10 * Math.sin(t * Math.PI * 3 + 1), 80 + 8 * Math.cos(t * Math.PI * 3), 83 + 8 * Math.cos(t * Math.PI * 3 + 1)],
        "tires.tire-wear": [0.25 + t * 0.04, 0.26 + t * 0.045, 0.3 + t * 0.03, 0.29 + t * 0.032],
      },
      states: {},
      freshness: {},
    });
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
