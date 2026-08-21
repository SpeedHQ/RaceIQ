import type { ArmInput } from "../../../server/experiments/comparison/compare";
import type { ArmLap } from "../../../server/experiments/comparison/metrics";
import type { FrameLapMeta, LapFrameLoader } from "../../../server/experiments/comparison/stream";
import type { Corner } from "../../../server/lap-analysis/corners";
import type { EvaluableLap } from "../../../shared/racing/laps/review-selection";
import { DEFAULT_LAP_CLASSIFICATION, type LapClassification } from "../../../shared/racing/laps/classification";
import type { EligibilityDecisionSet, LapQualitySummary } from "../../../shared/racing/quality/contracts";
import { finalizeLapQualityGeneration } from "../../../server/lap-analysis/quality-generation";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { qualityPackets, summarize } from "../lap-analysis/quality-model";

/** Deterministic synthetic corner shared by frame-based arm suites. */
export const SYNTHETIC_CORNERS: Corner[] = [{ index: 1, label: "T1", distanceStart: 200, distanceEnd: 300 }];
export const FRAMES_PER_LAP = 121;
const LAP_TIME_OFFSETS = [0.32, 0.05, 0.71, 0.18, 0.94, 0.43, 0.6, 0.27, 0.85, 0.11];
export const CORNERS = SYNTHETIC_CORNERS;

/** Straight-line lap (600m along Z) with one corner at 200..300m. */
export function syntheticLap(lateralOffsetM: number, brakeShiftM: number): TelemetryPacket[] {
  const step = 600 / (FRAMES_PER_LAP - 1);
  const packets: TelemetryPacket[] = [];
  for (let i = 0; i < FRAMES_PER_LAP; i++) {
    const distance = i * step;
    const inCorner = distance >= 200 && distance <= 300;
    const braking = distance >= 220 - brakeShiftM && distance <= 260 - brakeShiftM;
    packets.push({
      gameId: "f1-2025",
      IsRaceOn: 1,
      TimestampMS: i * 100,
      DistanceTraveled: distance,
      PositionX: inCorner ? lateralOffsetM : 0,
      PositionZ: distance,
      VelocityX: 0,
      VelocityY: 0,
      VelocityZ: step / 0.1,
      Gear: 3,
      Accel: braking ? 0 : 1,
      Brake: braking ? 1 : 0,
    } as TelemetryPacket);
  }
  return packets;
}

let nextMetadataId = 1;
const policyEvidenceCache = new Map<string, LapClassification & { quality: LapQualitySummary; eligibility: EligibilityDecisionSet }>();

export function policyEvidence(
  classification: LapClassification = DEFAULT_LAP_CLASSIFICATION,
  structurallyValid = true,
  invalidReason: string | null = null,
): LapClassification & { quality: LapQualitySummary; eligibility: EligibilityDecisionSet } {
  const cacheKey = JSON.stringify([classification, structurallyValid, invalidReason]);
  const cached = policyEvidenceCache.get(cacheKey);
  if (cached) return cached;
  const packets = qualityPackets(200);
  const finalized = finalizeLapQualityGeneration(summarize(packets, { classification, structurallyValid, invalidReason }), `sha256:${"e".repeat(64)}`, {
    lapNumber: 1,
    rawByteOffset: 0,
    rawFrameCount: packets.length,
  });
  const evidence = { ...classification, ...finalized };
  policyEvidenceCache.set(cacheKey, evidence);
  return evidence;
}

/** Build metadata-only arms used by outcome and comparison statistics tests. */
export function metadataArm(lapTimes: number[], labelPrefix = "arm"): { label: string; laps: ArmLap[] } {
  const laps: ArmLap[] = lapTimes.map((lapTime) => {
    const lap: EvaluableLap = {
      id: nextMetadataId++,
      lapTime,
      isValid: true,
      invalidReason: null,
      experimentExcluded: false,
      experimentExcludedSource: null,
      ...policyEvidence(),
    };
    return { lap, telemetry: null };
  });
  return { label: `${labelPrefix}-${laps[0]?.lap.id ?? 0}`, laps };
}

