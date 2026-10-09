import type { SectorComputationOptions } from "@raceiq/telemetry-core/processor/sectors";
import { computeLapSectors } from "@raceiq/telemetry-core/processor/sectors";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { OrdinalDetectorEngine } from "@raceiq/telemetry-core/processor/ordinal-engine";
import { KunosDetectorEngine, type KunosLapCapture } from "@raceiq/telemetry-core/processor/kunos-engine";
import { IRacingDetectorEngine } from "@raceiq/telemetry-core/processor/iracing-engine";
import { mergePitCycleReason, assessLapRecording, DEFAULT_LAP_DETECTOR_POLICY, LMU_LAP_DETECTOR_POLICY, type LapDetectorPolicy } from "@raceiq/telemetry-core/processor/lap-policy";
import { classifyKunosTrackLimits, resolveAccRecordedLapValidity } from "@raceiq/telemetry-core/processor/kunos-policy";
import { classifyPitCycleLap, forzaPitTransitionEvidence, PIT_CYCLE_REASONS, type PitCycleReason } from "@raceiq/analysis-core/racing/laps/pit-cycle";
import { getGameParser } from "./routing";
const asPitCycleReason = (reason: string | null): PitCycleReason | null =>
  reason && (PIT_CYCLE_REASONS as readonly string[]).includes(reason) ? reason as PitCycleReason : null;

export type TelemetryBatchInput = TelemetryBatchFrame | { type: "segment-context"; completeLapStart?: boolean } | { type: "segment-context-end" } | { type: "segment-boundary" };
export interface TelemetryBatchFrame { data: Buffer; rawByteOffset?: number; timestampMs?: number; frameTimeMs?: number }
export interface TelemetryBatchLap {
  sessionKey: number; lapNumber: number; lapTime: number; packets: readonly TelemetryPacket[];
  sectors: number[] | null; valid: boolean; invalidReason: string | null;
  byteOffset: number | null; frameCount: number; complete: boolean;
}
export interface TelemetryBatchSession {
  sessionKey: number; gameId: GameId; carOrdinal: number; trackOrdinal: number;
  sessionUID?: string; carId?: string; trackId?: string;
}
export interface TelemetryBatchResult { sessions: TelemetryBatchSession[]; laps: TelemetryBatchLap[] }
export interface TelemetryBatchOptions {
  now?: () => number; policies?: Partial<Record<GameId, LapDetectorPolicy>>;
  sectors?: SectorComputationOptions["sectors"];
}

