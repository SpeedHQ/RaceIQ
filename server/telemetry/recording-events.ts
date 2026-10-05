import type { RecorderEngine, RecorderEvent } from "../runtime/recorder-engine";

export interface RecorderSessionStarted {
  gameId: string;
  sessionId: string;
  carOrdinal: number;
  trackOrdinal: number;
  carPI: number;
  sessionUID?: string;
  carId?: string;
  trackId?: string;
  sessionType?: string;
  rawFile: string;
  sparse: boolean;
  detectorVersion: string;
}
export interface RecorderLapRecorded {
  lapKey: string;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  invalidReason?: string | null;
  rawByteOffset: string;
  rawFrameCount: number;
  provisional?: boolean;
  sessionBestLapTime: number;
  analysisRecipe: unknown;
  sectors?: number[] | null;
}
export type RecordingLifecycleEvent =
  | { eventSequence: bigint; captureId: string; kind: "SESSION_STARTED"; data: RecorderSessionStarted }
  | { eventSequence: bigint; captureId: string; kind: "SESSION_IDENTITY_UPDATED"; data: Record<string, unknown> }
  | { eventSequence: bigint; captureId: string; kind: "LAP_RECORDED"; data: RecorderLapRecorded }
  | { eventSequence: bigint; captureId: string; kind: "LAP_RETRACTED"; data: { lapKey: string } }
  | { eventSequence: bigint; captureId: string; kind: "RECORDING_COMPLETED"; data: Record<string, unknown> };

export interface RecordingEventConsumer {
  consume(event: RecordingLifecycleEvent): Promise<void>;
  onLiveFrame?(event: Extract<RecorderEvent, { type: "live-frame" }>): Promise<void>;
  onStatus?(data: unknown): Promise<void>;
  onProgress?(data: unknown): Promise<void>;
}

/** Attach one ordered lifecycle consumer. Detach fences all events already accepted. */
export function attachRecordingEventConsumer(engine: RecorderEngine, consumer: RecordingEventConsumer): {
  detach(): Promise<void>;
} {
  let accepting = true;
  let chain = Promise.resolve();
  let lastSequence = 0n;
  let failure: unknown;
  const unsubscribe = engine.subscribe((event) => {
    if (!accepting) return;
    let work: Promise<void> | undefined;
    if (event.type === "live-frame") {
      if (consumer.onLiveFrame) work = chain.then(() => consumer.onLiveFrame!(event));
    } else if (event.type === "status") {
      if (consumer.onStatus) work = chain.then(() => consumer.onStatus!(event.data));
    } else if (event.type === "progress") {
      if (consumer.onProgress) work = chain.then(() => consumer.onProgress!(event.data));
    } else if (event.type === "event") {
      if (event.eventSequence <= lastSequence) return;
      const expected = lastSequence + 1n;
      if (event.eventSequence !== expected) {
        const error = new Error(`Recorder lifecycle event gap: expected ${expected}, received ${event.eventSequence}`);
        failure ??= error;
        return Promise.reject(error);
      }
      lastSequence = event.eventSequence;
      const lifecycle = { eventSequence: event.eventSequence, captureId: event.captureId, kind: event.kind, data: event.data } as RecordingLifecycleEvent;
      work = chain.then(() => consumer.consume(lifecycle));
    }
    if (!work) return;
    chain = work.catch((error) => {
      failure ??= error;
      throw error;
    });
    return chain;
  });
  return {
    async detach() {
      accepting = false;
      unsubscribe();
      try {
        await chain;
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    },
  };
}
