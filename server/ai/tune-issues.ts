/**
 * tune-issues — projects the deterministic auto-tune symptom engine into the
 * shared `TuneIssue` shape used by the Live Tuning Dashboard's issue feed
 * (per-lap, from `symptomsToIssues`) and its live transient detector
 * (per-packet, from `detectLiveIssues`). No new physics thresholds here —
 * both reuse the exact constants from `tune-symptoms.ts` so the feed and the
 * live alerts never disagree about what counts as "locked" or "bottomed".
 */
import type { TelemetryPacket, TuneIssue } from "../../shared/types";
import type { TuneSymptoms } from "./tune-symptoms";
import {
  BALANCE_THRESHOLD,
  LOCKUP_SLIP,
  BOTTOM_TRAVEL,
  BRAKE_ON,
  ACC_PRESSURE_TARGET,
  brakeFrac,
} from "./tune-symptoms";

// psi delta from the target window mid before we call it a live issue.
const PRESSURE_DELTA_WARN = 1.5;
// Celsius spread between hottest and coldest tyre before we flag uneven temps.
const TEMP_SPREAD_WARN = 12;

/**
 * Maps a completed lap's `TuneSymptoms` (from `telemetryToSymptoms`) into a
 * flat `TuneIssue[]` for the per-lap feed. Pure — no I/O, no side effects.
 * `lapNumber` is stamped on every issue so the feed can group/sort by lap.
 */
