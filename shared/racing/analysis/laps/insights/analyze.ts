import { getGame } from "../../../../games/registry";
import type { GameId } from "../../../../games/ids";
import type { TelemetryPacket } from "../../../../telemetry/types";
import type { TelemetryVariableId } from "../../../../telemetry/catalog/generated/telemetry-catalog.types";
import type { EligibilityPolicyId, EligibilityReason, LapQualitySummary, QualityDistanceRange } from "../../../../racing/quality/contracts";
import { evaluateEligibility, isEligibilityUsable } from "../../../../racing/quality/policies";
import { frameDt } from "../frame-time";
import { buildAccelReference } from "../time-loss";
import { detectSuspensionOverload, detectSuspensionImbalance } from "./suspension";
import { detectFuelConsumption, detectPeakPower, detectBoostAnomaly } from "./mechanical";
import { detectTireOverheat, detectLockups, detectWheelspin, detectWearImbalance, detectTireTempSplit, detectInnerOuterTempSpread } from "./tires";
import {
  detectBrakeTractionLoss,
  detectRevLimiter,
  detectCoasting,
  detectTrailBraking,
  detectCounterSteer,
  detectEarlyBraking,
  detectOverSlowing,
  detectThrottleTractionLoss,
  detectEarlyThrottle,
  detectBinaryThrottle,
} from "./driving-core";
import { detectBrakeDrag, detectDownshiftOverRev, detectLateBrakingOvershoot, detectUndersteerScrub, detectSteeringSawing, detectThrottleMicroLifts, detectKerbRiding } from "./driving-advanced";
import type { LapInsight, TimeLossCtx } from "./types";
const SUSPENSION_EVENT_CHANNELS = ["motion.speed", "suspension.norm-suspension-travel"] as const;
const WHEEL_EVENT_CHANNELS = ["motion.speed", "tires.wheel-rotation-speed"] as const;
const BRAKE_TRACTION_CHANNELS = [...WHEEL_EVENT_CHANNELS, "inputs.brake"] as const;
const THROTTLE_TRACTION_CHANNELS = [...WHEEL_EVENT_CHANNELS, "inputs.accel"] as const;
const STEERING_EVENT_CHANNELS = ["motion.speed", "inputs.steer"] as const;


function mergeInsights(target: LapInsight[], additions: LapInsight[], sourceIndices: readonly number[]): void {
  for (const addition of additions) {
    const remapped = addition.frameIndices.map((index) => sourceIndices[index]).filter((index): index is number => index != null);
    if (remapped.length === 0) continue;
    const existing = target.find((insight) => insight.id === addition.id);
    if (!existing) {
      target.push({ ...addition, frameIndices: remapped });
      continue;
    }
    existing.frameIndices = [...new Set([...existing.frameIndices, ...remapped])].sort((left, right) => left - right);
    if (addition.timeLossS != null) existing.timeLossS = (existing.timeLossS ?? 0) + addition.timeLossS;
  }
}

function warningReasonCoversPacket(
  reason: EligibilityReason,
  packet: TelemetryPacket,
  distanceFraction: number,
): boolean {
  const distanceCovered =
    reason.distanceRange != null &&
    distanceFraction >= reason.distanceRange.startFraction &&
    distanceFraction <= reason.distanceRange.endFraction;
  const timeCovered =
    reason.timeRange != null &&
    packet.TimestampMS >= reason.timeRange.startMs &&
    packet.TimestampMS <= reason.timeRange.endMs;
  return distanceCovered || timeCovered;
}

