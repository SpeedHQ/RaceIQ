import { describe, expect, test } from "bun:test";
import { LiveTelemetryPipeline } from "../../server/telemetry/live-pipeline";
import { NullDbAdapter, NullWsAdapter, type SessionRecorderAdapter } from "../../server/telemetry/pipeline-ports";
import { iterateSessionCaptureRecords } from "../../server/session-capture/framing";

class RecordingRecorder implements SessionRecorderAdapter {
  readonly writes: Buffer[] = [];
  readonly active = true;
  readonly path = null;
  readonly epoch = 0;
  start(): void {}
  writeMetaFrame(): void {}
  writeRecord(frame: Buffer): void {
    this.writes.push(Buffer.concat([Buffer.from([frame.length, 0, 0, 0]), Buffer.from(frame)]));
  }
  writeRawCaptureBytes(bytes: Buffer): void { this.writes.push(Buffer.from(bytes)); }
  writeSegmentBoundary(): void {}
  getCurrentByteOffset(): number { return 0; }
  flush(): void {}
  async stop(): Promise<void> {}
}

describe("session context recording", () => {
  test("records context frame with context markers", () => {
    const recorder = new RecordingRecorder();
    const pipeline = new LiveTelemetryPipeline(new NullDbAdapter(), new NullWsAdapter(), { recorder });
    const sourceFrame = Buffer.from([1, 2, 3]);

    pipeline.recordSessionContextFrame(sourceFrame);

    const capture = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff, 4, 0, 0, 0, 0, 0, 0, 0]),
      ...recorder.writes,
    ]);
    const records = [...iterateSessionCaptureRecords(capture)];
    expect(records.map((record) => record.kind)).toEqual([
      "segment-context",
      "frame",
      "segment-context-end",
    ]);
  });
});
