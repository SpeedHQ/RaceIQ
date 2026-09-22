import type { F1ExtendedData } from "../../../../telemetry/f1-2025";
import type { TelemetryPacket } from "../../../../telemetry/types";
import type { AllWheelStates } from "../physics/vehicle";
import { eventDurations, eventSeconds, groupEvents, midFrame, type LapInsight } from "./types";

type Aid = "ABS" | "Traction Control";

export interface AidDetectionOptions {
  nativeChannelAvailable: boolean;
  /** Direct, continuous wheel rotation, not a vehicle-speed-derived substitute. */
  wheelRotationAvailable: boolean;
  /** Calibrated states provide traction evidence independent of engine RPM. */
  wheelStates?: readonly AllWheelStates[];
}

const wheelRotation = ["WheelRotationSpeedFL", "WheelRotationSpeedFR", "WheelRotationSpeedRL", "WheelRotationSpeedRR"] as const;
const wheelKeys = ["fl", "fr", "rl", "rr"] as const;
const f1Surfaces = ["surfaceTypeFL", "surfaceTypeFR", "surfaceTypeRL", "surfaceTypeRR"] as const;

function nativeInsight(aid: Aid, telemetry: readonly TelemetryPacket[], dt: readonly number[]): LapInsight | null {
  let activeSeconds = 0;
  let demandSeconds = 0;
  let activeDemandSeconds = 0;
  const flags = telemetry.map((packet, index) => {
    const value = aid === "ABS" ? packet.acc?.absIntervention : packet.acc?.tcIntervention;
    if (value === undefined || !Number.isFinite(value) || !(dt[index] > 0)) return false;
    const active = value > 0;
    if (active) activeSeconds += dt[index];
    const demand = aid === "ABS" ? packet.Brake >= 90 && packet.Speed >= 8 : packet.Accel >= 150 && packet.Speed >= 5;
    if (demand) {
      demandSeconds += dt[index];
      if (active) activeDemandSeconds += dt[index];
    }
    return active;
  });
  const events = groupEvents(flags, dt, 0, 4 / 60);
  if (events.length === 0) return null;
  const duty = demandSeconds > 0
    ? `; active during ${(100 * activeDemandSeconds / demandSeconds).toFixed(0)}% of ${demandSeconds.toFixed(1)}s observed ${aid === "ABS" ? "braking" : "acceleration"}`
    : "";
  return {
    id: aid === "ABS" ? "driving-abs-activation" : "driving-traction-control-activation",
    category: "driving",
    severity: "info",
    label: `${aid} Activation`,
    detail: `${events.length} ${aid} intervention${events.length === 1 ? "" : "s"} reported by game, ${activeSeconds.toFixed(2)}s active${duty}`,
    frameIndices: midFrame(events),
    evidenceSource: "native",
  };
}

function inferredInsight(aid: Aid, eventFrames: number[], evidence: string): LapInsight | null {
  if (eventFrames.length === 0) return null;
  return {
    id: aid === "ABS" ? "driving-abs-activation" : "driving-traction-control-activation",
    category: "driving",
    severity: "info",
    label: `Possible ${aid} Activation`,
    detail: `${eventFrames.length} possible ${aid} intervention${eventFrames.length === 1 ? "" : "s"} inferred from ${evidence}`,
    frameIndices: eventFrames,
    evidenceSource: "inferred",
  };
}


function disturbed(packet: TelemetryPacket): boolean {
  if (packet.Clutch > 25 || packet.HandBrake > 25 || packet.Gear <= (packet.f1 ? 1 : 0)) return true;
  if (packet.IsRaceOn === 0 || packet.iracing?.onPitRoad || (packet.acc?.pitStatus !== undefined && packet.acc.pitStatus !== "out")) return true;
  if ((packet.f1?.pitLimiterStatus ?? 0) !== 0 || (packet.f1?.pitLaneTimerActive ?? 0) !== 0) return true;
  if (packet.EngineMaxRpm > 0 && packet.CurrentEngineRpm >= packet.EngineMaxRpm * 0.92) return true;
  if (packet.WheelOnRumbleStripFL > 0 || packet.WheelOnRumbleStripFR > 0 || packet.WheelOnRumbleStripRL > 0 || packet.WheelOnRumbleStripRR > 0) return true;
  if (packet.f1 && f1Surfaces.some((field) => packet.f1![field] !== undefined && packet.f1![field] !== 0)) return true;
  const motion = packet.f1?.motionEx;
  if (motion && (motion.wheelVertForceFL < 100 || motion.wheelVertForceFR < 100 || motion.wheelVertForceRL < 100 || motion.wheelVertForceRR < 100)) return true;
  return packet.acc?.wheelLoad?.some((load) => Number.isFinite(load) && load < 100) ?? false;
}

