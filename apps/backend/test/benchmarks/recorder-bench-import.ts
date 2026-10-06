import type { GameId } from "@raceiq/shared/games/ids";
import {
  decompressIfGzipSync,
  iterateSessionCaptureRecords,
} from "@raceiq/backend-core/session-capture/framing";
import { applyFrameTime } from "@raceiq/backend-core/session-capture/frame-time";
import { IRACING_DUMP_MAGIC, readIRacingFramesFromBuffer } from "@raceiq/capture-formats/iracing/dump";
import { isIRacingSessionFrame } from "@raceiq/capture-formats/iracing/source-frame";
import { hasLMUDumpMagic, readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import {
  CapturingDbAdapter,
  NullSessionRecorderAdapter,
  NullWsAdapter,
  type SessionIdentity,
} from "@raceiq/backend-core/telemetry/pipeline-ports";
import { initServerGameAdapters } from "../../src/games/init";

class MemoryImportDb extends CapturingDbAdapter {
  continueSession = false;

  override insertSession(...args: Parameters<CapturingDbAdapter["insertSession"]>): Promise<number> {
    if (this.continueSession && this.sessions.length > 0) {
      this.continueSession = false;
      return Promise.resolve(this.sessions.length);
    }
    return super.insertSession(...args);
  }
}

export type MemoryImportResult = {
  packetCount: number;
  laps: {
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    carId: number;
    trackId: number;
  }[];
  identity: SessionIdentity | null;
};

/** Production index parser/detector workload with capture and database persistence excluded. */
export async function runMemoryImport(bytes: Buffer, gameId: GameId): Promise<MemoryImportResult> {
  initServerGameAdapters();
  const game = getServerGame(gameId);
  const db = new MemoryImportDb();
  const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
    bypassPacketRateFilter: true,
    skipHistorySeeding: true,
    skipDevState: true,
    recorder: new NullSessionRecorderAdapter(),
  });
  let state = game.createParserState?.() ?? null;
  let inContext = false;
  let completeLapStart = false;
  let expectsSessionContext = gameId === "iracing";
  let packetCount = 0;
  const capture = decompressIfGzipSync(bytes);
  const frames = gameId === "iracing" && capture.subarray(0, IRACING_DUMP_MAGIC.length).equals(IRACING_DUMP_MAGIC)
    ? readIRacingFramesFromBuffer(capture)
    : gameId === "lmu" && hasLMUDumpMagic(capture)
      ? readLMUFramesFromBuffer(capture)
      : null;
  function* records() {
    if (frames) {
      for (const frame of frames) yield { kind: "frame" as const, frame, frameTimeMs: undefined };
    } else {
      yield* iterateSessionCaptureRecords(capture);
    }
  }

  for (const record of records()) {
    if (record.kind === "segment-boundary") {
      if (db.sessions.length > 0) {
        db.continueSession = true;
        pipeline.beginSessionSegment();
      }
      state = game.createParserState?.() ?? null;
      completeLapStart = true;
      expectsSessionContext = gameId === "iracing";
      inContext = false;
      continue;
    }
    if (record.kind === "segment-context") {
      inContext = true;
      continue;
    }
    if (record.kind === "segment-context-end") {
      inContext = false;
      continue;
    }
    const { frame, frameTimeMs } = record;
    if (inContext || (completeLapStart && expectsSessionContext && isIRacingSessionFrame(frame))) {
      game.tryParse(frame, state);
      pipeline.recordSessionContextFrame(frame, !inContext && completeLapStart, frameTimeMs);
      if (!inContext) {
        expectsSessionContext = false;
        completeLapStart = false;
      }
      continue;
    }
    expectsSessionContext = false;
    completeLapStart = false;
    const packet = game.tryParseLapIndex(frame, state);
    if (!packet) continue;
    applyFrameTime(packet, frameTimeMs);
    await pipeline.processLapIndexPacket(packet, frame, frameTimeMs);
    packetCount++;
  }
  await pipeline.flushIncompleteLap();
  await pipeline.flushSessionRecorder();
  return {
    packetCount,
    identity: db.sessions[0]?.identity ?? null,
    laps: db.laps.map((lap) => {
      const session = db.sessions[lap.sessionId - 1];
      if (!session) throw new Error(`Missing captured session ${lap.sessionId}`);
      return {
        lapNumber: lap.lapNumber,
        lapTime: lap.lapTime,
        isValid: lap.isValid,
        carId: session.carOrdinal,
        trackId: session.trackOrdinal,
      };
    }),
  };
}
