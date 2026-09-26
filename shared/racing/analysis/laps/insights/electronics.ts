import type { F1ExtendedData } from "../../../../telemetry/f1-2025";
import type { TelemetryPacket } from "../../../../telemetry/types";
import type { AllWheelStates } from "../physics/vehicle";
import { runSelectedInsightScan, type InsightAccumulator } from "./scan";
import { appendInsights, INSIGHT_ORDER, insightAt, type LapInsight, type OrderedInsight } from "./types";

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
function nativeInsight(aid: Aid, frames: number[], activeSeconds: number, demandSeconds: number, activeDemandSeconds: number): LapInsight | null {
  if (frames.length === 0) return null;
  const duty = demandSeconds > 0
    ? `; active during ${(100 * activeDemandSeconds / demandSeconds).toFixed(0)}% of ${demandSeconds.toFixed(1)}s observed ${aid === "ABS" ? "braking" : "acceleration"}`
    : "";
  return {
    id: aid === "ABS" ? "driving-abs-activation" : "driving-traction-control-activation",
    category: "driving", severity: "info", label: `${aid} Activation`,
    detail: `${frames.length} ${aid} intervention${frames.length === 1 ? "" : "s"} reported by game, ${activeSeconds.toFixed(2)}s active${duty}`,
    frameIndices: frames, evidenceSource: "native",
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


/** Native activity is observational, even when aid settings or driving conditions disagree. */
export function detectAbsActivation(telemetry: readonly TelemetryPacket[], options: AidDetectionOptions): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createElectronicScan(telemetry, { abs: options }), { wheelStates: options.wheelStates }), INSIGHT_ORDER.absActivation);
}

/** RPM modulation alone cannot distinguish TC from ordinary driveline oscillation. */
export function detectTractionControlActivation(telemetry: readonly TelemetryPacket[], options: AidDetectionOptions): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createElectronicScan(telemetry, { tractionControl: options }), { wheelStates: options.wheelStates }), INSIGHT_ORDER.tractionControlActivation);
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
  return insightAt(runSelectedInsightScan(telemetry, createElectronicScan(telemetry, { f1Enabled: true })), INSIGHT_ORDER.unusedDrs);
}

export function detectErsDepletion(telemetry: readonly TelemetryPacket[]): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createElectronicScan(telemetry, { f1Enabled: true })), INSIGHT_ORDER.ersDepletion);
}

