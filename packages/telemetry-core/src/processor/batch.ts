import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { classifyPitCycleLap, forzaPitTransitionEvidence, PIT_CYCLE_REASONS, type PitCycleReason } from "@raceiq/analysis-core/racing/laps/pit-cycle";
import { OrdinalDetectorEngine } from "./ordinal-engine";
import { KunosDetectorEngine, type KunosLapCapture } from "./kunos-engine";
import { IRacingDetectorEngine } from "./iracing-engine";
import { mergePitCycleReason, assessLapRecording, DEFAULT_LAP_DETECTOR_POLICY, LMU_LAP_DETECTOR_POLICY, type LapDetectorPolicy } from "./lap-policy";
import { classifyKunosTrackLimits, resolveAccRecordedLapValidity } from "./kunos-policy";
import { computeLapSectors, type SectorComputationOptions } from "./sectors";

const asPitCycleReason = (reason: string | null): PitCycleReason | null =>
  reason && (PIT_CYCLE_REASONS as readonly string[]).includes(reason) ? reason as PitCycleReason : null;

export interface TelemetryBatchFrame { data: Buffer; rawByteOffset?: number; timestampMs?: number; frameTimeMs?: number }
export interface TelemetryBatchBootstrap {
  type: "parser-bootstrap";
  gameId: GameId;
  formatVersion: number;
  payload: Uint8Array;
  completeLapStart?: boolean;
}
export type TelemetryBatchInput = TelemetryBatchFrame | TelemetryBatchBootstrap | { type: "segment-context"; completeLapStart?: boolean } | { type: "segment-context-end" } | { type: "segment-boundary" };
export interface TelemetryBatchLap {
  sessionKey: number; lapNumber: number; lapTime: number; packets: readonly TelemetryPacket[];
  sectors: number[] | null; valid: boolean; invalidReason: string | null;
  byteOffset: number | null; frameCount: number; complete: boolean;
}
export interface TelemetryBatchSession {
  sessionKey: number; gameId: GameId; carId: string; trackId: string;
  sessionUID?: string;
}
export interface TelemetryBatchResult {
  sessions: TelemetryBatchSession[];
  laps: TelemetryBatchLap[];
  /** Source lap/session lifecycles, including detector-suppressed partials; excludes parser context and a lone zero-time finish trigger. */
  logicalLapCount: number;
}
export interface TelemetryBatchOptions<State = unknown> {
  parser: Pick<TelemetryParser<State>, "createParserState" | "tryParse" | "restoreParserCheckpoint" | "invalidateDriverEvidence">;
  now?: () => number;
  policies?: Partial<Record<GameId, LapDetectorPolicy>>;
  sectors?: SectorComputationOptions["sectors"];
}

/** Borrow caller-framed buffers and use the same native detector engines as live processing.
 * Context primes only the parser; segment boundaries recreate parser and detector state.
 * Checkpoint payload validation remains game-owned. Bootstrap never counts as telemetry.
 */
