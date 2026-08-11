import { getGame } from "../../../../games/registry";
import type { GameId } from "../../../../games/ids";
import type { TelemetryPacket } from "../../../../telemetry/types";
import { frameDt } from "../frame-time";
import { buildAccelReference } from "../time-loss";
import { detectSuspensionOverload, detectSuspensionImbalance } from "./suspension";
import { detectFuelConsumption, detectPeakPower, detectBoostAnomaly } from "./mechanical";
import { detectTireOverheat, detectLockups, detectWheelspin, detectWearImbalance, detectTireTempSplit, detectInnerOuterTempSpread } from "./tires";
import { detectBrakeTractionLoss, detectRevLimiter, detectCoasting, detectTrailBraking, detectCounterSteer, detectEarlyBraking, detectOverSlowing, detectThrottleTractionLoss, detectEarlyThrottle, detectBinaryThrottle } from "./driving-core";
import { detectBrakeDrag, detectDownshiftOverRev, detectLateBrakingOvershoot, detectUndersteerScrub, detectSteeringSawing, detectThrottleMicroLifts, detectKerbRiding } from "./driving-advanced";
import type { LapInsight, TimeLossCtx } from "./types";


export function analyzeLap(telemetry: TelemetryPacket[], gameId: GameId): LapInsight[] {
  if (telemetry.length < 10) return [];
  const game = getGame(gameId);
  const tireTemperatureUnit = game.telemetry.tireTemperature.packetUnit;
  const supportsWheelStateAnalysis = game.telemetry.analysis?.wheelRotation?.source !== "unavailable";

  const insights: LapInsight[] = [];

  // Built once: frameDt walks the lap and the acceleration reference bins every
  // clean full-throttle frame, so rebuilding it per detector would be wasteful
  // and — worse — let two detectors disagree about the same counterfactual.
  const dt = frameDt(telemetry);
  const ctx: TimeLossCtx = { dt, ref: buildAccelReference(telemetry, dt) };

  // Suspension
  insights.push(...detectSuspensionOverload(telemetry));
  const imbalance = detectSuspensionImbalance(telemetry);
  if (imbalance) insights.push(imbalance);

  // Tires
  insights.push(...detectTireOverheat(telemetry, tireTemperatureUnit));
  if (supportsWheelStateAnalysis) insights.push(...detectLockups(telemetry));
  insights.push(...detectWheelspin(telemetry));
  const wearImb = detectWearImbalance(telemetry);
  if (wearImb) insights.push(wearImb);
  const tempSplit = detectTireTempSplit(telemetry, tireTemperatureUnit);
  if (tempSplit) insights.push(tempSplit);
  insights.push(...detectInnerOuterTempSpread(telemetry));

  // Driving
  if (supportsWheelStateAnalysis) {
    const brakeLoss = detectBrakeTractionLoss(telemetry);
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
  const throttleLoss = detectThrottleTractionLoss(telemetry);
  if (throttleLoss) insights.push(throttleLoss);
  const earlyThrottle = detectEarlyThrottle(telemetry);
  if (earlyThrottle) insights.push(earlyThrottle);
  const binary = detectBinaryThrottle(telemetry);
  if (binary) insights.push(binary);

  const brakeDrag = detectBrakeDrag(telemetry);
  if (brakeDrag) insights.push(brakeDrag);
  const downshift = detectDownshiftOverRev(telemetry);
  if (downshift) insights.push(downshift);
  const overshoot = detectLateBrakingOvershoot(telemetry);
  if (overshoot) insights.push(overshoot);
  const scrub = detectUndersteerScrub(telemetry);
  if (scrub) insights.push(scrub);
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
