/**
 * Projects completed symptom reports and resolver-backed live semantic samples
 * into shared TuneIssue records.
 */
import type { GameId } from "../../shared/games/ids";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import { semanticFixedNumbers, semanticNumber } from "../telemetry/semantic-samples";
import type { TuneSymptoms } from "./tune-symptoms";
import { ACC_PRESSURE_TARGET, BALANCE_THRESHOLD, BOTTOM_TRAVEL, BRAKE_ON, brakeFrac, LOCKUP_SLIP } from "./tune-symptoms";

export const LIVE_TUNE_ISSUE_SEMANTIC_IDS = [
  "timing.distance-traveled",
  "inputs.brake",
  "tires.tire-slip-angle",
  "tires.tire-slip-ratio",
  "suspension.norm-suspension-travel",
  "motion.speed",
  "tires.tire-pressure",
  "tire.temperature.carcass.average",
] as const satisfies readonly TelemetryVariableId[];

const PRESSURE_DELTA_WARN = 1.5;
const TEMP_SPREAD_WARN = 12;
const WHEELS = 4;
const WHEEL_LABELS = ["FL", "FR", "RL", "RR"] as const;

export function symptomsToIssues(symptoms: TuneSymptoms, lapNumber?: number): TuneIssue[] {
  const issues: TuneIssue[] = [];
  for (const corner of symptoms.corners) {
    for (const phase of corner.phases) {
      if ((phase.balance === "understeer" || phase.balance === "oversteer") && phase.balanceMagnitude != null) {
        const magnitude = Math.abs(phase.balanceMagnitude);
        issues.push({
          kind: phase.balance,
          severity: magnitude > BALANCE_THRESHOLD * 3 ? "critical" : "warn",
          corner: corner.label,
          distanceFrac: corner.distanceFrac,
          detail: `${phase.balance === "understeer" ? "Understeer" : "Oversteer"} on ${phase.phase} (Δ${magnitude.toFixed(3)} rad)`,
          lapNumber,
        });
      }
      if (phase.brakeLockup === true) {
        issues.push({
          kind: "brake-lockup",
          severity: "critical",
          corner: corner.label,
          distanceFrac: corner.distanceFrac,
          detail: `Brake lockup on ${phase.phase}`,
          lapNumber,
        });
      }
      if (phase.bottoming === true) {
        issues.push({
          kind: "bottoming",
          severity: "warn",
          corner: corner.label,
          distanceFrac: corner.distanceFrac,
          detail: `Suspension bottoming out (${phase.phase})`,
          lapNumber,
        });
      }
    }
  }
  const pressure = symptoms.aggregate.tyrePressure;
  if (pressure) {
    for (const wheel of WHEEL_LABELS) {
      const delta = pressure[wheel];
      if (Math.abs(delta) <= PRESSURE_DELTA_WARN) continue;
      issues.push({
        kind: "tyre-pressure",
        severity: Math.abs(delta) > PRESSURE_DELTA_WARN * 2 ? "critical" : "warn",
        corner: wheel,
        detail: `${wheel} pressure ${delta > 0 ? "+" : ""}${delta.toFixed(1)} psi vs target`,
        lapNumber,
      });
    }
  }
  return issues;
}

/**
 * Stateless live detector. Semantic sample values have already passed resolver
 * state and freshness gates; unavailable values suppress only their own issue.
 */
export function detectLiveIssues(gameId: GameId, sample: SemanticTelemetrySample, trackLength?: number): TuneIssue[] {
  if (!gameId) throw new Error("gameId is required for live tune issue analysis");
  const issues: TuneIssue[] = [];
  const distance = semanticNumber(sample, "timing.distance-traveled");
  const distanceFrac = distance != null && trackLength != null && trackLength > 0 ? distance / trackLength : undefined;

  const brake = brakeFrac(sample);
  const slipRatios = semanticFixedNumbers(sample, "tires.tire-slip-ratio", WHEELS);
  if (
    brake != null &&
    slipRatios &&
    brake > BRAKE_ON &&
    (Math.abs(slipRatios[0]) > LOCKUP_SLIP || Math.abs(slipRatios[1]) > LOCKUP_SLIP || Math.abs(slipRatios[2]) > LOCKUP_SLIP || Math.abs(slipRatios[3]) > LOCKUP_SLIP)
  ) {
    issues.push({
      kind: "brake-lockup",
      severity: "critical",
      distanceFrac,
      detail: "Wheel lockup under braking",
    });
  }

  const travel = semanticFixedNumbers(sample, "suspension.norm-suspension-travel", WHEELS);
  if (travel && (travel[0] > BOTTOM_TRAVEL || travel[1] > BOTTOM_TRAVEL || travel[2] > BOTTOM_TRAVEL || travel[3] > BOTTOM_TRAVEL)) {
    issues.push({
      kind: "bottoming",
      severity: "warn",
      distanceFrac,
      detail: "Suspension bottoming out",
    });
  }

  const speed = semanticNumber(sample, "motion.speed");
  const angles = semanticFixedNumbers(sample, "tires.tire-slip-angle", WHEELS);
  if (speed != null && speed > 5 && angles) {
    const magnitude = (Math.abs(angles[0]) + Math.abs(angles[1]) - Math.abs(angles[2]) - Math.abs(angles[3])) / 2;
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

  const pressures = gameId === "acc" || gameId === "ac-evo" ? semanticFixedNumbers(sample, "tires.tire-pressure", WHEELS) : null;
  if (pressures) {
    for (let index = 0; index < WHEELS; index += 1) {
      const delta = pressures[index] - ACC_PRESSURE_TARGET;
      if (Math.abs(delta) <= PRESSURE_DELTA_WARN) continue;
      issues.push({
        kind: "tyre-pressure",
        severity: Math.abs(delta) > PRESSURE_DELTA_WARN * 2 ? "critical" : "warn",
        corner: WHEEL_LABELS[index],
        distanceFrac,
        detail: `${WHEEL_LABELS[index]} pressure ${delta > 0 ? "+" : ""}${delta.toFixed(1)} psi vs target`,
      });
    }
  }

  const temperatures = semanticFixedNumbers(sample, "tire.temperature.carcass.average", WHEELS);
  if (temperatures && temperatures.every((temperature) => temperature > 0)) {
    let total = 0;
    let minimum = temperatures[0];
    let maximum = temperatures[0];
    for (const temperature of temperatures) {
      total += temperature;
      if (temperature < minimum) minimum = temperature;
      if (temperature > maximum) maximum = temperature;
    }
    const spread = maximum - minimum;
    if (spread > TEMP_SPREAD_WARN) {
      issues.push({
        kind: "tyre-temp",
        severity: spread > TEMP_SPREAD_WARN * 1.5 ? "critical" : "warn",
        distanceFrac,
        detail: `Uneven tyre temps — ${spread.toFixed(0)}°C spread (avg ${(total / WHEELS).toFixed(0)}°C)`,
      });
    }
  }
  return issues;
}
