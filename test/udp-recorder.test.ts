import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { UdpRecorder } from "../server/udp-recorder";
import { readUdpDump } from "./helpers/recording";

describe("UdpRecorder + readUdpDump", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("round-trips packets through dump file", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    const recorder = new UdpRecorder();
    recorder.start(join(tmpDir, "dump.bin"));

    const pkt1 = Buffer.from([0x01, 0x02, 0x03]);
    const pkt2 = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
    recorder.writePacket(pkt1);
    recorder.writePacket(pkt2);
    await recorder.stop();

    const packets = readUdpDump(recorder.path!);
    expect(packets).toHaveLength(2);
    expect(packets[0]).toEqual(pkt1);
    expect(packets[1]).toEqual(pkt2);
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