/** Exclude the whole 200 ms neighborhood of shifts, unloading and interrupted controls. */
function aidEligibility(telemetry: readonly TelemetryPacket[], dt: readonly number[], aid: Aid, options: AidDetectionOptions): boolean[] {
  const eligible = telemetry.map((packet) => {
    const disabled = aid === "ABS"
      ? packet.f1?.antiLockBrakes === 0 || packet.acc?.abs === 0
      : packet.f1?.tractionControl === 0 || packet.acc?.tc === 0;
    return options.wheelRotationAvailable && (!packet.f1 || !!packet.f1.motionEx) && !disabled;
  });
  for (let i = 0; i < telemetry.length; i++) {
    const packet = telemetry[i];
    if (!disturbed(packet) && !(i > 0 && packet.Gear !== telemetry[i - 1].Gear)) continue;
    eligible[i] = false;
    let seconds = 0;
    for (let j = i - 1; j >= 0 && dt[j] > 0; j--) {
      seconds += dt[j];
      if (seconds > 0.2) break;
      eligible[j] = false;
    }
    seconds = 0;
    for (let j = i + 1; j < telemetry.length && dt[j - 1] > 0; j++) {
      seconds += dt[j - 1];
      if (seconds > 0.2) break;
      eligible[j] = false;
    }
  }
  for (let i = 0; i < telemetry.length; i++) {
    const packet = telemetry[i];
    eligible[i] &&= aid === "ABS"
      ? packet.Brake >= 90 && packet.Accel <= 30 && packet.Speed >= 8
      : packet.Accel >= 150 && packet.Brake <= 25 && packet.Speed >= 5 && packet.CurrentEngineRpm > 0;
  }
  return eligible;
}

/** A trough must recover within 120 ms on each side, with a steady driver input. */
function modulationPulse(telemetry: readonly TelemetryPacket[], dt: readonly number[], eligible: readonly boolean[], index: number, field: typeof wheelRotation[number] | "CurrentEngineRpm", input: "Accel" | "Brake", minimumSwing: number): boolean {
  const current = Math.abs(telemetry[index][field]);
  if (!Number.isFinite(current) || !(current < Math.abs(telemetry[index - 1][field])) || !(current <= Math.abs(telemetry[index + 1][field]))) return false;
  for (let direction = -1; direction <= 1; direction += 2) {
    let seconds = 0;
    let recovered = false;
    for (let j = index + direction; j >= 0 && j < telemetry.length; j += direction) {
      const step = dt[direction < 0 ? j : j - 1];
      if (!(step > 0) || !eligible[j] || !Number.isFinite(telemetry[j][field]) || Math.abs(telemetry[j][input] - telemetry[index][input]) > 15) break;
      seconds += step;
      if (seconds > 0.12 + 1e-9) break;
      if (Math.abs(telemetry[j][field]) - current >= minimumSwing) {
        recovered = true;
        break;
      }
    }
    if (!recovered) return false;
  }
  return true;
}

/** Pulse count describes repeated modulation; elapsed time defines zone boundaries. */
function pulseEvents(pulses: readonly boolean[], eligible: readonly boolean[], dt: readonly number[], maxGap: number): number[] {
  const events: number[] = [];
  let first = -1;
  let last = -1;
  let count = 0;
  let gap = 0;
  const flush = () => {
    if (count >= 2) events.push(Math.round((first + last) / 2));
    first = -1;
    count = 0;
    gap = 0;
  };
  for (let i = 0; i < pulses.length; i++) {
    if (!(dt[i] > 0) || !eligible[i]) {
      flush();
      continue;
    }
    if (count > 0 && gap > maxGap) flush();
    if (pulses[i] && (count === 0 || gap >= 0.03)) {
      if (count === 0) first = i;
      last = i;
      count++;
      gap = 0;
    }
    gap += dt[i];
  }
  flush();
  return events;
}

/** Native activity is observational, even when aid settings or driving conditions disagree. */
export function detectAbsActivation(telemetry: readonly TelemetryPacket[], options: AidDetectionOptions): LapInsight | null {
  const dt = eventDurations(telemetry);
  if (options.nativeChannelAvailable) return nativeInsight("ABS", telemetry, dt);
  const eligible = aidEligibility(telemetry, dt, "ABS", options);
  const pulses = new Array<boolean>(telemetry.length).fill(false);
  for (let i = 1; i < telemetry.length - 1; i++) {
    if (!eligible[i]) continue;
    for (const field of wheelRotation) {
      if (modulationPulse(telemetry, dt, eligible, i, field, "Brake", Math.max(1, Math.abs(telemetry[i][field]) * 0.04))) {
        pulses[i] = true;
        break;
      }
    }
  }
  return inferredInsight("ABS", pulseEvents(pulses, eligible, dt, 0.3), "wheel-speed pulsing under braking");
}

