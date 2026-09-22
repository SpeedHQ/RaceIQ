import { getGame } from "../../../../games/registry";
import type { GameId } from "../../../../games/ids";
import type { TelemetryPacket } from "../../../../telemetry/types";
import { buildAccelReference } from "../time-loss";
import { calibratedWheelStates } from "../physics/vehicle";
import { detectSuspensionOverload, detectSuspensionImbalance } from "./suspension";
import { detectFuelConsumption, detectPeakPower, detectBoostAnomaly } from "./mechanical";
import {
  detectLockups,
  detectTireOverheat,
  detectTirePressureImbalance,
  detectRapidPressureLoss,
  detectTireSurfaceProfile,
  detectTireTempSplit,
  detectWearImbalance,
  detectWheelspin,
} from "./tires";
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
  detectDelayedThrottlePickup,
} from "./driving-core";
import { detectAbsActivation, detectTractionControlActivation, detectUnusedDrs, detectErsDepletion } from "./electronics";
import {
  detectBrakeDrag,
  detectDownshiftOverRev,
  detectLateBrakingOvershoot,
  detectUndersteerScrub,
  detectOversteerSlide,
  detectSteeringSawing,
  detectThrottleMicroLifts,
  detectKerbRiding,
} from "./driving-advanced";
import { eventDurations, eventSeconds, type LapAnalysisContext, type LapInsight, type TimeLossCtx } from "./types";

