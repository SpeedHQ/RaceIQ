import type { GearingSample } from "./gearing-telemetry";
import { isSampleValid } from "./gearing-validation";

export interface EffectiveGear {
  gear: number;
  /** Engine RPM per metre/second. This is the effective ratio seen at the wheels. */
  rpmPerMps: number;
  sampleCount: number;
  minRpm: number;
  maxRpm: number;
}

export type EffectiveGears = Record<number, EffectiveGear>;

const MIN_LEARNING_SPEED_MPS = 3;
const MIN_LEARNING_RPM = 1_000;
const MIN_LEARNING_THROTTLE = 32;
const MAX_LEARNING_BRAKE = 31;
const MAX_RATIO_DEVIATION = 0.08;
export const EFFECTIVE_GEAR_MIN_SAMPLES = 20;
export const EFFECTIVE_GEAR_MIN_RPM_SPAN = 1_000;

/** True once a gear has enough consistent samples across a useful RPM range. */
export function effectiveGearReady(gear: EffectiveGear): boolean {
  return gear.sampleCount >= EFFECTIVE_GEAR_MIN_SAMPLES && gear.maxRpm - gear.minRpm >= EFFECTIVE_GEAR_MIN_RPM_SPAN;
}

/**
 * Learn one gear's effective wheel ratio from RPM and road speed.
 *
 * No tire size, final drive, or entered setup is needed: RPM / speed is the
 * complete relationship required to predict redline speed and post-shift RPM.
 * Once a baseline exists, samples that differ by more than 8% are ignored as
 * likely wheelspin, clutch slip, or shift transients.
 */
export function updateEffectiveGearing(existing: EffectiveGears, packet: GearingSample): EffectiveGears {
  if (!isSampleValid(packet) || packet.Gear <= 0 || packet.speedMps < MIN_LEARNING_SPEED_MPS || packet.rpm < MIN_LEARNING_RPM) return existing;
  if (packet.Accel < MIN_LEARNING_THROTTLE || packet.Brake > MAX_LEARNING_BRAKE) return existing;

  const observed = packet.rpm / packet.speedMps;
  if (!Number.isFinite(observed) || observed <= 0) return existing;

  const current = existing[packet.Gear];
  if (current && current.sampleCount >= 5 && Math.abs(observed / current.rpmPerMps - 1) > MAX_RATIO_DEVIATION) return existing;

  const sampleCount = (current?.sampleCount ?? 0) + 1;
  const rpmPerMps = current ? current.rpmPerMps + (observed - current.rpmPerMps) / sampleCount : observed;
  return {
    ...existing,
    [packet.Gear]: {
      gear: packet.Gear,
      rpmPerMps,
      sampleCount,
      minRpm: current ? Math.min(current.minRpm, packet.rpm) : packet.rpm,
      maxRpm: current ? Math.max(current.maxRpm, packet.rpm) : packet.rpm,
    },
  };
}

/** Learn effective gearing from a recording using the same online estimator. */
export function computeEffectiveGearing(packets: GearingSample[]): EffectiveGears {
  let result: EffectiveGears = {};
  for (const packet of packets) result = updateEffectiveGearing(result, packet);
  return result;
}
