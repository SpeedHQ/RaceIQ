import { getGame } from "../../../../games/registry";
import type { GameId } from "../../../../games/ids";
import type { TelemetryPacket } from "../../../../telemetry/types";
import { frameDt } from "../frame-time";
import { buildAccelReference } from "../time-loss";
import { allWheelStates } from "../physics/vehicle";
import { detectSuspensionOverload, detectSuspensionImbalance } from "./suspension";
import { detectFuelConsumption, detectPeakPower, detectBoostAnomaly } from "./mechanical";
import { detectTireOverheat, detectLockups, detectWheelspin, detectWearImbalance, detectTireTempSplit, detectTirePressureImbalance } from "./tires";
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
import { detectAbsActivation, detectTractionControlActivation } from "./electronics";
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
import type { LapAnalysisContext, LapInsight, TimeLossCtx } from "./types";

export function analyzeLap(telemetry: TelemetryPacket[], gameId: GameId, context?: LapAnalysisContext): LapInsight[] {
  if (telemetry.length < 10) return [];
  const game = getGame(gameId);
  const tireTemperatureUnit = game.telemetry.tireTemperature.packetUnit;
  const supportsWheelStateAnalysis = game.telemetry.analysis?.wheelRotation?.source !== "unavailable";
  const tirePressure = game.telemetry.analysis?.tirePressure;
  const supportsTirePressureAnalysis = tirePressure?.source === "direct" && tirePressure.freshness === "continuous";
  const slipAngle = game.telemetry.analysis?.slipAngle;
  const physicalSlipAngles = slipAngle?.source === "direct" && slipAngle.binding?.kind === "value" && slipAngle.binding.semanticId === "tires.tire-slip-angle";
  const nativeAidInterventionChannel = gameId === "acc" || gameId === "ac-evo";

  const insights: LapInsight[] = [];

  // Built once: frameDt walks the lap and the acceleration reference bins every
  // clean full-throttle frame, so rebuilding it per detector would be wasteful
  // and — worse — let two detectors disagree about the same counterfactual.
  const dt = frameDt(telemetry);
  const wheelStates = supportsWheelStateAnalysis ? telemetry.map(allWheelStates) : undefined;
  const ctx: TimeLossCtx = { dt, ref: buildAccelReference(telemetry, dt, wheelStates), wheelStates };

  // Suspension
  insights.push(...detectSuspensionOverload(telemetry));
  const imbalance = detectSuspensionImbalance(telemetry);
  if (imbalance) insights.push(imbalance);

  // Tires
  insights.push(...detectTireOverheat(telemetry, tireTemperatureUnit));
  if (wheelStates) {
    insights.push(...detectLockups(wheelStates));
    insights.push(...detectWheelspin(wheelStates));
  }
  const wearImb = detectWearImbalance(telemetry);
  if (wearImb) insights.push(wearImb);
  const tempSplit = detectTireTempSplit(telemetry, tireTemperatureUnit);
  if (tempSplit) insights.push(tempSplit);
  if (supportsTirePressureAnalysis) {
    const pressure = detectTirePressureImbalance(telemetry);
    if (pressure) insights.push(pressure);
  }

  // Driving
  const absActivation = detectAbsActivation(telemetry, nativeAidInterventionChannel);
  if (absActivation) insights.push(absActivation);
  const tractionControlActivation = detectTractionControlActivation(telemetry, nativeAidInterventionChannel);
  if (tractionControlActivation) insights.push(tractionControlActivation);
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
  const earlyBrake = detectEarlyBraking(telemetry, ctx);
  if (earlyBrake) insights.push(earlyBrake);
  const overSlow = detectOverSlowing(telemetry, ctx);
  if (overSlow) insights.push(overSlow);
  if (wheelStates) {
    const throttleLoss = detectThrottleTractionLoss(telemetry, wheelStates);
    if (throttleLoss) insights.push(throttleLoss);
  }
  const earlyThrottle = detectEarlyThrottle(telemetry);
  if (earlyThrottle) insights.push(earlyThrottle);
  const binary = detectBinaryThrottle(telemetry);
  if (binary) insights.push(binary);

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

  return insights;
}