export function analyzeLap(telemetry: TelemetryPacket[], gameId: GameId, context?: LapAnalysisContext): LapInsight[] {
  // F1 emits multiple merged snapshots per simulation tick. The last snapshot
  // contains that tick's latest channels; earlier updates add no elapsed time.
  let sourceIndices: number[] | undefined;
  if (gameId === "f1-2025" && telemetry.some((p, i) => i > 0 && p.TimestampMS === telemetry[i - 1].TimestampMS && p.sessionUID === telemetry[i - 1].sessionUID)) {
    const samples: TelemetryPacket[] = [];
    sourceIndices = [];
    for (let i = 0; i < telemetry.length; i++) {
      const packet = telemetry[i];
      const last = samples[samples.length - 1];
      if (last && packet.TimestampMS === last.TimestampMS && packet.sessionUID === last.sessionUID) {
        samples[samples.length - 1] = packet;
        sourceIndices[sourceIndices.length - 1] = i;
      } else {
        samples.push(packet);
        sourceIndices.push(i);
      }
    }
    telemetry = samples;
  }
  const dt = eventDurations(telemetry);
  if (eventSeconds(dt, 0, dt.length - 1) + 1e-9 < 1 / 6) return [];
  const game = getGame(gameId);
  const tireTemperatureUnit = game.telemetry.tireTemperature.packetUnit;
  const tireTemperature = game.telemetry.analysis?.tireTemperature;
  const supportsContinuousTireTemperature = tireTemperature?.source === "direct" && tireTemperature.freshness === "continuous";
  const primaryTemperatureIsCore =
    tireTemperature?.source === "direct" &&
    tireTemperature.binding?.kind === "value" &&
    tireTemperature.binding.semanticId === "tire.temperature.core";
  const separateCoreTemperature = primaryTemperatureIsCore ? undefined : game.telemetry.tireCarcassTemperature;
  const supportsContinuousSurfaceProfile = game.telemetry.tireSurfaceProfile?.freshness === "continuous";
  const wheelRotation = game.telemetry.analysis?.wheelRotation;
  const supportsWheelStateAnalysis = wheelRotation?.source === "direct" && wheelRotation.freshness === "continuous";
  const tirePressure = game.telemetry.analysis?.tirePressure;
  const supportsTirePressureAnalysis = tirePressure?.source === "direct" && tirePressure.freshness === "continuous";
  const slipAngle = game.telemetry.analysis?.slipAngle;
  const physicalSlipAngles = slipAngle?.source === "direct" && slipAngle.binding?.kind === "value" && slipAngle.binding.semanticId === "tires.tire-slip-angle";
  const nativeAidInterventionChannel = gameId === "acc" || gameId === "ac-evo";
  const suspension = game.telemetry.analysis?.suspensionTravel;
  const physicalSuspensionStroke = suspension?.source === "direct" && suspension.freshness === "continuous" &&
    suspension.binding?.kind === "value" && suspension.binding.semanticId === "suspension.norm-suspension-travel";

  const insights: LapInsight[] = [];

  // Share calibrated wheel evidence and one empirical acceleration reference.
  const wheelStates = supportsWheelStateAnalysis ? calibratedWheelStates(telemetry) : undefined;
  const ctx: TimeLossCtx = { dt, ref: buildAccelReference(telemetry, dt, wheelStates), wheelStates };

  // Suspension
  if (physicalSuspensionStroke) {
    insights.push(...detectSuspensionOverload(telemetry));
    const imbalance = detectSuspensionImbalance(telemetry);
    if (imbalance) insights.push(imbalance);
  }

  // Tires
  if (supportsContinuousTireTemperature) {
    insights.push(...detectTireOverheat(telemetry, tireTemperatureUnit));
  }
  if (separateCoreTemperature) {
    insights.push(...detectTireOverheat(telemetry, separateCoreTemperature.packetUnit, "core", "separate-core"));
  }
  if (supportsContinuousSurfaceProfile) {
    insights.push(...detectTireSurfaceProfile(telemetry, tireTemperatureUnit));
  }
  if (wheelStates) {
    insights.push(...detectLockups(wheelStates, dt));
    insights.push(...detectWheelspin(wheelStates, dt));
  }
  const wearImb = detectWearImbalance(telemetry);
  if (wearImb) insights.push(wearImb);
  const tempSplit = separateCoreTemperature
    ? detectTireTempSplit(telemetry, separateCoreTemperature.packetUnit, "core")
    : supportsContinuousTireTemperature
      ? detectTireTempSplit(telemetry, tireTemperatureUnit)
      : null;
  if (tempSplit) insights.push(tempSplit);
  if (supportsTirePressureAnalysis) {
    const pressureLoss = detectRapidPressureLoss(telemetry, tireTemperatureUnit);
    insights.push(...pressureLoss);
    const pressure = detectTirePressureImbalance(telemetry, pressureLoss);
    if (pressure) insights.push(pressure);
  }

  // Driving
  const aidOptions = { nativeChannelAvailable: nativeAidInterventionChannel, wheelRotationAvailable: supportsWheelStateAnalysis, wheelStates };
  const absActivation = detectAbsActivation(telemetry, aidOptions);
  if (absActivation) insights.push(absActivation);
  const tractionControlActivation = detectTractionControlActivation(telemetry, aidOptions);
  if (tractionControlActivation) insights.push(tractionControlActivation);
  if (gameId === "f1-2025") {
    const unusedDrs = detectUnusedDrs(telemetry);
    if (unusedDrs) insights.push(unusedDrs);
    const ersDepletion = detectErsDepletion(telemetry);
    if (ersDepletion) insights.push(ersDepletion);
  }
  if (wheelStates) {
    const brakeLoss = detectBrakeTractionLoss(telemetry, wheelStates);
    if (brakeLoss) insights.push(brakeLoss);
  }
  const rev = detectRevLimiter(telemetry, ctx);
  if (rev) insights.push(rev);
  const coast = detectCoasting(telemetry, ctx);
  if (coast) insights.push(coast);
  const trail = detectTrailBraking(telemetry);
  if (trail) insights.push(trail);
  const counterSteer = detectCounterSteer(telemetry);
  if (counterSteer) insights.push(counterSteer);
  const earlyBrake = detectEarlyBraking(telemetry);
  if (earlyBrake) insights.push(earlyBrake);
  const overSlow = detectOverSlowing(telemetry);
  if (overSlow) insights.push(overSlow);
  if (wheelStates) {
    const throttleLoss = detectThrottleTractionLoss(telemetry, wheelStates);
    if (throttleLoss) insights.push(throttleLoss);
  }
  const earlyThrottle = detectEarlyThrottle(telemetry, wheelStates);
  if (earlyThrottle) insights.push(earlyThrottle);
  const binary = detectBinaryThrottle(telemetry);
  if (binary) insights.push(binary);
  const delayedThrottle = detectDelayedThrottlePickup(telemetry, wheelStates);
  if (delayedThrottle) insights.push(delayedThrottle);

  const brakeDrag = detectBrakeDrag(telemetry);
  if (brakeDrag) insights.push(brakeDrag);
  const downshift = detectDownshiftOverRev(telemetry);
  if (downshift) insights.push(downshift);
  const overshoot = detectLateBrakingOvershoot(telemetry, physicalSlipAngles, context?.racingLine);
  if (overshoot) insights.push(overshoot);
  const scrub = detectUndersteerScrub(telemetry, physicalSlipAngles);
  if (scrub) insights.push(scrub);
  const oversteer = detectOversteerSlide(telemetry, physicalSlipAngles);
  if (oversteer) insights.push(oversteer);
  const sawing = detectSteeringSawing(telemetry);
  if (sawing) insights.push(sawing);
  const microLifts = detectThrottleMicroLifts(telemetry, ctx);
  if (microLifts) insights.push(microLifts);
  const kerbs = detectKerbRiding(telemetry);
  if (kerbs) insights.push(kerbs);

  // Mechanical
  const fuel = detectFuelConsumption(telemetry, game.telemetry.fuel.packetUnit);
  if (fuel) insights.push(fuel);
  const power = detectPeakPower(telemetry);
  if (power) insights.push(power);
  const boost = detectBoostAnomaly(telemetry);
  if (boost) insights.push(boost);

  const indices = sourceIndices;
  if (indices) {
    for (const insight of insights) insight.frameIndices = insight.frameIndices.map((index) => indices[index]);
  }
  return insights;
}