/** RPM modulation alone cannot distinguish TC from ordinary driveline oscillation. */
export function detectTractionControlActivation(telemetry: readonly TelemetryPacket[], options: AidDetectionOptions): LapInsight | null {
  const dt = eventDurations(telemetry);
  if (options.nativeChannelAvailable) return nativeInsight("Traction Control", telemetry, dt);
  if (!options.wheelStates) return null;
  const eligible = aidEligibility(telemetry, dt, "Traction Control", options);
  const pulses = new Array<boolean>(telemetry.length).fill(false);
  for (let i = 1; i < telemetry.length - 1; i++) {
    if (!eligible[i]) continue;
    const states = options.wheelStates[i - 1];
    if (!states || !wheelKeys.some((wheel) => states[wheel].state === "spin")) continue;
    pulses[i] = modulationPulse(telemetry, dt, eligible, i, "CurrentEngineRpm", "Accel", Math.max(120, telemetry[i].CurrentEngineRpm * 0.025));
  }
  return inferredInsight("Traction Control", pulseEvents(pulses, eligible, dt, 0.5), "RPM cuts with independently measured wheelspin");
}

/** Required F1 channels must be present; absent pit/caution/control data is not a clean straight. */
function f1Demand(packet: TelemetryPacket): boolean {
  const f1 = packet.f1;
  return !!f1 && packet.IsRaceOn === 1 && packet.Speed >= 25 && packet.Accel >= 242 && packet.Brake <= 5 && packet.Clutch <= 5 && packet.HandBrake <= 5
    && packet.Gear >= 2 && Math.abs(packet.Steer) <= 8 && packet.CurrentEngineRpm > 0 && packet.EngineMaxRpm > 0 && packet.CurrentEngineRpm < packet.EngineMaxRpm * 0.92
    && f1.pitLimiterStatus === 0 && f1.pitLaneTimerActive === 0 && f1.safetyCarStatus === 0 && (f1.vehicleFIAFlags === 0 || f1.vehicleFIAFlags === 1)
    && f1Surfaces.every((field) => f1[field] === 0);
}

/** No source-packet age survives normalization. Value changes show sequential evidence, not known freshness. */
function statusChanged(previous: F1ExtendedData, current: F1ExtendedData): boolean {
  return statusFields.some((field) => Number.isFinite(previous[field]) && Number.isFinite(current[field]) && previous[field] !== current[field]);
}

const statusFields = ["ersStoreEnergy", "ersDeployedThisLap", "ersHarvestedThisLap", "fuelRemainingLaps", "drsActivationDistance"] as const;

export function detectUnusedDrs(telemetry: readonly TelemetryPacket[]): LapInsight | null {
  const dt = eventDurations(telemetry);
  const flags = new Array<boolean>(telemetry.length).fill(false);
  let armed = false;
  let closedSeconds = 0;
  let unchangedSeconds = 0;
  for (let i = 0; i < telemetry.length; i++) {
    const packet = telemetry[i];
    const f1 = packet.f1;
    const previous = telemetry[i - 1]?.f1;
    const continuous = i > 0 && dt[i - 1] > 0 && dt[i] > 0;
    if (!continuous || !f1 || !previous || f1.drsFault !== 0 || previous.drsFault !== 0 || typeof f1.drsAllowed !== "boolean" || typeof f1.drsActivated !== "boolean") {
      armed = false;
      closedSeconds = 0;
      unchangedSeconds = 0;
      continue;
    }
    unchangedSeconds = statusChanged(previous, f1) ? 0 : unchangedSeconds + dt[i - 1];
    if (!f1.drsAllowed || f1.drsActivated || unchangedSeconds > 0.5) {
      armed = false;
      closedSeconds = 0;
      continue;
    }
    if (previous.drsAllowed === false) armed = true;
    // A gear change or corner exit interrupts demand, not the known DRS zone.
    if (!f1Demand(packet) || !f1Demand(telemetry[i - 1]) || packet.Gear !== telemetry[i - 1].Gear) {
      closedSeconds = 0;
      continue;
    }
    if (!armed) continue;
    closedSeconds += dt[i];
    flags[i] = closedSeconds > 0.5 + 1e-9;
  }
  const events = groupEvents(flags, dt, 1);
  if (events.length === 0) return null;
  const seconds = events.reduce((total, [start, end]) => total + eventSeconds(dt, start, end), 0);
  return {
    id: "driving-unused-drs",
    category: "driving",
    severity: "info",
    label: "DRS Available but Closed",
    detail: `DRS remained closed while reported available for ${seconds.toFixed(1)}s after a 0.5s response allowance on full-throttle straights; source packet ages are unavailable`,
    frameIndices: midFrame(events),
    evidenceSource: "native",
  };
}