/** Process caller-framed complete capture in memory. Input Buffers are borrowed, never copied. */
/** Context records prime parser state only. Segment boundaries finalize current detector lifecycle and recreate parser state. */
export async function processTelemetryBatch(gameId: GameId, frames: readonly TelemetryBatchInput[], options: TelemetryBatchOptions = {}): Promise<TelemetryBatchResult> {
  if (frames.some(input => "type" in input && input.type === "segment-boundary")) {
    const combined: TelemetryBatchResult = { sessions: [], laps: [] };
    let segment: TelemetryBatchInput[] = [];
    let nextSessionKey = 0;
    for (const input of [...frames, { type: "segment-boundary" as const }]) {
      if ("type" in input && input.type === "segment-boundary") {
        const part = await processTelemetryBatch(gameId, segment, options);
        const remap = new Map<number, number>();
        for (const session of part.sessions) {
          const key = ++nextSessionKey;
          remap.set(session.sessionKey, key);
          combined.sessions.push({ ...session, sessionKey: key });
        }
        for (const lap of part.laps) combined.laps.push({ ...lap, sessionKey: remap.get(lap.sessionKey) ?? lap.sessionKey });
        segment = [];
      } else segment.push(input);
    }
    return combined;
  }
  const parser = getGameParser(gameId), parserState = parser.createParserState();
  const parsed: { packet: TelemetryPacket; offset?: number }[] = [];
  let inContext = false;
  let completeLapStart = false;
  for (const input of frames) {
    if ("type" in input) {
      if (input.type === "segment-context") { inContext = true; completeLapStart ||= input.completeLapStart === true; }
      else if (input.type === "segment-context-end") inContext = false;
      else { inContext = false; }
      continue;
    }
    const packet = parser.tryParse(input.data, parserState, input.timestampMs);
    if (inContext) continue;
    if (packet) {
      if (input.frameTimeMs !== undefined) (packet.extendedRaceIQ ??= {}).frameTimeMs = input.frameTimeMs;
      if (input.frameTimeMs !== undefined && (gameId === "acc" || gameId === "ac-evo")) packet.TimestampMS = input.frameTimeMs;
      parsed.push({ packet, ...(input.rawByteOffset === undefined ? {} : { offset: input.rawByteOffset }) });
    }
  }
  const result: TelemetryBatchResult = { sessions: [], laps: [] };
  let nextSessionKey = 0;
  const now = options.now ?? (() => 1);
  const policy = options.policies?.[gameId] ?? (gameId === "lmu" ? LMU_LAP_DETECTOR_POLICY : DEFAULT_LAP_DETECTOR_POLICY);
  const sessionFromPacket = (p: TelemetryPacket): TelemetryBatchSession => {
    const value: TelemetryBatchSession = { sessionKey: ++nextSessionKey, gameId, carOrdinal: p.CarOrdinal, trackOrdinal: p.TrackOrdinal };
    if (p.sessionUID !== undefined) value.sessionUID = p.sessionUID;
    if (p.lmu?.carId !== undefined) value.carId = p.lmu.carId;
    if (p.lmu?.trackId !== undefined) value.trackId = p.lmu.trackId;
    return value;
  };
  const push = (sessionKey: number, lapNumber: number, lapTime: number, lapPackets: readonly TelemetryPacket[], valid: boolean, reason: string | null, byteOffset: number | null, frameCount: number, complete: boolean) => {
    const sectors = complete ? computeLapSectors(lapPackets.at(-1)?.TrackOrdinal ?? 0, gameId, lapPackets as TelemetryPacket[], lapTime, options.sectors ? { sectors: options.sectors } : {}) : null;
    result.laps.push({ sessionKey, lapNumber, lapTime, packets: lapPackets, sectors, valid: valid && !reason, invalidReason: reason, byteOffset, frameCount, complete });
  };
  const offsets = new Map<TelemetryPacket, number>();
  const packets = parsed.map(({ packet, offset }) => { if (offset !== undefined) offsets.set(packet, offset); return packet; });
  if (gameId === "acc" || gameId === "ac-evo") {
    let sessionKey = 0;
    const engine = new KunosDetectorEngine({
      createSession: async p => { const session = sessionFromPacket(p); sessionKey = session.sessionKey; result.sessions.push(session); },
      backfillSessionIdentifiers: () => {}, isPitOnly: packets => classifyPitCycleLap(packets) === "pit lap",
      emitLap: async (capture: KunosLapCapture) => {
        const quality = assessLapRecording(capture.packets, capture.lapTime);
        const pitReason = classifyPitCycleLap(capture.packets);
        const recordedValidity = gameId === "acc" ? resolveAccRecordedLapValidity(capture.packets, capture.trigger !== undefined) : null;
        const classification = gameId === "ac-evo" && quality.valid && !pitReason ? classifyKunosTrackLimits(capture.packets) : null;
        const valid = capture.silent ? false : recordedValidity !== null ? recordedValidity : quality.valid && !pitReason && !classification;
        const reason = capture.silent ? "incomplete at end of input" : recordedValidity === false ? "game reported invalid" : recordedValidity === true ? null : pitReason ?? quality.reason ?? classification;
        push(capture.processorSessionKey || sessionKey, capture.lapNumber, capture.lapTime, capture.packets, valid, reason, capture.byteOffset, capture.byteOffset === null ? 0 : capture.frameCount, !capture.silent);
      },
    });
    for (const p of packets) {
      const offset = offsets.get(p), startingSession = !engine.isActive;
      await engine.feed(p, offset);
      if (startingSession && offset !== undefined) engine.setCurrentLapByteOffset(offset);
    }
    await engine.flushIncompleteLap(); await engine.finalize();
    return result;
  }
  let engine!: OrdinalDetectorEngine;
  engine = new OrdinalDetectorEngine({
    now,
    createSession: async p => {
      const session = sessionFromPacket(p); result.sessions.push(session);
      return {
        carOrdinal: p.CarOrdinal, trackOrdinal: p.TrackOrdinal, gameId,
        ...(p.sessionUID === undefined ? {} : { sessionUID: p.sessionUID }),
        ...(p.lmu?.carId === undefined ? {} : { carId: p.lmu.carId }),
        ...(p.lmu?.trackId === undefined ? {} : { trackId: p.lmu.trackId }),
      };
    },
    finalizeLap: async (packet, s) => {
      const time = policy.resolveLapTime(s.lapBuffer, packet);
      if (time < 10) return false;
      engine.trimRunningStartPackets();
      const pitReason = mergePitCycleReason(asPitCycleReason(s.currentPitCycleReason), asPitCycleReason(policy.classifyPitCycle(s.lapBuffer, s.completedLapCount)));
      const hostInvalidReason = asPitCycleReason(s.invalidReason);
      const mergedPitReason = mergePitCycleReason(hostInvalidReason, pitReason);
      const q = assessLapRecording(s.lapBuffer, time);
      const policyReason = policy.invalidReason?.(s.lapBuffer) ?? null;
      const reason = hostInvalidReason ? mergedPitReason ?? hostInvalidReason : s.invalidReason ?? policyReason ?? pitReason ?? (!q.valid ? q.reason : null);
      push(s.session!.sessionKey, s.lapNumber, time, s.lapBuffer, s.lapIsValid && !policyReason && !pitReason && q.valid, reason, s.lapByteOffset, s.lapByteOffset === null ? 0 : s.lapFrameCount, true);
      return true;
    },
    finalizeIncompleteLap: async s => {
      const last = s.lapBuffer.at(-1);
      if (!last || last.CurrentLap < 10) return;
      push(s.session!.sessionKey, s.lapNumber, last.CurrentLap, s.lapBuffer, false, s.invalidReason ?? "incomplete at end of input", s.lapByteOffset, s.lapByteOffset === null ? 0 : s.lapFrameCount, false);
    },
    finalizeStaleLap: async (time, complete, _silence, s) => {
      if (time < 10) return;
      if (complete) engine.trimRunningStartPackets();
      push(s.session!.sessionKey, s.lapNumber, time, s.lapBuffer, s.lapIsValid, s.invalidReason ?? (complete ? null : "incomplete at end of input"), s.lapByteOffset, s.lapByteOffset === null ? 0 : s.lapFrameCount, complete);
    },
    pitTransition: (before, after, raceOffObserved) => forzaPitTransitionEvidence(before, after, raceOffObserved).detected,
    finalizeSession: async () => {},
  }, { bypassPacketRateFilter: true });
  const feed = gameId === "iracing" ? new IRacingDetectorEngine({ now, feed: async (p, o) => engine.feed(p, o), flushStaleLap: async () => {}, finalizeCurrentSession: async () => { await engine.flushIncompleteLap(); await engine.finalizeCurrentSession(); } }) : null;
  if (feed && completeLapStart) feed.expectCompleteLapStart();
  for (const p of packets) { const offset = offsets.get(p); if (feed) await feed.feed(p, offset); else await engine.feed(p, offset); }
  if (feed) { await feed.flushIncompleteLap(); await feed.finalizeCurrentSession(); }
  else { await engine.flushIncompleteLap(); await engine.finalizeCurrentSession(); }
  return result;
}
