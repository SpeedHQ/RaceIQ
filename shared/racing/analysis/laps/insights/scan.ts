import { getGame } from '../../../../games/registry';
import type { GameId } from '../../../../games/ids';
import type { TelemetryPacket } from '../../../../telemetry/types';
import { createWheelCalibration, type AllWheelStates } from '../physics/vehicle';
import { createAccelReferenceCollector, type AccelReference } from '../time-loss';
import { createBufferedScan } from './buffered-detectors';
import { createTireScan } from './tires';
import { createElectronicScan } from './electronics';
import { createCoreDrivingScan } from './driving-core';
import { createAdvancedDrivingScan } from './driving-advanced';
import { createMechanicalScan } from './mechanical';
import type { LapAnalysisContext, LapInsight, OrderedInsight, TimeLossCtx } from './types';

export interface InsightAccumulator {
  observe(index: number, seconds: number, previousSeconds: number, wheelState?: AllWheelStates): void;
  finish(ref?: AccelReference): OrderedInsight[];
}

/** Standalone exports select only their own detector family. */
export function runSelectedInsightScan(
  telemetry: readonly TelemetryPacket[],
  state: InsightAccumulator,
  options?: { durations?: readonly number[]; wheelStates?: readonly AllWheelStates[]; ref?: AccelReference },
): OrderedInsight[] {
  const dt = options?.durations;
  const states = options?.wheelStates;
  let previous = 0;
  for (let i = 0; i < telemetry.length; i++) {
    const delta = i + 1 < telemetry.length ? (telemetry[i + 1].TimestampMS - telemetry[i].TimestampMS) / 1000 : 0;
    const seconds = dt ? (dt[i] ?? 0) : Number.isFinite(delta) && delta > 0 && delta <= 0.1 ? delta : 0;
    state.observe(i, seconds, dt ? (dt[i - 1] ?? 0) : previous, states?.[i]);
    previous = seconds;
  }
  return state.finish(options?.ref);
}

/** Collect each static detector's evidence while advancing the lap only once. */
export function runInsightScan(telemetry: TelemetryPacket[], gameId: GameId, context?: LapAnalysisContext): LapInsight[] {
  const game = getGame(gameId);
  const tireTemperatureUnit = game.telemetry.tireTemperature.packetUnit;
  const tireTemperature = game.telemetry.analysis?.tireTemperature;
  const primaryTemperature = tireTemperature?.source === 'direct' && tireTemperature.freshness === 'continuous';
  const primaryCore = tireTemperature?.source === 'direct' && tireTemperature.binding?.kind === 'value' && tireTemperature.binding.semanticId === 'tire.temperature.core';
  const separateCoreTemperature = primaryCore ? undefined : game.telemetry.tireCarcassTemperature;
  const surfaceProfile = game.telemetry.tireSurfaceProfile?.freshness === 'continuous';
  const wheelRotation = game.telemetry.analysis?.wheelRotation;
  const wheelEnabled = wheelRotation?.source === 'direct' && wheelRotation.freshness === 'continuous';
  const tirePressure = game.telemetry.analysis?.tirePressure;
  const pressureEnabled = tirePressure?.source === 'direct' && tirePressure.freshness === 'continuous';
  const slipAngle = game.telemetry.analysis?.slipAngle;
  const physicalSlipAngles = slipAngle?.source === 'direct' && slipAngle.binding?.kind === 'value' && slipAngle.binding.semanticId === 'tires.tire-slip-angle';
  const suspension = game.telemetry.analysis?.suspensionTravel;
  const physicalSuspensionStroke = suspension?.source === 'direct' && suspension.freshness === 'continuous' && suspension.binding?.kind === 'value' && suspension.binding.semanticId === 'suspension.norm-suspension-travel';

  const dt = new Array<number>(telemetry.length);
  const states = wheelEnabled ? new Array<AllWheelStates>(telemetry.length) : undefined;
  const ctx: TimeLossCtx = { dt, ref: { bins: [] }, wheelStates: states };
  const buffered = createBufferedScan(telemetry, physicalSuspensionStroke, wheelEnabled);
  const tires = createTireScan(telemetry, tireTemperatureUnit, {
    primaryTemperature, primaryTemperatureUnit: tireTemperatureUnit,
    separateCoreTemperature: separateCoreTemperature ? { packetUnit: separateCoreTemperature.packetUnit } : undefined,
    surfaceProfile: !!surfaceProfile, temperatureSplit: !!separateCoreTemperature || primaryTemperature, pressureAnalysis: !!pressureEnabled,
  });
  const aidOptions = { nativeChannelAvailable: gameId === 'acc' || gameId === 'ac-evo', wheelRotationAvailable: wheelEnabled, wheelStates: states };
  const electronic = createElectronicScan(telemetry, { abs: aidOptions, tractionControl: aidOptions, f1Enabled: gameId === 'f1-2025' });
  const core = createCoreDrivingScan(telemetry, ctx, states);
  const advanced = createAdvancedDrivingScan(telemetry, { ctx, physicalSlipAngles, racingLine: context?.racingLine });
  const mechanical = createMechanicalScan(telemetry, { packetUnit: game.telemetry.fuel.packetUnit });
  const detectors: InsightAccumulator[] = [buffered, tires, electronic, core, advanced, mechanical];
  const calibration = createWheelCalibration();
  const acceleration = createAccelReferenceCollector();
  let usableSeconds = 0;
  let previousSeconds = 0;
  for (let i = 0; i < telemetry.length; i++) {
    const packet = telemetry[i];
    const next = telemetry[i + 1];
    const delta = next ? (next.TimestampMS - packet.TimestampMS) / 1000 : 0;
    const seconds = Number.isFinite(delta) && delta > 0 && delta <= 0.1 ? delta : 0;
    dt[i] = seconds;
    usableSeconds += seconds;
    const state = calibration.observe(packet, telemetry[i - 1], seconds, previousSeconds, i);
    if (states) states[i] = state;
    acceleration.observe(packet, next, seconds, state);
    const wheel = wheelEnabled ? state : undefined;
    for (const detector of detectors) detector.observe(i, seconds, previousSeconds, wheel);
    previousSeconds = seconds;
  }
  if (usableSeconds + 1e-9 < 1 / 6) return [];
  ctx.ref = acceleration.finish();
  const ranked: OrderedInsight[] = [];
  for (const detector of detectors) ranked.push(...detector.finish(ctx.ref));
  ranked.sort((a, b) => a.order - b.order);
  return ranked.map(({ insight }) => insight);
}