export function symptomsToIssues(symptoms: TuneSymptoms, lapNumber?: number): TuneIssue[] {
  const issues: TuneIssue[] = [];

  for (const corner of symptoms.corners) {
    for (const phase of corner.phases) {
      if (phase.balance === "understeer" || phase.balance === "oversteer") {
        const mag = Math.abs(phase.balanceMagnitude);
        issues.push({
          kind: phase.balance,
          severity: mag > BALANCE_THRESHOLD * 3 ? "critical" : "warn",
          corner: corner.label,
          detail: `${phase.balance === "understeer" ? "Understeer" : "Oversteer"} on ${phase.phase} (Δ${mag.toFixed(3)} rad)`,
          lapNumber,
        });
      }
      if (phase.brakeLockup) {
        issues.push({
          kind: "brake-lockup",
          severity: "critical",
          corner: corner.label,
          detail: `Wheel lockup under braking (${phase.phase})`,
          lapNumber,
        });
      }
      if (phase.bottoming) {
        issues.push({
          kind: "bottoming",
          severity: "warn",
          corner: corner.label,
          detail: `Suspension bottoming out (${phase.phase})`,
          lapNumber,
        });
      }
    }
  }

  const tp = symptoms.aggregate.tyrePressure;
  if (tp) {
    for (const [corner, delta] of Object.entries(tp) as [keyof typeof tp, number][]) {
      if (Math.abs(delta) > PRESSURE_DELTA_WARN) {
        issues.push({
          kind: "tyre-pressure",
          severity: Math.abs(delta) > PRESSURE_DELTA_WARN * 2 ? "critical" : "warn",
          detail: `${corner} pressure ${delta > 0 ? "+" : ""}${delta.toFixed(1)} psi vs target`,
          lapNumber,
        });
      }
    }
  }

  return issues;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Stateless, per-packet live issue detector. Called at packet rate (gated by
 * `Pipeline.liveIssuesEnabled`) so it must stay cheap and side-effect-free —
 * no history, no smoothing across calls. Transients are deliberately noisy;
 * the client debounces/expires them rather than this function.
 *
 * `trackLength` (metres) is optional — when supplied, `distanceFrac` is
 * populated for track-map placement; omitted otherwise.
 */
export function detectLiveIssues(packet: TelemetryPacket, trackLength?: number): TuneIssue[] {
  const issues: TuneIssue[] = [];
  const distanceFrac =
    trackLength && trackLength > 0 ? packet.DistanceTraveled / trackLength : undefined;

  // Brake lockup — any wheel slipping while braking.
  if (
    brakeFrac(packet) > BRAKE_ON &&
    (Math.abs(packet.TireSlipRatioFL) > LOCKUP_SLIP ||
      Math.abs(packet.TireSlipRatioFR) > LOCKUP_SLIP ||
      Math.abs(packet.TireSlipRatioRL) > LOCKUP_SLIP ||
      Math.abs(packet.TireSlipRatioRR) > LOCKUP_SLIP)
  ) {
    issues.push({
      kind: "brake-lockup",
      severity: "critical",
      distanceFrac,
      detail: "Wheel lockup under braking",
    });
  }

  // Suspension bottoming.
  if (
    packet.NormSuspensionTravelFL > BOTTOM_TRAVEL ||
    packet.NormSuspensionTravelFR > BOTTOM_TRAVEL ||
    packet.NormSuspensionTravelRL > BOTTOM_TRAVEL ||
    packet.NormSuspensionTravelRR > BOTTOM_TRAVEL
  ) {
    issues.push({
      kind: "bottoming",
      severity: "warn",
      distanceFrac,
      detail: "Suspension bottoming out",
    });
  }

  // Balance while actually cornering/loaded — ignore near-standstill noise.
  if (packet.Speed > 5) {
    const frontSlip = (Math.abs(packet.TireSlipAngleFL) + Math.abs(packet.TireSlipAngleFR)) / 2;
    const rearSlip = (Math.abs(packet.TireSlipAngleRL) + Math.abs(packet.TireSlipAngleRR)) / 2;
    const magnitude = frontSlip - rearSlip;
    if (magnitude > BALANCE_THRESHOLD) {
      issues.push({
        kind: "understeer",
        severity: magnitude > BALANCE_THRESHOLD * 3 ? "warn" : "info",
        distanceFrac,
        detail: `Understeer (Δ${magnitude.toFixed(3)} rad)`,
      });
    } else if (magnitude < -BALANCE_THRESHOLD) {
      issues.push({
        kind: "oversteer",
        severity: magnitude < -BALANCE_THRESHOLD * 3 ? "warn" : "info",
        distanceFrac,
        detail: `Oversteer (Δ${magnitude.toFixed(3)} rad)`,
      });
    }
  }

  // Tyre pressure out of the ACC hot window (only present when the game
  // reports pressures — FM/F1 leave these fields undefined).
  if (packet.TirePressureFrontLeft != null) {
    const pressures = {
      FL: packet.TirePressureFrontLeft ?? 0,
      FR: packet.TirePressureFrontRight ?? 0,
      RL: packet.TirePressureRearLeft ?? 0,
      RR: packet.TirePressureRearRight ?? 0,
    };
    for (const [corner, psi] of Object.entries(pressures)) {
      const delta = psi - ACC_PRESSURE_TARGET;
      if (Math.abs(delta) > PRESSURE_DELTA_WARN) {
        issues.push({
          kind: "tyre-pressure",
          severity: Math.abs(delta) > PRESSURE_DELTA_WARN * 2 ? "critical" : "warn",
          distanceFrac,
          detail: `${corner} pressure ${delta > 0 ? "+" : ""}${delta.toFixed(1)} psi vs target`,
        });
      }
    }
  }

  // Tyre temp spread — one corner running much hotter/colder than the rest.
  const temps = [packet.TireTempFL, packet.TireTempFR, packet.TireTempRL, packet.TireTempRR];
  if (temps.every((t) => t != null && t > 0)) {
    const avg = mean(temps);
    const spread = Math.max(...temps) - Math.min(...temps);
    if (spread > TEMP_SPREAD_WARN) {
      issues.push({
        kind: "tyre-temp",
        severity: spread > TEMP_SPREAD_WARN * 1.5 ? "critical" : "warn",
        distanceFrac,
        detail: `Uneven tyre temps — ${spread.toFixed(0)}°C spread (avg ${avg.toFixed(0)}°C)`,
      });
    }
  }

  return issues;
}
