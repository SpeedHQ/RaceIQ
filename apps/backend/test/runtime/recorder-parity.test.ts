import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readIRacingFrames } from "@raceiq/capture-formats/iracing/dump";
import { readLMUFrames } from "@raceiq/capture-formats/lmu/dump";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getRecordingFixture } from "@raceiq/backend-core/test-support/recordings/fixtures";
import { iterateSessionCaptureRecords } from "@raceiq/backend-core/session-capture/framing";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { RecorderClient } from "../../src/runtime/recorder-client";
import { resolveRecorderExecutablePath } from "../../src/runtime/recorder-client";
import type { RecordingGameSupport } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { fmRecordingSupport } from "@raceiq/game-fm-2023/test-support/recordings";
import { f1RecordingSupport } from "@raceiq/game-f1-2025/test-support/recordings";
import { accRecordingSupport } from "@raceiq/game-acc/test-support/recordings";
import { acEvoRecordingSupport } from "@raceiq/game-ac-evo/test-support/recordings";
import { iracingRecordingSupport } from "@raceiq/game-iracing/test-support/recordings";
import { lmuRecordingSupport } from "@raceiq/game-lmu/test-support/recordings";

const fixtures = [
  ["fm-2023", "fm-2023-2026-04-09T21-55-03-186Z.bin.gz", fmRecordingSupport],
  ["f1-2025", "f1-2025-2026-04-22T11-42-43-029Z.bin.gz", f1RecordingSupport],
  ["acc", "acc-2026-04-23T16-42-16-158Z.bin.gz", accRecordingSupport],
  ["ac-evo", "session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz", acEvoRecordingSupport],
  ["iracing", "iracing-daytona-am-vantage-gt3-pit.bin.gz", iracingRecordingSupport],
  ["lmu", "lmu-spa-iron-lynx-gte.bin.gz", lmuRecordingSupport],
] as const satisfies readonly (readonly [string, string, RecordingGameSupport])[];

type ReplayResult = { resultPath: string };
type ReplayManifest = { gameId: string; packetCount: number; packets: { offset: string; frameTimeMs: string | null; packet: TelemetryPacket }[]; markers: { offset: string; kind: string; packet?: unknown }[] };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }

initGameAdapters();
initServerGameAdapters();

const recorderPath = (() => {
  try { return resolveRecorderExecutablePath(); }
  catch (error) { throw new Error(`recorder-parity.test requires prebuilt native/recorder/target/debug/raceiq-recorder; run bun run build:recorder before tests. ${String(error)}`); }
})();