export function createElectronicScan(
  telemetry: readonly TelemetryPacket[],
  options: { abs?: AidDetectionOptions; tractionControl?: AidDetectionOptions; f1Enabled?: boolean },
): InsightAccumulator {
  const absScan = options.abs ? createAidScan(telemetry, "ABS", options.abs) : undefined;
  const tcScan = options.tractionControl ? createAidScan(telemetry, "Traction Control", options.tractionControl) : undefined;
  const drsEvents = createOnlineEvents(1, 0);
  const ersEvents = createOnlineEvents(0.75, 0);
  let armed = false, closedSeconds = 0, drsUnchangedSeconds = 0, ersUnchangedSeconds = 0;
  let previousPacket: TelemetryPacket | undefined;
  let priorStore = 0, priorPower = 0, deployingSeconds = 0, deployedEnergy = 0, elapsed = 0, depletedAt = -1, deployedAtDepletion = 0;
  return {
    observe(i, seconds, previousSeconds, _wheelState) {
      absScan?.observe(i, seconds, previousSeconds, _wheelState);
      tcScan?.observe(i, seconds, previousSeconds, _wheelState);
      const packet = telemetry[i];
      if (options.f1Enabled) {
        const f1 = packet.f1, previous = previousPacket?.f1;
        let drsFlag = false;
        if (!(previousPacket && previousSeconds > 0 && seconds > 0 && f1 && previous
          && f1.drsFault === 0 && previous.drsFault === 0 && typeof f1.drsAllowed === "boolean" && typeof f1.drsActivated === "boolean")) {
          armed = false; closedSeconds = 0; drsUnchangedSeconds = 0;
        } else {
          drsUnchangedSeconds = statusChanged(previous, f1) ? 0 : drsUnchangedSeconds + previousSeconds;
          if (!f1.drsAllowed || f1.drsActivated || drsUnchangedSeconds > 0.5) {
            armed = false; closedSeconds = 0;
          } else {
            if (previous.drsAllowed === false) armed = true;
            if (!f1Demand(packet) || !f1Demand(previousPacket) || packet.Gear !== previousPacket.Gear) closedSeconds = 0;
            else if (armed) {
              closedSeconds += seconds;
              drsFlag = closedSeconds > 0.5 + 1e-9;
            }
          }
        }
        drsEvents.observe(i, seconds, drsFlag);

        let ersFlag = false;
        const prior = previousPacket?.f1;
        const valid = previousPacket && previousSeconds > 0 && seconds > 0 && f1 && prior && f1Demand(packet) && f1Demand(previousPacket!)
          && f1.ersFault === 0 && prior.ersFault === 0 && packet.Gear === previousPacket!.Gear
          && f1.ersDeployMode > 0 && f1.ersDeployMode <= 3 && Number.isInteger(f1.ersDeployMode) && f1.ersDeployMode === prior.ersDeployMode
          && Number.isFinite(f1.ersStoreEnergy) && f1.ersStoreEnergy >= 0 && Number.isFinite(prior.ersStoreEnergy) && prior.ersStoreEnergy >= 0
          && Number.isFinite(f1.enginePowerMGUK) && f1.enginePowerMGUK! >= 0 && Number.isFinite(prior.enginePowerMGUK)
          && Number.isFinite(f1.ersDeployedThisLap) && f1.ersDeployedThisLap >= 0 && Number.isFinite(prior.ersDeployedThisLap) && prior.ersDeployedThisLap >= 0
          && f1.ersDeployedThisLap >= prior.ersDeployedThisLap && packet.LapNumber === previousPacket!.LapNumber;
        if (!valid || !f1 || !prior) {
          priorStore = priorPower = deployingSeconds = deployedEnergy = elapsed = ersUnchangedSeconds = 0; depletedAt = -1;
        } else {
          ersUnchangedSeconds = statusChanged(prior, f1) ? 0 : ersUnchangedSeconds + previousSeconds;
          if (ersUnchangedSeconds > 0.5) {
            priorStore = priorPower = deployingSeconds = deployedEnergy = elapsed = 0; depletedAt = -1;
          } else {
            elapsed += previousSeconds;
            if (depletedAt < 0 && f1.ersStoreEnergy > 0 && f1.enginePowerMGUK! > 0) {
              priorStore = Math.max(priorStore, prior.ersStoreEnergy);
              priorPower = Math.max(priorPower, f1.enginePowerMGUK!);
              deployingSeconds += previousSeconds;
              deployedEnergy += f1.ersDeployedThisLap - prior.ersDeployedThisLap;
            }
            const exhausted = deployingSeconds >= 0.4 && deployedEnergy > 0 && priorStore > 0
              && f1.ersStoreEnergy <= priorStore * 0.02 && f1.enginePowerMGUK! <= priorPower * 0.2;
            if (!exhausted) depletedAt = -1;
            else {
              if (depletedAt < 0) { depletedAt = elapsed; deployedAtDepletion = f1.ersDeployedThisLap; }
              const depletedSeconds = elapsed - depletedAt;
              const rate = depletedSeconds > 0 ? (f1.ersDeployedThisLap - deployedAtDepletion) / depletedSeconds : Infinity;
              ersFlag = depletedSeconds >= 0.25 && rate <= (deployedEnergy / deployingSeconds) * 0.2;
            }
          }
        }
        ersEvents.observe(i, seconds, ersFlag);
      }
      previousPacket = packet;
    },
    finish() {
      const drs = options.f1Enabled ? onlineEventInsight(drsEvents.finish(), "drs") : null;
      const ers = options.f1Enabled ? onlineEventInsight(ersEvents.finish(), "ers") : null;
      const output: OrderedInsight[] = [];
      appendInsights(output, INSIGHT_ORDER.absActivation, absScan?.finish() ?? null);
      appendInsights(output, INSIGHT_ORDER.tractionControlActivation, tcScan?.finish() ?? null);
      appendInsights(output, INSIGHT_ORDER.unusedDrs, drs);
      appendInsights(output, INSIGHT_ORDER.ersDepletion, ers);
      return output;
    },
  };
}