export function detectErsDepletion(telemetry: readonly TelemetryPacket[]): LapInsight | null {
  const dt = eventDurations(telemetry);
  const flags = new Array<boolean>(telemetry.length).fill(false);
  let priorStore = 0;
  let priorPower = 0;
  let deployingSeconds = 0;
  let deployedEnergy = 0;
  let elapsed = 0;
  let depletedAt = -1;
  let deployedAtDepletion = 0;
  let unchangedSeconds = 0;
  for (let i = 1; i < telemetry.length; i++) {
    const packet = telemetry[i];
    const f1 = packet.f1;
    const previous = telemetry[i - 1];
    const prior = previous.f1;
    const valid = dt[i - 1] > 0 && dt[i] > 0 && f1 && prior && f1Demand(packet) && f1Demand(previous) && f1.ersFault === 0 && prior.ersFault === 0
      && packet.Gear === previous.Gear && f1.ersDeployMode > 0 && f1.ersDeployMode <= 3 && Number.isInteger(f1.ersDeployMode) && f1.ersDeployMode === prior.ersDeployMode
      && Number.isFinite(f1.ersStoreEnergy) && f1.ersStoreEnergy >= 0 && Number.isFinite(prior.ersStoreEnergy) && prior.ersStoreEnergy >= 0
      && Number.isFinite(f1.enginePowerMGUK) && f1.enginePowerMGUK! >= 0 && Number.isFinite(prior.enginePowerMGUK)
      && Number.isFinite(f1.ersDeployedThisLap) && f1.ersDeployedThisLap >= 0 && Number.isFinite(prior.ersDeployedThisLap) && prior.ersDeployedThisLap >= 0
      && f1.ersDeployedThisLap >= prior.ersDeployedThisLap && packet.LapNumber === previous.LapNumber;
    if (!valid || !f1 || !prior) {
      priorStore = priorPower = deployingSeconds = deployedEnergy = elapsed = unchangedSeconds = 0;
      depletedAt = -1;
      continue;
    }
    unchangedSeconds = statusChanged(prior, f1) ? 0 : unchangedSeconds + dt[i - 1];
    if (unchangedSeconds > 0.5) {
      priorStore = priorPower = deployingSeconds = deployedEnergy = elapsed = 0;
      depletedAt = -1;
      continue;
    }
    elapsed += dt[i - 1];
    if (depletedAt < 0 && f1.ersStoreEnergy > 0 && f1.enginePowerMGUK! > 0) {
      priorStore = Math.max(priorStore, prior.ersStoreEnergy);
      priorPower = Math.max(priorPower, f1.enginePowerMGUK!);
      deployingSeconds += dt[i - 1];
      deployedEnergy += f1.ersDeployedThisLap - prior.ersDeployedThisLap;
    }
    // Relative to this observed deployment run, never a guessed battery capacity/SOC.
    const exhausted = deployingSeconds >= 0.4 && deployedEnergy > 0 && priorStore > 0 && f1.ersStoreEnergy <= priorStore * 0.02 && f1.enginePowerMGUK! <= priorPower * 0.2;
    if (!exhausted) {
      depletedAt = -1;
      continue;
    }
    if (depletedAt < 0) {
      depletedAt = elapsed;
      deployedAtDepletion = f1.ersDeployedThisLap;
    }
    const depletedSeconds = elapsed - depletedAt;
    const rate = depletedSeconds > 0 ? (f1.ersDeployedThisLap - deployedAtDepletion) / depletedSeconds : Infinity;
    flags[i] = depletedSeconds >= 0.25 && rate <= (deployedEnergy / deployingSeconds) * 0.2;
  }
  const events = groupEvents(flags, dt, 0.75);
  if (events.length === 0) return null;
  const seconds = events.reduce((total, [start, end]) => total + eventSeconds(dt, start, end), 0);
  return {
    id: "mech-ers-depletion",
    category: "mechanical",
    severity: "info",
    label: "ERS Depletion Under Load",
    detail: `Stored ERS energy approached zero with reduced electrical power and deployment rate for ${seconds.toFixed(1)}s at continued demand; deployment strategy and source packet ages are not known`,
    frameIndices: midFrame(events),
    evidenceSource: "native",
  };
}