/** Deterministic PRNG so statistical fixtures stay reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal samples from a seeded stream. */
export function normals(n: number, meanV: number, sd: number, seed: number): number[] {
  const rand = rng(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(meanV + sd * r * Math.cos(2 * Math.PI * u2));
    if (out.length < n) out.push(meanV + sd * r * Math.sin(2 * Math.PI * u2));
  }
  return out;
}

/** Build a frame-bearing arm using deterministic synthetic packets. */
export function telemetryArm(specs: { lateral: number; brakeShift: number }[], label = "telemetry-arm"): ArmInput {
  const laps: ArmLap[] = specs.map((spec, i) => ({
    lap: {
      id: nextMetadataId++,
      lapTime: 90 + i * 0.05,
      isValid: true,
      invalidReason: null,
      experimentExcluded: false,
      experimentExcludedSource: null,
      ...policyEvidence(),
    },
    telemetry: syntheticLap(spec.lateral, spec.brakeShift),
  }));
  return { label, laps, corners: SYNTHETIC_CORNERS };
}

export interface LapSpec {
  lateral: number;
  brakeShift: number;
  isValid?: boolean;
  /** Defaults to FRAMES_PER_LAP; 0 means no telemetry stored. */
  rawFrameCount?: number;
}

/** Build both in-memory and streaming representations from one lap spec list. */
export function buildStreamingArm(specs: LapSpec[], firstId = 1) {
  const frames = new Map<number, TelemetryPacket[]>();
  const metas: FrameLapMeta[] = [];
  const laps: ArmInput["laps"] = [];

  specs.forEach((spec, i) => {
    const id = firstId + i;
    const rawFrameCount = spec.rawFrameCount ?? FRAMES_PER_LAP;
    const isValid = spec.isValid ?? true;
    const lap = {
      id,
      lapTime: 90 + LAP_TIME_OFFSETS[i % LAP_TIME_OFFSETS.length],
      isValid,
      invalidReason: isValid ? null : "fixture-invalid",
      experimentExcluded: false,
      experimentExcludedSource: null,
      ...policyEvidence(DEFAULT_LAP_CLASSIFICATION, isValid, isValid ? null : "fixture-invalid"),
    };
    metas.push({ ...lap, lapNumber: i + 1, createdAt: `2026-01-01T00:0${i % 10}:00Z`, rawFrameCount });
    if (rawFrameCount > 0) frames.set(id, syntheticLap(spec.lateral, spec.brakeShift));
    laps.push({ lap, telemetry: rawFrameCount > 0 ? syntheticLap(spec.lateral, spec.brakeShift) : null });
  });

  return { inMemory: { label: "arm", laps, corners: SYNTHETIC_CORNERS } satisfies ArmInput, metas, frames };
}

/** Loader that records every decode, so peak live laps can be measured. */
export function trackingLoader(frames: Map<number, TelemetryPacket[]>) {
  const decoded: number[] = [];
  const loadFrames: LapFrameLoader = async (lapId) => {
    decoded.push(lapId);
    return frames.get(lapId) ?? null;
  };
  return { loadFrames, decoded };
}

export const SCATTERED: LapSpec[] = [
  { lateral: 0, brakeShift: 0 },
  { lateral: 3, brakeShift: 20 },
  { lateral: -3, brakeShift: -20 },
  { lateral: 2.5, brakeShift: 15 },
  { lateral: -2.5, brakeShift: -15 },
  { lateral: 1.5, brakeShift: 10 },
  { lateral: -1.2, brakeShift: -8 },
];
export const REPEATABLE: LapSpec[] = Array.from({ length: 7 }, () => ({ lateral: 0, brakeShift: 0 }));