function eligibleSegments(
  telemetry: TelemetryPacket[],
  quality: LapQualitySummary,
  policyId: EligibilityPolicyId,
  sourceIndices: number[],
  requiredSemanticIds?: readonly TelemetryVariableId[],
): Array<{ packets: TelemetryPacket[]; indices: number[] }> {
  const policyOptions = requiredSemanticIds ? { requiredSemanticIds } : {};
  const wholeLap = evaluateEligibility(policyId, quality, policyOptions);
  // Transient detectors also depend on lap distance and speed, whose localized warnings belong to lap-comparison.
  const warningPolicyIds: readonly EligibilityPolicyId[] =
    policyId === "transient-event" ? ["transient-event", "lap-comparison"] : [policyId];
  const rangedWarningReasons = warningPolicyIds.flatMap((warningPolicyId) => {
    const decision = warningPolicyId === policyId ? wholeLap : evaluateEligibility(warningPolicyId, quality);
    return decision.status === "eligible_with_warning"
      ? decision.reasons.filter((reason) => reason.distanceRange != null || reason.timeRange != null)
      : [];
  });
  if (
    isEligibilityUsable(wholeLap) &&
    rangedWarningReasons.length === 0 &&
    !quality.facts.some((fact) => fact.distanceRange) &&
    !quality.channelQuality.some((channel) => channel.issueIntervals.some((issue) => issue.distanceRange))
  ) {
    return [{ packets: telemetry, indices: sourceIndices }];
  }
  const boundaries = new Set<number>([0, 1]);
  for (const fact of quality.facts) {
    if (!fact.distanceRange) continue;
    boundaries.add(fact.distanceRange.startFraction);
    boundaries.add(fact.distanceRange.endFraction);
  }
  for (const channel of quality.channelQuality) {
    for (const issue of channel.issueIntervals) {
      if (!issue.distanceRange) continue;
      boundaries.add(issue.distanceRange.startFraction);
      boundaries.add(issue.distanceRange.endFraction);
    }
  }
  const sorted = [...boundaries].filter(Number.isFinite).sort((left, right) => left - right);
  const pointUsability = sorted.map((fraction) =>
    isEligibilityUsable(
      evaluateEligibility(policyId, quality, {
        range: { startFraction: fraction, endFraction: fraction },
        ...policyOptions,
      }),
    ),
  );
  const ranges: Array<QualityDistanceRange & { interiorUsable: boolean; startUsable: boolean; endUsable: boolean }> = [];
  let hasUsableRange = false;
  for (let index = 1; index < sorted.length; index++) {
    const startFraction = sorted[index - 1]!;
    const endFraction = sorted[index]!;
    const midpoint = (startFraction + endFraction) / 2;
    const interiorUsable = isEligibilityUsable(
      evaluateEligibility(policyId, quality, {
        range: { startFraction: midpoint, endFraction: midpoint },
        ...policyOptions,
      }),
    );
    const startUsable = pointUsability[index - 1]!;
    const endUsable = pointUsability[index]!;
    ranges.push({ startFraction, endFraction, interiorUsable, startUsable, endUsable });
    hasUsableRange ||= interiorUsable || startUsable || endUsable;
  }
  if (!hasUsableRange) return [];

  const firstDistance = telemetry[0]?.DistanceTraveled;
  const lastDistance = telemetry[telemetry.length - 1]?.DistanceTraveled;
  const span = (lastDistance ?? 0) - (firstDistance ?? 0);
  if (!Number.isFinite(span) || span <= 0) return [];
  const segments: Array<{ packets: TelemetryPacket[]; indices: number[] }> = [];
  let current: { packets: TelemetryPacket[]; indices: number[] } | null = null;
  for (let index = 0; index < telemetry.length; index++) {
    const packet = telemetry[index]!;
    const fraction = Math.max(0, Math.min(1, (packet.DistanceTraveled - firstDistance!) / span));
    let usable = false;
    for (const range of ranges) {
      if (fraction < range.startFraction || fraction > range.endFraction) continue;
      const pointUsable = fraction === range.startFraction ? range.startUsable : fraction === range.endFraction ? range.endUsable : range.interiorUsable;
      if (!pointUsable) {
        usable = false;
        break;
      }
      usable = true;
    }
    if (usable && rangedWarningReasons.some((reason) => warningReasonCoversPacket(reason, packet, fraction))) usable = false;
    if (!usable) {
      if (current && current.packets.length >= 10) segments.push(current);
      current = null;
      continue;
    }
    if (!current) current = { packets: [], indices: [] };
    current.packets.push(packet);
    current.indices.push(sourceIndices[index]!);
  }
  if (current && current.packets.length >= 10) segments.push(current);
  return segments;
}

