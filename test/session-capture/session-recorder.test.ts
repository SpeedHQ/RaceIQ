import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { SessionRecorder } from "../../server/session-capture/recorder";
import { META_FRAME_MAGIC } from "../../server/session-capture/framing";
import { getServerGame } from "../../server/games/registry";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { readUdpDump } from "../support/recordings/udp";

initGameAdapters();
initServerGameAdapters();

function readCaptureFrames(filePath: string, limit = 12): Buffer[] {
  const compressed = readFileSync(filePath);
  const data = filePath.endsWith(".gz") ? gunzipSync(compressed) : compressed;
  let offset = data.readUInt32LE(0) === META_FRAME_MAGIC ? 8 + data.readUInt32LE(4) : 0;
  const frames: Buffer[] = [];
  while (frames.length < limit && offset + 4 <= data.length) {
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (!length || offset + length > data.length) break;
    frames.push(Buffer.from(data.subarray(offset, offset + length)));
    offset += length;
  }
  return frames;
}
describe("SessionRecorder + readUdpDump", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("round-trips packets through dump file", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    const recorder = new SessionRecorder();
    recorder.start(join(tmpDir, "dump.bin"));

    const pkt1 = Buffer.from([0x01, 0x02, 0x03]);
    const pkt2 = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
    recorder.writeRecord(pkt1);
    recorder.writeRecord(pkt2);
    await recorder.stop();

    const packets = readUdpDump(recorder.path!);
    expect(packets).toHaveLength(2);
    expect(packets[0]).toEqual(pkt1);
    expect(packets[1]).toEqual(pkt2);
  });

  test.each([
    ["fm-2023", "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz"],
    ["f1-2025", "test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz"],
  ] as const)("matches %s recorder output with fixture packet output", async (gameId, fixturePath) => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-recorder-test-"));
    const fixtureFrames = readCaptureFrames(fixturePath);
    const adapter = getServerGame(gameId);
    const fixtureState = adapter.createParserState?.() ?? null;
    const fixturePackets = fixtureFrames
      .map((frame) => adapter.tryParse(frame, fixtureState))
      .filter((packet) => packet !== null);
    const recorder = new SessionRecorder();
    const outputPath = recorder.start(join(tmpDir, "capture.bin"));
    recorder.writeMetaFrame();
    for (const frame of fixtureFrames) recorder.writeRecord(frame);
    await recorder.stop();

    const raw = readFileSync(outputPath);
    const recordedFrames = readCaptureFrames(outputPath, fixtureFrames.length);
    const recordedState = adapter.createParserState?.() ?? null;
    const recordedPackets = recordedFrames
      .map((frame) => adapter.tryParse(frame, recordedState))
      .filter((packet) => packet !== null);

    expect(raw.readUInt32LE(8)).toBe(fixtureFrames.length);
    expect(recorder.recordCount).toBe(fixtureFrames.length);
    expect(recordedFrames).toHaveLength(fixtureFrames.length);
    expect(recordedPackets).toHaveLength(fixturePackets.length);
    for (let i = 0; i < fixturePackets.length; i++) {
      expect(recordedPackets[i]!.CurrentLap).toBeCloseTo(fixturePackets[i]!.CurrentLap, 6);
      expect(recordedPackets[i]!.LastLap).toBeCloseTo(fixturePackets[i]!.LastLap, 6);
      expect(recordedPackets[i]!.LapNumber).toBe(fixturePackets[i]!.LapNumber);
    }
  });

  test("readUdpDump handles truncated final record gracefully", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    // Construct a valid record followed by a truncated one
    const valid = Buffer.from([0x03, 0x00, 0x00, 0x00, 0xAA, 0xBB, 0xCC]); // len=3, 3 bytes
    const truncated = Buffer.from([0x05, 0x00, 0x00, 0x00, 0xFF]); // declares 5 bytes, only 1 present
    const dumpPath = join(tmpDir, "dump.bin");
    writeFileSync(dumpPath, Buffer.concat([valid, truncated]));

    const packets = readUdpDump(dumpPath);
    expect(packets).toHaveLength(1);
    expect(packets[0]).toEqual(Buffer.from([0xAA, 0xBB, 0xCC]));
  });
});
