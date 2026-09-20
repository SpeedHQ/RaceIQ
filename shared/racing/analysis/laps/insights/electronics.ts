import type { TelemetryPacket } from "../../../../telemetry/types";
import { frameDt } from "../frame-time";
import { groupEvents, midFrame, type LapInsight } from "./types";

type Aid = "ABS" | "Traction Control";

const wheelRotation = ["WheelRotationSpeedFL", "WheelRotationSpeedFR", "WheelRotationSpeedRL", "WheelRotationSpeedRR"] as const;

function sampleTimeMs(telemetry: readonly TelemetryPacket[], index: number): number {
  const timestamp = telemetry[index]?.TimestampMS;
  return Number.isFinite(timestamp) ? timestamp : index * (1000 / 60);
}

/** Collapse repeated modulation pulses into braking/acceleration-zone events. */
function pulseEvents(telemetry: readonly TelemetryPacket[], pulseFrames: readonly number[], maxGapMs: number, minPulses: number): number[] {
  if (pulseFrames.length === 0) return [];
  const events: number[] = [];
  let start = 0;
  for (let i = 1; i <= pulseFrames.length; i++) {
    const split = i === pulseFrames.length || sampleTimeMs(telemetry, pulseFrames[i]) - sampleTimeMs(telemetry, pulseFrames[i - 1]) > maxGapMs;
    if (!split) continue;
    if (i - start >= minPulses) events.push(pulseFrames[Math.floor((start + i - 1) / 2)]);
    start = i;
  }
  return events;
}

function nativeInsight(aid: Aid, flags: boolean[]): LapInsight | null {
  const events = groupEvents(flags, 1, 4);
  if (events.length === 0) return null;
  const label = aid === "ABS" ? "ABS Activation" : "Traction Control Activation";
  return {
    id: aid === "ABS" ? "driving-abs-activation" : "driving-traction-control-activation",
    category: "driving",
    severity: events.length >= 5 ? "warning" : "info",
    label,
    detail: `${events.length} ${aid} intervention${events.length === 1 ? "" : "s"} reported by game`,
    frameIndices: midFrame(events),
  };
}

function inferredInsight(aid: Aid, eventFrames: number[], evidence: string): LapInsight | null {
  if (eventFrames.length === 0) return null;
  const label = aid === "ABS" ? "ABS Activation" : "Traction Control Activation";
  return {
    id: aid === "ABS" ? "driving-abs-activation" : "driving-traction-control-activation",
    category: "driving",
    severity: eventFrames.length >= 5 ? "warning" : "info",
    label,
    detail: `${eventFrames.length} inferred ${aid} intervention${eventFrames.length === 1 ? "" : "s"} from ${evidence}`,
    frameIndices: eventFrames,
  };
}

/** Detect ABS intervention, preferring a game-provided channel over inference. */
export function detectAbsActivation(telemetry: TelemetryPacket[], nativeChannelAvailable: boolean): LapInsight | null {
  if (nativeChannelAvailable) {
    return nativeInsight(
      "ABS",
      telemetry.map((packet) => (packet.acc?.absIntervention ?? 0) > 0),
    );
  }
  if (telemetry.length < 5) return null;

  const dt = frameDt(telemetry);
  const pulses: number[] = [];
  for (let i = 1; i < telemetry.length - 1; i++) {
    const packet = telemetry[i];
    if (packet.Brake < 90 || packet.Accel > 30 || packet.Speed < 8) continue;

    let pulse = false;
    for (const field of wheelRotation) {
      const previous = Math.abs(telemetry[i - 1][field]);
      const current = Math.abs(packet[field]);
      const next = Math.abs(telemetry[i + 1][field]);
      const scale = Math.max(previous, current, next, 20);
      const decelerationRate = (current - previous) / (dt[i - 1] * scale);
      const recoveryRate = (next - current) / (dt[i] * scale);
      if (decelerationRate < -1.5 && recoveryRate > 1.5) {
        pulse = true;
        break;
      }
    }
    if (pulse) pulses.push(i);
  }

  return inferredInsight("ABS", pulseEvents(telemetry, pulses, 300, 2), "wheel-speed pulsing under braking");
}

/** Detect traction-control torque cuts, preferring a game-provided channel over inference. */
export function detectTractionControlActivation(telemetry: TelemetryPacket[], nativeChannelAvailable: boolean): LapInsight | null {
  if (nativeChannelAvailable) {
    return nativeInsight(
      "Traction Control",
      telemetry.map((packet) => (packet.acc?.tcIntervention ?? 0) > 0),
    );
  }
  if (telemetry.length < 5) return null;

  const pulses: number[] = [];
  for (let i = 1; i < telemetry.length - 1; i++) {
    const previous = telemetry[i - 1];
    const packet = telemetry[i];
    const next = telemetry[i + 1];
    if (packet.Accel < 150 || previous.Accel < 150 || next.Accel < 150 || packet.Brake > 25 || packet.Speed < 5) continue;
    if (packet.Gear <= 0 || previous.Gear !== packet.Gear || next.Gear !== packet.Gear) continue;
    if (!(packet.CurrentEngineRpm > 0) || (packet.EngineMaxRpm > 0 && Math.max(previous.CurrentEngineRpm, packet.CurrentEngineRpm, next.CurrentEngineRpm) >= packet.EngineMaxRpm * 0.92)) continue;

    const drop = previous.CurrentEngineRpm - packet.CurrentEngineRpm;
    const recovery = next.CurrentEngineRpm - packet.CurrentEngineRpm;
    const minimumSwing = Math.max(120, previous.CurrentEngineRpm * 0.025);
    if (drop >= minimumSwing && recovery >= minimumSwing) pulses.push(i);
  }

  return inferredInsight("Traction Control", pulseEvents(telemetry, pulses, 500, 2), "RPM cuts under sustained throttle");
}