export function analyzeLap(telemetry: TelemetryPacket[], gameId: GameId, quality?: LapQualitySummary | null): LapInsight[] {
  if (telemetry.length < 10 || !quality) return [];
  const game = getGame(gameId);
  const tireTemperatureUnit = game.telemetry.tireTemperature.packetUnit;
  const supportsWheelStateAnalysis = game.telemetry.analysis?.wheelRotation?.source !== "unavailable";
  const insights: LapInsight[] = [];
  const fullIndices = telemetry.map((_, index) => index);
  const tireUsable = isEligibilityUsable(evaluateEligibility("tire-analysis", quality));
  const fuelUsable = isEligibilityUsable(evaluateEligibility("fuel-burn", quality));
  const comparisonUsable = isEligibilityUsable(evaluateEligibility("lap-comparison", quality));

  if (tireUsable) {
    mergeInsights(insights, detectTireOverheat(telemetry, tireTemperatureUnit), fullIndices);
    const wear = detectWearImbalance(telemetry);
    if (wear) mergeInsights(insights, [wear], fullIndices);
    const split = detectTireTempSplit(telemetry, tireTemperatureUnit);
    if (split) mergeInsights(insights, [split], fullIndices);
    mergeInsights(insights, detectInnerOuterTempSpread(telemetry), fullIndices);
  }

  for (const segment of eligibleSegments(telemetry, quality, "corner-trace", fullIndices)) {
    const dt = frameDt(segment.packets);
    const ctx: TimeLossCtx = { dt, ref: buildAccelReference(segment.packets, dt) };
    const imbalance = detectSuspensionImbalance(segment.packets);
    if (imbalance) mergeInsights(insights, [imbalance], segment.indices);
    const detectors = [
      detectRevLimiter(segment.packets, ctx),
      detectCoasting(segment.packets, ctx),
      detectTrailBraking(segment.packets),
      detectEarlyBraking(segment.packets, ctx),
      detectOverSlowing(segment.packets, ctx),
      detectEarlyThrottle(segment.packets),
      detectBinaryThrottle(segment.packets),
      detectBrakeDrag(segment.packets),
      detectDownshiftOverRev(segment.packets),
      detectLateBrakingOvershoot(segment.packets),
      detectUndersteerScrub(segment.packets),
      detectThrottleMicroLifts(segment.packets, ctx),
    ].filter((insight): insight is LapInsight => insight != null);
    mergeInsights(insights, detectors, segment.indices);
  }

  for (const segment of eligibleSegments(telemetry, quality, "transient-event", fullIndices, SUSPENSION_EVENT_CHANNELS)) {
    mergeInsights(insights, detectSuspensionOverload(segment.packets), segment.indices);
    const kerb = detectKerbRiding(segment.packets);
    if (kerb) mergeInsights(insights, [kerb], segment.indices);
  }

  if (supportsWheelStateAnalysis) {
    for (const segment of eligibleSegments(telemetry, quality, "transient-event", fullIndices, WHEEL_EVENT_CHANNELS)) {
      mergeInsights(insights, detectLockups(segment.packets), segment.indices);
      mergeInsights(insights, detectWheelspin(segment.packets), segment.indices);
    }
    for (const segment of eligibleSegments(telemetry, quality, "transient-event", fullIndices, BRAKE_TRACTION_CHANNELS)) {
      const brakeLoss = detectBrakeTractionLoss(segment.packets);
      if (brakeLoss) mergeInsights(insights, [brakeLoss], segment.indices);
    }
    for (const segment of eligibleSegments(telemetry, quality, "transient-event", fullIndices, THROTTLE_TRACTION_CHANNELS)) {
      const throttleLoss = detectThrottleTractionLoss(segment.packets);
      if (throttleLoss) mergeInsights(insights, [throttleLoss], segment.indices);
    }
  }

  for (const segment of eligibleSegments(telemetry, quality, "transient-event", fullIndices, STEERING_EVENT_CHANNELS)) {
    for (const detector of [detectCounterSteer(segment.packets), detectSteeringSawing(segment.packets)]) {
      if (detector) mergeInsights(insights, [detector], segment.indices);
    }
  }

  if (fuelUsable) {
    const fuel = detectFuelConsumption(telemetry, game.telemetry.fuel.packetUnit);
    if (fuel) mergeInsights(insights, [fuel], fullIndices);
  }
  if (comparisonUsable) {
    for (const detector of [detectPeakPower(telemetry), detectBoostAnomaly(telemetry)]) {
      if (detector) mergeInsights(insights, [detector], fullIndices);
    }
  }
  return insights;
}