for (const [gameId, fixtureName, support] of fixtures) {
  // Full fixtures perform two complete replays plus import in the debug child.
  test(`Rust ${gameId} capture replay matches source-decoder semantics and storage metadata`, async () => {
    const fixture = getRecordingFixture(fixtureName);
    if (!fixture || !existsSync(fixture)) throw new Error(`Required ${gameId} parity fixture missing: ${fixtureName} (test/artifacts/sessions)`);
    const root = mkdtempSync(join(tmpdir(), `raceiq-recorder-parity-${gameId}-`));
    const dataDir = join(root, "data");
    const stagingRoot = join(root, "staging");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(stagingRoot, { recursive: true });
    const source = join(dataDir, fixtureName);
    const stagedSource = join(stagingRoot, fixtureName);
    copyFileSync(fixture, source);
    copyFileSync(fixture, stagedSource);
    const input = fixtureName.endsWith(".gz") ? gunzipSync(readFileSync(fixture)) : readFileSync(fixture);
    const sourceFrameHash = createHash("sha256");
    const parserState = support.adapter.createParserState?.() ?? null;
    const expected: TelemetryPacket[] = [];
    const expectedFrames: { time: number | null; offset: number }[] = [];
    let expectedContextCount = 0;
    let sourceFrameCount = 0;
    const sourceFrames = gameId === "iracing" ? readIRacingFrames(source) : gameId === "lmu" ? readLMUFrames(source) : null;
    if (sourceFrames) {
      for (const frame of sourceFrames) {
        const frameLength = Buffer.allocUnsafe(4);
        frameLength.writeUInt32LE(frame.length);
        sourceFrameHash.update(frameLength).update(frame);
        sourceFrameCount += 1;
        const packet = support.adapter.tryParse(frame, parserState);
        if (packet) expected.push(packet);
      }
    } else {
      for (const record of iterateSessionCaptureRecords(input)) {
        if (record.kind === "segment-context") { expectedContextCount += 1; continue; }
        if (record.kind !== "frame") continue;
        const frameLength = Buffer.allocUnsafe(4);
        frameLength.writeUInt32LE(record.frame.length);
        sourceFrameHash.update(frameLength).update(record.frame);
        sourceFrameCount += 1;
        const packet = support.adapter.tryParse(record.frame, parserState);
        if (packet) {
          // Kunos timestamps are host-clock values live; replay uses capture time or zero when absent.
          if (gameId === "acc" || gameId === "ac-evo") packet.TimestampMS = record.frameTimeMs ?? 0;
          expected.push(packet);
          expectedFrames.push({ time: record.frameTimeMs ?? null, offset: record.offset });
        }
      }
    }
    const client = new RecorderClient({ executablePath: recorderPath });
    try {
      await client.start({
        dataDir: resolve(dataDir), stagingRoot: resolve(stagingRoot), udpHostname: "127.0.0.1", udpPort: 0,
        featureGates: {}, recordingGameId: null, recordingDirectory: root,
        games: fixtures.map(([id]) => ({ id, processNames: [] })),
      });
      const response = await client.request<ReplayResult>("read-capture", {
        jobId: `parity-${gameId}`, input: { path: source }, options: { gameId },
      });
      const actual = JSON.parse(readFileSync(response.resultPath, "utf8")) as ReplayManifest;
      expect(actual.gameId).toBe(gameId);
      expect(actual.packetCount).toBe(expected.length);
      expect(actual.packets.length).toBe(expected.length);
      // Hash windows independently; avoid constructing another whole-history JSON string.
      const windowSize = Math.max(1, Math.ceil(expected.length / 32));
      for (let start = 0; start < expected.length; start += windowSize) {
        const end = Math.min(expected.length, start + windowSize);
        expect(digest(actual.packets.slice(start, end).map((item) => item.packet))).toBe(digest(expected.slice(start, end)));
        if (!sourceFrames) {
          expect(actual.packets.slice(start, end).map((item) => item.frameTimeMs)).toEqual(expectedFrames.slice(start, end).map(({ time }) => time === null ? null : String(time)));
          expect(actual.packets.slice(start, end).map((item) => item.offset)).toEqual(expectedFrames.slice(start, end).map(({ offset }) => String(offset)));
        }
      }
      if (!sourceFrames) expect(actual.markers.filter((marker) => marker.kind === "context").length).toBe(expectedContextCount);

      const imported = await client.request<ReplayResult>("import", {
        jobId: `import-${gameId}`,
        input: { path: stagedSource, originalName: fixtureName },
        options: { gameId },
      });
      const importedManifest = JSON.parse(readFileSync(imported.resultPath, "utf8")) as {
        packetCount: number;
        artifacts: string[];
      };
      expect(importedManifest.packetCount).toBeGreaterThan(0);
      expect(importedManifest.artifacts.length).toBeGreaterThan(0);
      const importedCapture = join(dataDir, `imported-${gameId}.bin`);
      copyFileSync(importedManifest.artifacts[0], importedCapture);
      const importedBytes = readFileSync(importedCapture);
      const importedFrameHash = createHash("sha256");
      let importedFrameCount = 0;
      for (const record of iterateSessionCaptureRecords(importedBytes)) {
        if (record.kind !== "frame") continue;
        const frameLength = Buffer.allocUnsafe(4);
        frameLength.writeUInt32LE(record.frame.length);
        importedFrameHash.update(frameLength).update(record.frame);
        importedFrameCount += 1;
      }
      expect(importedFrameCount).toBe(sourceFrameCount);
      expect(importedFrameHash.digest("hex")).toBe(sourceFrameHash.digest("hex"));
      const roundTrip = await client.request<ReplayResult>("read-capture", {
        jobId: `roundtrip-${gameId}`, input: { path: importedCapture }, options: { gameId },
      });
      const roundTripManifest = JSON.parse(readFileSync(roundTrip.resultPath, "utf8")) as ReplayManifest;
      expect(roundTripManifest.packetCount).toBe(expected.length);
      for (let start = 0; start < expected.length; start += windowSize) {
        const end = Math.min(expected.length, start + windowSize);
        expect(digest(roundTripManifest.packets.slice(start, end).map((item) => item.packet))).toBe(digest(expected.slice(start, end)));
        if (!sourceFrames) expect(roundTripManifest.packets.slice(start, end).map((item) => item.frameTimeMs)).toEqual(expectedFrames.slice(start, end).map(({ time }) => time === null ? null : String(time)));
      }
    } finally {
      await client.shutdown("signal");
      rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
}

test("Rust imports an ordinary MoTeC ZIP and replays its complete lap recipe", async () => {
  const root = mkdtempSync(join(tmpdir(), "raceiq-recorder-motec-"));
  const dataDir = join(root, "data");
  const stagingRoot = join(root, "staging");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });
  const name = "acc-barcelona-porsche-992.zip";
  const source = join(stagingRoot, name);
  copyFileSync(resolve("test/artifacts/motec", name), source);
  const client = new RecorderClient({ executablePath: recorderPath });
  try {
    await client.start({
      dataDir, stagingRoot, udpHostname: "127.0.0.1", udpPort: 0,
      featureGates: {}, recordingGameId: null, recordingDirectory: root,
      games: fixtures.map(([id]) => ({ id, processNames: [] })),
    });
    const imported = await client.request<ReplayResult>("import", {
      jobId: "motec-import", input: { path: source, originalName: name, format: "motec" },
      options: { gameId: "acc", carOrdinal: 0, trackOrdinal: 0 },
    });
    const manifest = JSON.parse(readFileSync(imported.resultPath, "utf8")) as {
      sessions: { rawFile: string; offsetEncoding: string; laps: {
        lapTime: number; analysisRecipe: { ranges: { offset: string; count: number }[]; contextOffset?: string };
      }[] }[];
    };
    expect(manifest.sessions).toHaveLength(1);
    const session = manifest.sessions[0]!;
    expect(session.laps).toHaveLength(1);
    const lap = session.laps[0]!;
    expect(lap.lapTime).toBeGreaterThan(100);
    expect(lap.lapTime).toBeLessThan(104);
    // Mirror import commit: replay reads the archive after promotion into DATA_DIR.
    const savedSource = join(dataDir, "imported.motec.zip");
    copyFileSync(session.rawFile, savedSource);
    const replay = await client.request<ReplayResult>("read-lap-window", {
      jobId: "motec-lap", input: { path: savedSource }, options: { gameId: "acc", carOrdinal: 0, trackOrdinal: 0 },
      ranges: lap.analysisRecipe.ranges, contextOffset: lap.analysisRecipe.contextOffset ?? null,
      offsetEncoding: session.offsetEncoding,
    });
    const window = JSON.parse(readFileSync(replay.resultPath, "utf8")) as ReplayManifest;
    expect(window.packetCount).toBe(6164);
    expect(window.packets[0]?.offset).toBe("0");
    expect(window.packets.at(-1)?.offset).toBe("6163");
    expect(window.packets.every(({ packet }) => packet.gameId === "acc")).toBe(true);
  } finally {
    await client.shutdown("signal");
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
