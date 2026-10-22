import { createHash, type Hash } from "node:crypto";
import type { GameId, LapWindow, LiveParserPlan, LiveParserReplayEvidence, StreamingMemberStage } from "@raceiq/capture-splitting";
import type { SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { captureAcEvoParserCheckpoint, createAcEvoParserCache, restoreAcEvoParserCheckpoint, type AcEvoParserCache } from "@raceiq/game-ac-evo/parser";
import { accParser } from "@raceiq/game-acc/game-parser";
import { F1StateAccumulator } from "@raceiq/game-f1-2025/f1-state";
import { f1Parser } from "@raceiq/game-f1-2025/game-parser";
import { forzaParser } from "@raceiq/game-fm-2023/game-parser";
import { captureIRacingParserCheckpoint, createIRacingParserState, restoreIRacingParserCheckpoint, type IRacingParserState } from "@raceiq/game-iracing/normalizer";
import { iracingParser } from "@raceiq/game-iracing/game-parser";
import { lmuParser } from "@raceiq/game-lmu/game-parser";

import { acEvoParser } from "@raceiq/game-ac-evo/game-parser";
export interface LiveGameParserCodec {
  createState(): unknown;
  captureState(state: unknown): Uint8Array;
  restoreState(payload: Uint8Array): unknown;
  parseFrame(frame: Buffer, state: unknown, timestampMs?: number): TelemetryPacket | null;
}

function frameLocalCodec(
  parseFrame: (frame: Buffer, timestampMs?: number) => TelemetryPacket | null,
): LiveGameParserCodec {
  return {
    createState: () => null,
    captureState: () => new Uint8Array(),
    restoreState(payload) {
      if (payload.byteLength !== 0) throw new Error("Unexpected checkpoint for frame-local game parser");
      return null;
    },
    parseFrame(frame, _state, timestampMs) {
      return parseFrame(frame, timestampMs);
    },
  };
}


/** Ordered digest over parser output, null emissions, and timestamp presence/value. */
export class ParserTelemetryDigest {
  private hash: Hash = createHash("sha256");
  sourceFrameCount = 0;
  parsedFrameCount = 0;
  nullFrameCount = 0;

  add(packet: TelemetryPacket | null, timestampMs?: number): void {
    this.sourceFrameCount++;
    if (packet) this.parsedFrameCount++;
    else this.nullFrameCount++;
    // Both sides execute the same adapter and exact pre-frame state. Native JSON encoding
    // retains every output field without recursively sorting and rebuilding each packet.
    this.hash.update(JSON.stringify([timestampMs !== undefined, timestampMs ?? 0, packet]));
    this.hash.update("\n");
  }

  snapshot(): LiveParserReplayEvidence {
    return {
      sourceFrameCount: this.sourceFrameCount,
      parsedFrameCount: this.parsedFrameCount,
      nullFrameCount: this.nullFrameCount,
      orderedTelemetryDigest: this.hash.copy().digest("hex"),
    };
  }
}

/** Independently replay owned source frames from its exact pre-frame checkpoint. */
export async function replayLiveParserStage(
  gameId: GameId,
  stage: Pick<StreamingMemberStage, "readRecords">,
  lap: LapWindow,
  codec: LiveGameParserCodec,
  expected: LiveParserReplayEvidence,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const freshState = codec.createState();
  const freshCheckpoint = codec.captureState(freshState);
  if (freshCheckpoint.byteLength > 0 && !lap.parserCheckpoint?.byteLength) {
    throw new Error(`Missing parser initialization in staged lap ${lap.lapId}`);
  }
  let state = lap.parserCheckpoint ? codec.restoreState(lap.parserCheckpoint) : freshState;
  const digest = new ParserTelemetryDigest();
  let ownedFrames = 0;
  let sawBootstrap = false;
  for await (const record of stage.readRecords(signal)) {
    signal?.throwIfAborted();
    if (record.kind === "parser-bootstrap") {
      if (ownedFrames !== 0 || sawBootstrap || record.gameId !== gameId) {
        throw new Error(`Unexpected parser bootstrap in staged lap ${lap.lapId}`);
      }
      if (lap.parserCheckpoint && !Buffer.from(record.payload).equals(Buffer.from(lap.parserCheckpoint))) {
        throw new Error(`Staged parser bootstrap mismatch in lap ${lap.lapId}`);
      }
      state = codec.restoreState(record.payload);
      sawBootstrap = true;
    } else if (record.kind === "segment-boundary") {
      throw new Error(`Staged lap ${lap.lapId} crosses a segment boundary`);
    } else if (record.kind === "frame") {
      const packet = codec.parseFrame(record.frame, state, record.frameTimeMs);
      if (ownedFrames < lap.frameCount) digest.add(packet, record.frameTimeMs);
      ownedFrames++;
    }
  }
  if (lap.parserCheckpoint?.byteLength && !sawBootstrap) throw new Error(`Missing parser bootstrap in staged lap ${lap.lapId}`);
  if (ownedFrames < lap.frameCount || ownedFrames > lap.frameCount + (lap.trailingContextFrameCount ?? 0)) {
    throw new Error(`Staged frame count mismatch in lap ${lap.lapId}`);
  }
  const actual = digest.snapshot();
  if (!expected.orderedTelemetryDigest || actual.sourceFrameCount !== expected.sourceFrameCount ||
      actual.parsedFrameCount !== expected.parsedFrameCount || actual.nullFrameCount !== expected.nullFrameCount ||
      actual.orderedTelemetryDigest !== expected.orderedTelemetryDigest) {
    throw new Error(`Independent parser replay mismatch in lap ${lap.lapId}`);
  }
}

/** Pure production parser/checkpoint operations. Never imports adapter registries or DB. */
export function createLiveGameParserCodec(gameId: GameId): LiveGameParserCodec {
  switch (gameId) {
    case "f1-2025":
      return {
        createState: () => new F1StateAccumulator(),
        captureState(state) {
          if (!(state instanceof F1StateAccumulator)) throw new Error("Missing F1 parser state for live checkpoint");
          return state.captureCheckpoint();
        },
        restoreState(payload) {
          const state = new F1StateAccumulator();
          state.restoreCheckpoint(payload);
          return state;
        },
        parseFrame(frame, state, timestampMs) {
          if (!(state instanceof F1StateAccumulator)) throw new Error("Missing F1 parser state for live replay");
          return f1Parser.tryParse(frame, state, timestampMs);
        },
      };
    case "ac-evo":
      return {
        createState: createAcEvoParserCache,
        captureState(state) { return captureAcEvoParserCheckpoint(state as AcEvoParserCache); },
        restoreState: restoreAcEvoParserCheckpoint,
        parseFrame(frame, state, timestampMs) {
          return acEvoParser.tryParse(frame, state as AcEvoParserCache, timestampMs);
        },
      };
    case "iracing":
      return {
        createState: createIRacingParserState,
        captureState(state) { return captureIRacingParserCheckpoint(state as IRacingParserState); },
        restoreState: restoreIRacingParserCheckpoint,
        parseFrame(frame, state, timestampMs) {
          return iracingParser.tryParse(frame, state as IRacingParserState, timestampMs);
        },
      };
    case "acc":
      return frameLocalCodec((frame, timestampMs) => accParser.tryParse(frame, null, timestampMs));
    case "fm-2023":
      return frameLocalCodec((frame, timestampMs) => forzaParser.tryParse(frame, null, timestampMs));
    case "lmu":
      return frameLocalCodec((frame, timestampMs) => lmuParser.tryParse(frame, null, timestampMs));
  }
}

interface CandidateParserCursor {
  readonly candidateId: string;
  readonly startByteOffset: number;
  preparationOnly: boolean;
  readonly planState: unknown;
  readonly digest: ParserTelemetryDigest;
  stateByteCost: number;
  lastFrameEvidence?: LiveParserReplayEvidence;
  firstFrameSeen: boolean;
  lapId?: string;
  ownedFrameCount?: number;
  evidence?: LiveParserReplayEvidence;
}

const MAX_LIVE_PARSER_CANDIDATES = 4;
const MAX_LIVE_PARSER_STATE_BYTES = 1024 * 1024;
const MAX_LIVE_PARSER_STATE_BUDGET_BYTES = MAX_LIVE_PARSER_CANDIDATES * MAX_LIVE_PARSER_STATE_BYTES;

export class LiveParserEvidenceTracker {
  private readonly candidates = new Map<string, CandidateParserCursor>();
  private stateByteCost = 0;
  private sourceState: unknown;
  private sourceInitialized = false;
  private beforeBaselineContext = false;
  private sourceStartByteOffset?: number;

  constructor(private readonly gameId: GameId, private readonly codec: LiveGameParserCodec) {}

  candidateStart(candidateId: string, startByteOffset: number, plan: LiveParserPlan, preparationOnly: boolean): Uint8Array {
    if (plan.gameId !== this.gameId) throw new Error("Live parser plan game ID mismatch");
    for (const [id, cursor] of this.candidates) {
      if (preparationOnly && cursor.preparationOnly && cursor.ownedFrameCount === undefined) this.discardCandidate(id);
    }
    if (this.candidates.has(candidateId)) this.discardCandidate(candidateId);
    if (this.candidates.size >= MAX_LIVE_PARSER_CANDIDATES) {
      throw new Error("Live parser candidate cursor budget exceeded");
    }
    const planState = restoreStateFromPlan(this.codec, plan);
    if (!this.sourceInitialized && !preparationOnly) {
      this.sourceState = planState;
      this.sourceStartByteOffset = startByteOffset;
      this.sourceInitialized = true;
    }
    const checkpoint = this.codec.captureState(planState);
    if (checkpoint.byteLength > MAX_LIVE_PARSER_STATE_BYTES ||
        this.stateByteCost + checkpoint.byteLength > MAX_LIVE_PARSER_STATE_BUDGET_BYTES) {
      throw new Error("Live parser candidate state exceeds byte budget");
    }
    const stateByteCost = checkpoint.byteLength;
    this.stateByteCost += stateByteCost;
    this.candidates.set(candidateId, {
      candidateId, startByteOffset, preparationOnly, planState: this.sourceInitialized ? undefined : planState,
      stateByteCost, firstFrameSeen: false, digest: new ParserTelemetryDigest(),
    });
    return checkpoint;
  }
  discardCandidate(candidateId: string): void {
    const cursor = this.candidates.get(candidateId);
    if (!cursor) return;
    this.candidates.delete(candidateId);
    this.stateByteCost -= cursor.stateByteCost;
  }
  promoteCandidate(candidateId: string): void {
    const cursor = this.candidates.get(candidateId);
    if (!cursor) throw new Error(`Unknown parser candidate ${candidateId}`);
    if (!this.sourceInitialized) {
      this.sourceState = cursor.planState;
      this.sourceStartByteOffset = cursor.startByteOffset;
      this.sourceInitialized = true;
    }
    cursor.preparationOnly = false;
  }

  bindCandidate(candidateId: string, lapId: string): void {
    const cursor = this.candidates.get(candidateId);
    if (!cursor) throw new Error(`Unknown parser candidate ${candidateId}`);
    cursor.lapId = lapId;
  }

  finalizeWindow(lap: LapWindow): void {
    const matches = [...this.candidates.values()].filter((candidate) =>
      candidate.startByteOffset === lap.startByteOffset);
    if (matches.length !== 1) throw new Error(`Expected one parser candidate cursor for lap ${lap.lapId}`);
    const cursor = matches[0]!;
    if (cursor.ownedFrameCount !== undefined && cursor.ownedFrameCount !== lap.frameCount) {
      throw new Error(`Parser candidate ownership changed for lap ${lap.lapId}`);
    }
    const currentCount = cursor.digest.sourceFrameCount;
    const trailingContextFrameCount = lap.trailingContextFrameCount ?? 0;
    if (currentCount > lap.frameCount + trailingContextFrameCount) {
      throw new Error(`Parser source cursor passed finalized ownership for lap ${lap.lapId}`);
    }
    cursor.ownedFrameCount = lap.frameCount;
    if (currentCount === lap.frameCount) cursor.evidence = cursor.digest.snapshot();
    else if (trailingContextFrameCount === 1 && currentCount === lap.frameCount + 1) {
      cursor.evidence = cursor.lastFrameEvidence;
    }
  }

  sourceRecord(record: SessionCaptureRecord): void {
    if (record.kind === "segment-context") {
      this.beforeBaselineContext = true;
      return;
    }
    if (record.kind === "segment-context-end") {
      this.beforeBaselineContext = false;
      return;
    }
    if (record.kind === "segment-boundary") {
      if (this.sourceInitialized && record.offset >= this.sourceStartByteOffset!) this.sourceState = this.codec.createState();
      return;
    }
    if (record.kind === "parser-bootstrap") {
      if (this.sourceInitialized && record.offset >= this.sourceStartByteOffset!) {
        if (record.gameId !== this.gameId || record.formatVersion !== 1) throw new Error("Canonical parser bootstrap identity mismatch");
        this.sourceState = this.codec.restoreState(record.payload);
      }
      return;
    }
    // Auxiliary-only recovery tails require conservation, not lap parser evidence.
    if (!this.sourceInitialized && this.candidates.size === 0) return;
    if (!this.sourceInitialized || record.offset < this.sourceStartByteOffset!) {
      if (this.beforeBaselineContext) return;
      throw new Error("Canonical parser source frame arrived before authoritative baseline");
    }
    const packet = this.codec.parseFrame(record.frame, this.sourceState, record.frameTimeMs);
    if (this.beforeBaselineContext) return;
    for (const cursor of this.candidates.values()) {
      if (record.offset < cursor.startByteOffset || cursor.evidence) continue;
      if (!cursor.firstFrameSeen && record.offset !== cursor.startByteOffset) {
        throw new Error(`Parser candidate start is not frame-aligned at ${cursor.startByteOffset}`);
      }
      if (cursor.ownedFrameCount !== undefined &&
          cursor.digest.sourceFrameCount >= cursor.ownedFrameCount) continue;
      cursor.firstFrameSeen = true;
      cursor.lastFrameEvidence = cursor.digest.snapshot();
      cursor.digest.add(packet, record.frameTimeMs);
      if (cursor.ownedFrameCount !== undefined &&
          cursor.digest.sourceFrameCount === cursor.ownedFrameCount) {
        cursor.evidence = cursor.digest.snapshot();
      }
    }
  }
  takeReplayEvidence(lap: LapWindow): LiveParserReplayEvidence | undefined {
    const cursor = [...this.candidates.values()].find((candidate) =>
      candidate.lapId === lap.lapId || candidate.startByteOffset === lap.startByteOffset);
    if (!cursor?.evidence) return undefined;
    this.discardCandidate(cursor.candidateId);
    return cursor.evidence;
  }

}

function restoreStateFromPlan(codec: LiveGameParserCodec, plan: LiveParserPlan): unknown {
  if (plan.anchorPayload.byteLength > 1024 * 1024) throw new Error("Live parser anchor exceeds byte limit");
  let replayBytes = 0;
  for (const record of plan.precedingRecords) replayBytes += record.frame.byteLength;
  if (replayBytes > 2 * 1024 * 1024) throw new Error("Live parser replay input exceeds byte limit");
  if (plan.precedingRecords.length !== plan.sequence - plan.anchorSequence ||
      plan.sequence - plan.anchorSequence > 64) {
    throw new Error("Live parser plan exceeds replay anchor bounds");
  }
  let expectedSequence = plan.anchorSequence;
  const state = codec.restoreState(plan.anchorPayload);
  for (const record of plan.precedingRecords) {
    if (record.sequence !== expectedSequence++) throw new Error("Live parser plan source sequence gap");
    codec.parseFrame(Buffer.from(record.frame), state, record.timestampMs);
  }
  if (expectedSequence !== plan.sequence) throw new Error("Live parser plan target sequence mismatch");
  return state;
}