function createAidScan(telemetry: readonly TelemetryPacket[], aid: Aid, options: AidDetectionOptions) {
  const nativeEvents = createOnlineEvents(0, 4 / 60);
  const frames: number[] = [];
  const observedWheelStates = aid === "Traction Control" && !options.wheelStates ? new Array<AllWheelStates | undefined>(telemetry.length) : undefined;
  let activeSeconds = 0, demandSeconds = 0, activeDemandSeconds = 0;
  let first = -1, last = -1, count = 0, gap = 0, nextIndex = 0;
  const eligibility = new Uint8Array(telemetry.length);
  const dt = (i: number): number => {
    if (i < 0 || i + 1 >= telemetry.length) return 0;
    const d = (telemetry[i + 1].TimestampMS - telemetry[i].TimestampMS) / 1000;
    return Number.isFinite(d) && d > 0 && d <= 0.1 ? d : 0;
  };
  const eligible = (i: number): boolean => {
    if (eligibility[i]) return eligibility[i] === 1;
    const result = evaluateEligibility(i);
    eligibility[i] = result ? 1 : 2;
    return result;
  };
  const evaluateEligibility = (i: number): boolean => {
    const p = telemetry[i];
    const disabled = aid === "ABS" ? p.f1?.antiLockBrakes === 0 || p.acc?.abs === 0
      : p.f1?.tractionControl === 0 || p.acc?.tc === 0;
    if (!options.wheelRotationAvailable || (p.f1 && !p.f1.motionEx) || disabled || disturbed(p)
      || (i > 0 && p.Gear !== telemetry[i - 1].Gear)) return false;
    if (aid === "ABS" ? !(p.Brake >= 90 && p.Accel <= 30 && p.Speed >= 8)
      : !(p.Accel >= 150 && p.Brake <= 25 && p.Speed >= 5 && p.CurrentEngineRpm > 0)) return false;
    let elapsed = 0;
    for (let j = i - 1; j >= 0; j--) {
      const step = dt(j);
      if (!(step > 0)) break;
      elapsed += step;
      if (elapsed > 0.2) break;
      if (disturbed(telemetry[j]) || (j > 0 && telemetry[j].Gear !== telemetry[j - 1].Gear)) return false;
    }
    elapsed = 0;
    for (let j = i + 1; j < telemetry.length; j++) {
      const step = dt(j - 1);
      if (!(step > 0)) break;
      elapsed += step;
      if (elapsed > 0.2) break;
      if (disturbed(telemetry[j]) || telemetry[j].Gear !== telemetry[j - 1].Gear) return false;
    }
    return true;
  };
  const pulse = (i: number): boolean => {
    if (i <= 0 || i >= telemetry.length - 1) return false;
    const p = telemetry[i], fields = aid === "ABS" ? wheelRotation : ["CurrentEngineRpm"] as const;
    if (aid === "Traction Control") {
      const state = options.wheelStates?.[i - 1] ?? observedWheelStates?.[i - 1];
      if (!state || !wheelKeys.some((wheel) => state[wheel].state === "spin")) return false;
    }
    for (const field of fields) {
      const current = Math.abs(p[field]);
      if (!Number.isFinite(current) || !(current < Math.abs(telemetry[i - 1][field])) || !(current <= Math.abs(telemetry[i + 1][field]))) continue;
      const input = aid === "ABS" ? "Brake" : "Accel";
      const swing = aid === "ABS" ? Math.max(1, current * 0.04) : Math.max(120, p.CurrentEngineRpm * 0.025);
      let valid = true;
      for (const direction of [-1, 1]) {
        let elapsed = 0, recovered = false;
        for (let j = i + direction; j >= 0 && j < telemetry.length; j += direction) {
          const step = dt(direction < 0 ? j : j - 1);
          if (!(step > 0) || !eligible(j) || !Number.isFinite(telemetry[j][field])
            || Math.abs(telemetry[j][input] - p[input]) > 15) break;
          elapsed += step;
          if (elapsed > 0.12 + 1e-9) break;
          if (Math.abs(telemetry[j][field]) - current >= swing) { recovered = true; break; }
        }
        if (!recovered) { valid = false; break; }
      }
      if (valid) return true;
    }
    return false;
  };
  const troughCandidate = (i: number): boolean => {
    if (i <= 0 || i + 1 >= telemetry.length) return false;
    const p = telemetry[i], before = telemetry[i - 1], after = telemetry[i + 1];
    if (aid === "Traction Control") {
      const rpm = Math.abs(p.CurrentEngineRpm);
      return rpm < Math.abs(before.CurrentEngineRpm) && rpm <= Math.abs(after.CurrentEngineRpm);
    }
    for (const field of wheelRotation) {
      const rotation = Math.abs(p[field]);
      if (rotation < Math.abs(before[field]) && rotation <= Math.abs(after[field])) return true;
    }
    return false;
  };
  const accept = (i: number, seconds: number, isEligible: boolean, isPulse: boolean) => {
    const flush = () => {
      if (count >= 2) frames.push(Math.round((first + last) / 2));
      first = -1; count = 0; gap = 0;
    };
    if (!(seconds > 0) || !isEligible) { flush(); return; }
    const maxGap = aid === "ABS" ? 0.3 : 0.5;
    if (count > 0 && gap > maxGap) flush();
    if (isPulse && (count === 0 || gap >= 0.03)) {
      if (count === 0) first = i;
      last = i; count++; gap = 0;
    }
    gap += seconds;
  };
  return {
    observe(i: number, seconds: number, _previousSeconds: number, wheelState?: AllWheelStates) {
      if (observedWheelStates) observedWheelStates[i] = wheelState;
      const p = telemetry[i];
      if (options.nativeChannelAvailable) {
        const value = aid === "ABS" ? p.acc?.absIntervention : p.acc?.tcIntervention;
        const valid = value !== undefined && Number.isFinite(value) && seconds > 0;
        const active = valid && value! > 0;
        if (active) activeSeconds += seconds;
        const demand = aid === "ABS" ? p.Brake >= 90 && p.Speed >= 8 : p.Accel >= 150 && p.Speed >= 5;
        if (valid && demand) { demandSeconds += seconds; if (active) activeDemandSeconds += seconds; }
        nativeEvents.observe(i, seconds, !!active);
        return;
      }
      while (nextIndex < i) {
        const j = nextIndex++;
        const p = telemetry[j];
        const demand = aid === "ABS"
          ? p.Brake >= 90 && p.Accel <= 30 && p.Speed >= 8
          : p.Accel >= 150 && p.Brake <= 25 && p.Speed >= 5 && p.CurrentEngineRpm > 0;
        const candidate = count > 0 || (demand && troughCandidate(j));
        const ok = candidate && eligible(j);
        accept(j, dt(j), ok, ok && pulse(j));
      }
    },
    finish() {
      if (options.nativeChannelAvailable) {
        return nativeInsight(aid, nativeEvents.finish().frames, activeSeconds, demandSeconds, activeDemandSeconds);
      }
      while (nextIndex < telemetry.length) {
        const j = nextIndex++;
        const ok = eligible(j);
        accept(j, dt(j), ok, false);
      }
      if (count >= 2) frames.push(Math.round((first + last) / 2));
      return inferredInsight(aid, frames, aid === "ABS" ? "wheel-speed pulsing under braking" : "RPM cuts with independently measured wheelspin");
    },
  };
}

