import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { iterateSessionCaptureRecords, type SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import type { LapWindow } from "../src/contract";
import { FileStreamingSplitterHost } from "../src/streaming-host";
import type { LiveParserReplayEvidence, StreamingMemberDescriptor, StreamingSplitterHost } from "../src/streaming";
import { StreamingCaptureSplitter } from "../src/streaming-state";
import { LiveWorkJournal } from "../src/live-work-journal";

const evidence: LiveParserReplayEvidence = {
  sourceFrameCount: 1,
  parsedFrameCount: 1,
  nullFrameCount: 0,
  orderedTelemetryDigest: "pure-codec-test",
};

async function runScenario(configure: (splitter: StreamingCaptureSplitter, offsets: number[]) => void, payloads: number[]) {
  const root = mkdtempSync(join(tmpdir(), "raceiq-live-split-scenario-"));
  const archivePath = join(root, "capture.bin.gz");
  const descriptors: StreamingMemberDescriptor[] = [];
  let generation = 0;
  const fileHost = new FileStreamingSplitterHost({
    archivePath,
    maxQueuedBytes: 1024 * 1024,
    maxUnresolvedBytes: 1024 * 1024,
    commit: async (descriptor) => { generation++; descriptors.push(descriptor); return generation; },
  });
  const host: StreamingSplitterHost = {
    maxQueuedBytes: fileHost.maxQueuedBytes,
    maxUnresolvedBytes: fileHost.maxUnresolvedBytes,
    auxiliaryMemberBytes: fileHost.auxiliaryMemberBytes,
    createStage: fileHost.createStage.bind(fileHost),
    createPositionSpool: fileHost.createPositionSpool.bind(fileHost),
    dispose: () => fileHost.dispose(),
    replayEvidence: () => evidence,
    replayParser: async (stage, lap) => {
      const frames: SessionCaptureRecord[] = [];
      for await (const record of stage.readRecords()) if (record.kind === "frame") frames.push(record);
      expect(frames).toHaveLength(lap.frameCount + (lap.trailingContextFrameCount ?? 0));
    },
  };
  const splitter = new StreamingCaptureSplitter({ gameId: "fm-2023", host });
  const records: SessionCaptureRecord[] = payloads.map((value, index) => ({
    kind: "frame", offset: index * 16, endOffset: (index + 1) * 16,
    frame: Buffer.from([value]), frameTimeMs: index * 10,
  }));
  const offsets = records.map(({ offset }) => offset);
  configure(splitter, offsets);
  for (const record of records) {
    expect(splitter.enqueue(record)).toBe(true);
    splitter.advanceWatermark(record.endOffset);
    await splitter.drain();
  }
  await splitter.close();
  const archiveRecords = [...iterateSessionCaptureRecords(gunzipSync(readFileSync(archivePath)), 0, { strict: true })];
  const archiveFrames = archiveRecords.filter((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame");
  return { root, descriptors, archiveFrames };
}

function window(lapId: string, lapNumber: number, startByteOffset: number, frameCount: number): LapWindow {
  return { lapId, lapNumber, startByteOffset, frameCount };
}

test("live splitter publishes normal dynamic lap through real file host", async () => {
  const result = await runScenario((splitter, offsets) => {
    splitter.startCandidate("normal", 1, offsets[0]!, new Uint8Array());
    splitter.bindCandidate("normal", "lap-normal");
    splitter.finalizeCandidate("normal", window("lap-normal", 1, offsets[0]!, 2), 1);
  }, [10, 11, 12, 13]);
  try {
    expect(result.descriptors.map(({ lap }) => lap?.lapId)).toEqual(["lap-normal", undefined]);
    expect(result.archiveFrames.map(({ frame, frameTimeMs }) => [frame[0], frameTimeMs])).toEqual([[10, 0], [11, 10], [12, 20], [13, 30]]);
  } finally { rmSync(result.root, { recursive: true, force: true }); }
});

test("live splitter trims tentative prefix when later detector candidate wins", async () => {
  const result = await runScenario((splitter, offsets) => {
    splitter.startCandidate("tentative", 1, offsets[0]!, new Uint8Array());
    splitter.startCandidate("selected", 2, offsets[2]!, new Uint8Array(), true);
    splitter.bindCandidate("selected", "lap-selected");
    splitter.finalizeCandidate("selected", window("lap-selected", 2, offsets[2]!, 3), 1);
  }, [20, 21, 22, 23, 24]);
  try {
    expect(result.descriptors.map(({ kind, lap }) => [kind, lap?.lapId])).toEqual([["auxiliary", undefined], ["lap", "lap-selected"]]);
    expect(result.archiveFrames.map(({ frame }) => frame[0])).toEqual([20, 21, 22, 23, 24]);
    expect(result.descriptors[0]!.sourceByteEnd).toBe(result.descriptors[1]!.sourceByteStart);
  } finally { rmSync(result.root, { recursive: true, force: true }); }
});

test("live splitter preserves one shared completion frame across adjacent laps", async () => {
  const result = await runScenario((splitter, offsets) => {
    splitter.startCandidate("first", 1, offsets[0]!, new Uint8Array());
    splitter.bindCandidate("first", "lap-first");
    splitter.finalizeCandidate("first", window("lap-first", 1, offsets[0]!, 3), 1);
    splitter.startCandidate("second", 2, offsets[2]!, new Uint8Array());
    splitter.bindCandidate("second", "lap-second");
    splitter.finalizeCandidate("second", window("lap-second", 2, offsets[2]!, 2), 1);
  }, [30, 31, 32, 33]);
  try {
    expect(result.descriptors.map(({ lap }) => [lap?.lapId, lap?.frameCount, lap?.trailingContextFrameCount ?? 0])).toEqual([
      ["lap-first", 2, 1], ["lap-second", 2, 0],
    ]);
    expect(result.archiveFrames.map(({ frame }) => frame[0])).toEqual([30, 31, 32, 32, 33]);
    expect(result.archiveFrames.map(({ frameTimeMs }) => frameTimeMs)).toEqual([0, 10, 20, 20, 30]);
  } finally { rmSync(result.root, { recursive: true, force: true }); }
});

test("bounded progress consumption leaves ownership visible to ordered replay and lookahead", async () => {
  const root = mkdtempSync(join(tmpdir(), "raceiq-live-progress-"));
  type Control = { kind: "watermark" | "ownership"; offset: number };
  const journal = await LiveWorkJournal.create<Control>(join(root, "controls"), {
    maxPendingBytes: 4096, maxPendingRecords: 16, maxRecordBytes: 1024,
  });
  try {
    for (const offset of [1, 2, 3]) await journal.append({ kind: "watermark", offset });
    await journal.append({ kind: "ownership", offset: 4 });
    await journal.append({ kind: "watermark", offset: 5 });
    const ordered = journal.readAvailable();
    expect((await ordered.next()).value).toEqual({ kind: "watermark", offset: 1 });
    const consumed: number[] = [];
    await journal.consumeAvailableWhile((value) => value.kind === "watermark", (value) => consumed.push(value.offset), 1);
    expect(consumed).toEqual([2]);
    expect((await ordered.next()).value).toEqual({ kind: "watermark", offset: 3 });
    await journal.consumeAvailableWhile((value) => value.kind === "watermark", (value) => consumed.push(value.offset), 2);
    expect(consumed).toEqual([2]);
    expect(await journal.findPending((value) => value.kind === "ownership")).toEqual({ kind: "ownership", offset: 4 });
    expect((await ordered.next()).value).toEqual({ kind: "ownership", offset: 4 });
    expect((await ordered.next()).value).toEqual({ kind: "watermark", offset: 5 });
    await ordered.return(undefined);
  } finally {
    await journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
