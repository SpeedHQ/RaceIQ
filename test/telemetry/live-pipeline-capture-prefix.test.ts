import { afterAll, expect, test } from "bun:test";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { CapturingDbAdapter, NullWsAdapter, type SessionRecorderAdapter } from "../../server/telemetry/pipeline-ports";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { AccBroadcastCaptureBuffer } from "../../server/games/acc/broadcast-capture";
import { encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, iterateSessionCaptureRecords } from "../../server/session-capture/framing";
import { packet } from "../support/telemetry/resolver";

initGameAdapters();
initServerGameAdapters();
afterAll(stopMaintenanceTasks);

class CaptureRecorder implements SessionRecorderAdapter {
  active = false;
  readonly path = null;
  epoch = 0;
  readonly captures: Buffer[][] = [];
  private offset = 0;
  start(): void { this.active = true; this.epoch++; this.offset = 0; this.captures.push([]); }
  writeMetaFrame(): void { this.writeRawCaptureBytes(encodeMetaFrame()); }
  writeRecord(frame: Buffer): void { this.writeRawCaptureBytes(Buffer.concat([encodeFrameLength(frame.length), frame])); }
  writeRawCaptureBytes(bytes: Buffer): void { this.captures[this.captures.length - 1]!.push(bytes); this.offset += bytes.length; }
  writeSegmentBoundary(): void { this.writeRawCaptureBytes(encodeSegmentBoundaryFrame()); }
  getCurrentByteOffset(): number { return this.offset; }
  flush(): void {}
  async stop(): Promise<void> { this.active = false; }
}

for (const indexOnly of [false, true]) {
  test(`${indexOnly ? "lap-index" : "live"} rotation retains identical ACCB events in both captures and acknowledges once`, async () => {
    const recorder = new CaptureRecorder();
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), new NullWsAdapter(), {
      recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true, engineerEnabled: false,
    });
    const process = indexOnly ? pipeline.processLapIndexPacket.bind(pipeline) : pipeline.processPacket.bind(pipeline);
    const first = packet("fm-2023", { IsRaceOn: 1, CarOrdinal: 1, TrackOrdinal: 1, TimestampMS: 1_000, LapNumber: 1, CurrentLap: 1, DistanceTraveled: 100 });
    await process(first, Buffer.from([1]));
    const capture = new AccBroadcastCaptureBuffer();
    capture.recordLifecycle("socket-open", 1_005);
    capture.recordDatagram(Buffer.from([255]), 1_006);
    const cursor = capture.prepare(1_010);
    let encoded = 0;
    let acknowledged = 0;
    const rotating = packet("fm-2023", { IsRaceOn: 1, CarOrdinal: 2, TrackOrdinal: 1, TimestampMS: 1_010, LapNumber: 1, CurrentLap: 1.01, DistanceTraveled: 101 });
    await process(rotating, {
      frame: Buffer.from([2]),
      capturePrefixRecords: () => { encoded++; return [capture.encode(cursor)]; },
      acknowledgeRecorded: () => { acknowledged++; capture.acknowledge(cursor); },
    });
    expect(recorder.captures).toHaveLength(2);
    const batches = recorder.captures.map((parts) => [...iterateSessionCaptureRecords(Buffer.concat(parts))].flatMap((record) => record.kind === "acc-broadcast" ? [record.batch] : []));
    expect(batches[0]).toEqual(batches[1]);
    expect(batches[1]![0]?.events.map((event) => event.kind)).toEqual(["socket-open", "datagram"]);
    expect(encoded).toBe(1);
    expect(acknowledged).toBe(1);
    const remainder = [...iterateSessionCaptureRecords(capture.encode(capture.prepare(1_020)))];
    expect(remainder).toMatchObject([{ kind: "acc-broadcast", batch: { events: [] } }]);
    await pipeline.flushSessionRecorder();
  });
}