export async function processTelemetryBatch<State>(gameId: GameId, frames: readonly TelemetryBatchInput[], options: TelemetryBatchOptions<State>): Promise<TelemetryBatchResult> {
  const result: TelemetryBatchResult = { sessions: [], laps: [], logicalLapCount: 0 };
  let nextSessionKey = 0;
  const yieldToCommands = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    return promise;
  };
  const now = options.now ?? (() => 1);
  const policy = options.policies?.[gameId] ?? (gameId === "lmu" ? LMU_LAP_DETECTOR_POLICY : DEFAULT_LAP_DETECTOR_POLICY);
  const sessionFromPacket = (p: TelemetryPacket): TelemetryBatchSession => {
    const value: TelemetryBatchSession = { sessionKey: ++nextSessionKey, gameId, carId: p.carId, trackId: p.trackId };
    if (p.sessionUID !== undefined) value.sessionUID = p.sessionUID;
    result.sessions.push(value);
    return value;
  };

  const processSegment = async (start: number, end: number, completeLapStart: boolean) => {
    const parser = options.parser;
    let parserState = parser.createParserState();
    let inContext = false;
    let sessionKey = 0;
    const firstResultLap = result.laps.length;
    let observedLogicalLaps = 0;
    let previousPacket: TelemetryPacket | null = null;
    let boundaryTail = false;
    let packetOrder = -1;
    let groupStartOrder = 0;
    let completionOrder = -1;
    let completeLapCount = 0;
    let latestCompleteOrder: number | null = null;
    let latestCompletionTailStart: number | null = null;
    let flushing = false;
    const push = (sessionKey: number, lapNumber: number, lapTime: number, lapPackets: readonly TelemetryPacket[], valid: boolean, reason: string | null, byteOffset: number | null, frameCount: number, complete: boolean) => {
      const sectors = complete ? computeLapSectors(lapPackets.at(-1)?.trackId ?? "", gameId, lapPackets as TelemetryPacket[], lapTime, options.sectors ? { sectors: options.sectors } : {}) : null;
      result.laps.push({ sessionKey, lapNumber, lapTime, packets: lapPackets, sectors, valid: valid && !reason, invalidReason: reason, byteOffset, frameCount, complete });
      if (complete) {
        completeLapCount++;
        latestCompleteOrder = completionOrder;
        latestCompletionTailStart = previousPacket && previousPacket.LapNumber !== lapNumber ? groupStartOrder : null;
      }
    };
    let ordinal!: OrdinalDetectorEngine;
    const kunos = gameId === "acc" || gameId === "ac-evo" ? new KunosDetectorEngine({
      createSession: async p => { sessionKey = sessionFromPacket(p).sessionKey; },
      backfillSessionIdentifiers: p => {
        const session = result.sessions.at(-1);
        if (!session) return;
        if (!session.carId && p.carId) session.carId = p.carId;
        if (!session.trackId && p.trackId) session.trackId = p.trackId;
      },
      isPitOnly: packets => classifyPitCycleLap(packets) === "pit lap",
      emitLap: async (capture: KunosLapCapture) => {
        const quality = assessLapRecording(capture.packets, capture.lapTime);
        const pitReason = classifyPitCycleLap(capture.packets);
        const recordedValidity = gameId === "acc" ? resolveAccRecordedLapValidity(capture.packets, capture.trigger !== undefined) : null;
        const classification = gameId === "ac-evo" && quality.valid && !pitReason ? classifyKunosTrackLimits(capture.packets) : null;
        const valid = capture.silent ? false : recordedValidity !== null ? recordedValidity : quality.valid && !pitReason && !classification;
        const reason = capture.silent ? "incomplete at end of input" : recordedValidity === false ? "game reported invalid" : recordedValidity === true ? null : pitReason ?? quality.reason ?? classification;
        push(sessionKey, capture.lapNumber, capture.lapTime, capture.packets, valid, reason, capture.byteOffset, capture.byteOffset === null ? 0 : capture.frameCount, !capture.silent);
      },
    }) : null;
    if (!kunos) ordinal = new OrdinalDetectorEngine({
      now,
      createSession: async p => {
        sessionKey = sessionFromPacket(p).sessionKey;
        return {
          carId: p.carId, trackId: p.trackId, gameId,
          ...(p.sessionUID === undefined ? {} : { sessionUID: p.sessionUID }),
        };
      },
      finalizeLap: async (packet, s) => {
        const time = policy.resolveLapTime(s.lapBuffer, packet);
        if (time < 10) return false;
        ordinal.trimRunningStartPackets();
        const pitReason = mergePitCycleReason(asPitCycleReason(s.currentPitCycleReason), asPitCycleReason(policy.classifyPitCycle(s.lapBuffer, s.completedLapCount)));
        const hostInvalidReason = asPitCycleReason(s.invalidReason);
        const mergedPitReason = mergePitCycleReason(hostInvalidReason, pitReason);
        const q = assessLapRecording(s.lapBuffer, time);
        const policyReason = policy.invalidReason?.(s.lapBuffer) ?? null;
        const reason = hostInvalidReason ? mergedPitReason ?? hostInvalidReason : s.invalidReason ?? policyReason ?? pitReason ?? (!q.valid ? q.reason : null);
        push(sessionKey, s.lapNumber, time, s.lapBuffer, s.lapIsValid && !policyReason && !pitReason && q.valid, reason, s.lapByteOffset, s.lapByteOffset === null ? 0 : s.lapFrameCount, true);
        return true;
      },
      finalizeIncompleteLap: async s => {
        const last = s.lapBuffer.at(-1);
        if (!last || last.CurrentLap < 10) return;
        push(sessionKey, s.lapNumber, last.CurrentLap, s.lapBuffer, false, s.invalidReason ?? "incomplete at end of input", s.lapByteOffset, s.lapByteOffset === null ? 0 : s.lapFrameCount, false);
      },
      finalizeStaleLap: async (time, complete, _silence, s) => {
        if (time < 10) return;
        if (complete) ordinal.trimRunningStartPackets();
        push(sessionKey, s.lapNumber, time, s.lapBuffer, s.lapIsValid, s.invalidReason ?? (complete ? null : "incomplete at end of input"), s.lapByteOffset, s.lapByteOffset === null ? 0 : s.lapFrameCount, complete);
      },
      pitTransition: (before, after, raceOffObserved) => forzaPitTransitionEvidence(before, after, raceOffObserved).detected,
      finalizeSession: async () => {},
    }, { bypassPacketRateFilter: true });
    const iracing = gameId === "iracing" ? new IRacingDetectorEngine({
      now,
      feed: async (packet, offset, order) => {
        // A native timing roll completes at the current source frame. EOF fallback
        // completes at the deferred boundary, not at later incomplete telemetry.
        completionOrder = flushing ? order ?? packetOrder : packetOrder;
        await ordinal.feed(packet, offset);
      },
      flushStaleLap: async () => {},
      finalizeCurrentSession: async () => { await ordinal.flushIncompleteLap(); await ordinal.finalizeCurrentSession(); },
    }) : null;
    if (completeLapStart) iracing?.expectCompleteLapStart();
    for (let index = start; index < end; index++) {
      if ((index - start) % 256 === 255) await yieldToCommands();
      const input = frames[index]!;
      if ("type" in input) {
        if (input.type === "segment-context") {
          inContext = true;
        } else if (input.type === "parser-bootstrap") {
          if (input.gameId !== gameId || input.formatVersion !== 1) throw new Error(`Parser bootstrap does not match game/version for ${gameId}`);
          if (!parser.restoreParserCheckpoint) throw new Error(`Parser checkpoint restore unavailable for ${gameId}`);
          parserState = parser.restoreParserCheckpoint(parserState, input.payload);
          parser.invalidateDriverEvidence?.(parserState);
          inContext = false;
        } else inContext = false;
        continue;
      }
      const packet = parser.tryParse(input.data, parserState, input.timestampMs);
      if (inContext || !packet) continue;
      packetOrder++;
      completionOrder = packetOrder;
      if (previousPacket) {
        const changedSession = previousPacket.sessionUID !== packet.sessionUID || previousPacket.carId !== packet.carId || previousPacket.trackId !== packet.trackId;
        if (changedSession || previousPacket.LapNumber !== packet.LapNumber) {
          const endedAtCompletion = latestCompletionTailStart === groupStartOrder && latestCompleteOrder === packetOrder - 1;
          if (!boundaryTail && !endedAtCompletion) observedLogicalLaps++;
          groupStartOrder = packetOrder;
          boundaryTail = !changedSession && packet.CurrentLap === 0;
        } else {
          // Any additional native observation after a finish trigger belongs to
          // the next logical lap, even below the detector persistence threshold.
          boundaryTail = false;
        }
      }
      previousPacket = packet;
      if (input.frameTimeMs !== undefined) {
        (packet.extendedRaceIQ ??= {}).frameTimeMs = input.frameTimeMs;
        if (gameId === "acc" || gameId === "ac-evo") packet.TimestampMS = input.frameTimeMs;
      }
      if (kunos) {
        const startingSession = !kunos.isActive;
        await kunos.feed(packet, input.rawByteOffset);
        if (startingSession && input.rawByteOffset !== undefined) kunos.setCurrentLapByteOffset(input.rawByteOffset);
        kunos.drainOwnershipTransitions();
      } else if (iracing) await iracing.feed(packet, input.rawByteOffset, packetOrder);
      else await ordinal.feed(packet, input.rawByteOffset);
    }
    flushing = true;
    if (kunos) { await kunos.flushIncompleteLap(); await kunos.finalize(); }
    else if (iracing) { await iracing.flushIncompleteLap(); await iracing.finalizeCurrentSession(); }
    else { await ordinal.flushIncompleteLap(); await ordinal.finalizeCurrentSession(); }
    const endsAtCompletion = latestCompletionTailStart === groupStartOrder && latestCompleteOrder === packetOrder;
    if (previousPacket && !boundaryTail && !endsAtCompletion) observedLogicalLaps++;
    const hasPostCompletionTelemetry = latestCompleteOrder !== null && latestCompleteOrder < packetOrder;
    result.logicalLapCount += Math.max(
      observedLogicalLaps,
      result.laps.length - firstResultLap,
      hasPostCompletionTelemetry ? completeLapCount + 1 : 0,
    );
  };
  let start = 0;
  let completeLapStart = false;
  for (let index = 0; index < frames.length; index++) {
    if (index % 2048 === 2047) await yieldToCommands();
    const input = frames[index]!;
    if ("type" in input && input.type === "segment-boundary") {
      await processSegment(start, index, completeLapStart);
      start = index + 1;
      completeLapStart = false;
    }
    if ("type" in input && (input.type === "segment-context" || input.type === "parser-bootstrap")) completeLapStart ||= input.completeLapStart === true;
  }
  await processSegment(start, frames.length, completeLapStart);
  return result;
}