function createOnlineEvents(minSeconds: number, mergeGap: number) {
  let start = -1, end = -1, active = 0, gap = 0, eventSecondsTotal = 0;
  const frames: number[] = [];
  const flush = () => {
    if (start >= 0 && active + 1e-9 >= minSeconds) frames.push(Math.round((start + end) / 2));
    start = -1; active = 0; gap = 0;
  };
  return {
    observe(index: number, dt: number, flag: boolean) {
      if (!(dt > 0) || !Number.isFinite(dt)) flush();
      else if (flag) {
        if (start < 0) start = index;
        end = index; active += dt; gap = 0; eventSecondsTotal += dt;
      } else if (start >= 0) {
        gap += dt;
        if (gap > mergeGap + 1e-9) flush();
      }
    },
    finish() { flush(); return { frames, seconds: eventSecondsTotal }; },
  };
}

function onlineEventInsight(event: { frames: number[]; seconds: number }, family: "drs" | "ers"): LapInsight | null {
  if (!event.frames.length) return null;
  if (family === "drs") return {
    id: "driving-unused-drs", category: "driving", severity: "info", label: "DRS Available but Closed",
    detail: `DRS remained closed while reported available for ${event.seconds.toFixed(1)}s after a 0.5s response allowance on full-throttle straights; source packet ages are unavailable`,
    frameIndices: event.frames, evidenceSource: "native",
  };
  return {
    id: "mech-ers-depletion", category: "mechanical", severity: "info", label: "ERS Depletion Under Load",
    detail: `Stored ERS energy approached zero with reduced electrical power and deployment rate for ${event.seconds.toFixed(1)}s at continued demand; deployment strategy and source packet ages are not known`,
    frameIndices: event.frames, evidenceSource: "native",
  };
}


