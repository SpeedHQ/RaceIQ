import { getGame } from "../../../../games/registry";
import type { GameId } from "../../../../games/ids";
import type { TelemetryPacket } from "../../../../telemetry/types";
import type { EligibilityPolicyId, LapQualitySummary, QualityDistanceRange } from "../../../../racing/quality/contracts";
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

function eligibleSegments(telemetry: readonly TelemetryPacket[], quality: LapQualitySummary, policyId: EligibilityPolicyId): Array<{ packets: TelemetryPacket[]; indices: number[] }> {
  const wholeLap = evaluateEligibility(policyId, quality);
  if (isEligibilityUsable(wholeLap)) {
    return [{ packets: [...telemetry], indices: telemetry.map((_, index) => index) }];
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
  const usableRanges: QualityDistanceRange[] = [];
  for (let index = 1; index < sorted.length; index++) {
    const startFraction = sorted[index - 1]!;
    const endFraction = sorted[index]!;
    const midpoint = (startFraction + endFraction) / 2;
    const pointRange = { startFraction: midpoint, endFraction: midpoint };
    if (
      isEligibilityUsable(
        evaluateEligibility(policyId, quality, {
          range: pointRange,
        }),
      )
    ) {
      usableRanges.push({ startFraction, endFraction });
    }
  }
  if (usableRanges.length === 0) return [];

  const firstDistance = telemetry[0]?.DistanceTraveled;
  const lastDistance = telemetry[telemetry.length - 1]?.DistanceTraveled;
  const span = (lastDistance ?? 0) - (firstDistance ?? 0);
  if (!Number.isFinite(span) || span <= 0) return [];
  const segments: Array<{ packets: TelemetryPacket[]; indices: number[] }> = [];
  let current: { packets: TelemetryPacket[]; indices: number[] } | null = null;
  for (let index = 0; index < telemetry.length; index++) {
    const packet = telemetry[index]!;
    const fraction = Math.max(0, Math.min(1, (packet.DistanceTraveled - firstDistance!) / span));
    const usable = usableRanges.some((range) => fraction >= range.startFraction && fraction <= range.endFraction);
    if (!usable) {
      if (current && current.packets.length >= 10) segments.push(current);
      current = null;
      continue;
    }
    if (!current) current = { packets: [], indices: [] };
    current.packets.push(packet);
    current.indices.push(index);
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
  const cornerUsable = isEligibilityUsable(evaluateEligibility("corner-trace", quality));
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

  if (cornerUsable) {
    const dt = frameDt(telemetry);
    const ctx: TimeLossCtx = { dt, ref: buildAccelReference(telemetry, dt) };
    const imbalance = detectSuspensionImbalance(telemetry);
    if (imbalance) mergeInsights(insights, [imbalance], fullIndices);
    const detectors = [
      detectRevLimiter(telemetry, ctx),
      detectCoasting(telemetry, ctx),
      detectTrailBraking(telemetry),
      detectEarlyBraking(telemetry, ctx),
      detectOverSlowing(telemetry, ctx),
      detectEarlyThrottle(telemetry),
      detectBinaryThrottle(telemetry),
      detectBrakeDrag(telemetry),
      detectDownshiftOverRev(telemetry),
      detectLateBrakingOvershoot(telemetry),
      detectUndersteerScrub(telemetry),
      detectThrottleMicroLifts(telemetry, ctx),
    ].filter((insight): insight is LapInsight => insight != null);
    mergeInsights(insights, detectors, fullIndices);
  }

  for (const segment of eligibleSegments(telemetry, quality, "transient-event")) {
    mergeInsights(insights, detectSuspensionOverload(segment.packets), segment.indices);
    if (supportsWheelStateAnalysis) {
      mergeInsights(insights, detectLockups(segment.packets), segment.indices);
      const brakeLoss = detectBrakeTractionLoss(segment.packets);
      if (brakeLoss) mergeInsights(insights, [brakeLoss], segment.indices);
    }
    mergeInsights(insights, detectWheelspin(segment.packets), segment.indices);
    for (const detector of [detectCounterSteer(segment.packets), detectThrottleTractionLoss(segment.packets), detectSteeringSawing(segment.packets), detectKerbRiding(segment.packets)]) {
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
