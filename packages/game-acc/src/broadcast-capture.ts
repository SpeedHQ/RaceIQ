import { AccBroadcastState } from "@raceiq/capture-formats/acc/broadcast-state";
import { parseAccBroadcastMessage } from "@raceiq/capture-formats/acc/broadcast-protocol";
import { ACC_BROADCAST_CAPTURE_MAX_PENDING_BYTES, encodeAccBroadcastCaptureRecord, type AccBroadcastCaptureCursor, type AccBroadcastCaptureEvent, type AccBroadcastCaptureEventKind } from "@raceiq/capture-formats/acc/broadcast-capture";
const EMPTY_PAYLOAD = Buffer.alloc(0);

export class AccBroadcastCaptureBuffer {
  private events: AccBroadcastCaptureEvent[] = [];
  private pendingBytes = 0;
  private nextSequence = 0;
  private acknowledgedSequence = 0;
  private contextFrameReceivedAtMs = 0;
  private readonly contextState = new AccBroadcastState({ now: () => this.contextFrameReceivedAtMs });
  recordDatagram(payload: Uint8Array, receivedAtMs: number): { overflowed: boolean } { return this.record("datagram", payload, receivedAtMs); }
  recordLifecycle(kind: Exclude<AccBroadcastCaptureEventKind, "datagram">, receivedAtMs: number): { overflowed: boolean } { return this.record(kind, EMPTY_PAYLOAD, receivedAtMs); }
  prepare(frameReceivedAtMs: number): AccBroadcastCaptureCursor { return { sequence: this.nextSequence, frameReceivedAtMs }; }
  encode(cursor: AccBroadcastCaptureCursor): Buffer {
    const events = this.events.filter((event) => event.sequence < cursor.sequence);
    return encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: cursor.frameReceivedAtMs, events });
  }
  encodeSessionContext(cursor: AccBroadcastCaptureCursor): readonly Buffer[] {
    if (cursor.sequence < this.acknowledgedSequence) throw new RangeError("ACCB context cursor precedes acknowledged evidence");
    // Only acknowledged facts belong here. Pending events remain in the ordinary
    // prefix, with their original sequence continuity checked independently.
    const events = this.contextState.captureContext();
    const records: Buffer[] = [];
    let batch: AccBroadcastCaptureEvent[] = [];
    let bytes = 20;
    for (const event of events) {
      const eventBytes = 17 + event.payload.length;
      if (batch.length && bytes + eventBytes > ACC_BROADCAST_CAPTURE_MAX_PENDING_BYTES) {
        records.push(encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: cursor.frameReceivedAtMs, events: batch }));
        batch = [];
        bytes = 20;
      }
      batch.push(event);
      bytes += eventBytes;
    }
    if (batch.length) records.push(encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: cursor.frameReceivedAtMs, events: batch }));
    return records;
  }
  acknowledge(cursor: AccBroadcastCaptureCursor, playerCarIndex?: number): void {
    if (cursor.sequence < this.acknowledgedSequence) return;
    for (const event of this.events) {
      if (event.sequence >= cursor.sequence) break;
      switch (event.kind) {
        case "socket-open": this.contextState.setSocketConnected(true, event); break;
        case "socket-close":
        case "socket-error": this.contextState.setSocketConnected(false, event); break;
        case "explicit-reset": this.contextState.reset(event); break;
        case "queue-overflow": this.contextState.markMalformed("capture-overflow", event); break;
        case "datagram": {
          const message = parseAccBroadcastMessage(event.payload);
          if (message) this.contextState.apply(message, event.receivedAtMs, event);
          else this.contextState.markMalformed("malformed-datagram", event);
          break;
        }
      }
    }
    this.acknowledgedSequence = cursor.sequence;
    this.contextFrameReceivedAtMs = cursor.frameReceivedAtMs;
    if (playerCarIndex !== undefined) this.contextState.setPlayerCarIndex(playerCarIndex);
    this.contextState.sourceStatus();
    const kept = this.events.filter((event) => event.sequence >= cursor.sequence);
    this.events = kept;
    this.pendingBytes = kept.reduce((sum, event) => sum + 17 + event.payload.length, 0);
  }
  private record(kind: AccBroadcastCaptureEventKind, payload: Uint8Array, receivedAtMs: number): { overflowed: boolean } {
    const bytes = payload.length + 17;
    if (this.pendingBytes + bytes > ACC_BROADCAST_CAPTURE_MAX_PENDING_BYTES) {
      this.events = [];
      // Preserve the triggering socket transition so replay can recover without
      // inferring a connection from later realtime or registration datagrams.
      if (kind !== "datagram" && kind !== "queue-overflow") {
        this.events.push({ sequence: this.nextSequence++, receivedAtMs, kind, payload: EMPTY_PAYLOAD });
      }
      this.events.push({ sequence: this.nextSequence++, receivedAtMs, kind: "queue-overflow", payload: EMPTY_PAYLOAD });
      this.pendingBytes = this.events.length * 17;
      return { overflowed: true };
    }
    this.events.push({ sequence: this.nextSequence++, receivedAtMs, kind, payload: kind === "datagram" ? Buffer.from(payload) : EMPTY_PAYLOAD });
    this.pendingBytes += bytes;
    return { overflowed: false };
  }
}
export const accBroadcastCapture = new AccBroadcastCaptureBuffer();
