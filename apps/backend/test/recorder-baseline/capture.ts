import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { RecordingGameSupport } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

type JournalEvent = { sequence: number; kind: string; data: unknown };
type SourceMarker = { inputOffset: number; kind: "segment-boundary" | "segment-context" | "segment-context-end" | "unsupported-source"; reason?: string };
type ParsedSourceFrame = { inputOffset: number; frame: Buffer; packet: TelemetryPacket | null; frameTimeMs?: number };
type SourceFrame = ParsedSourceFrame | SourceMarker;
type OutputRecord = { inputOffset: number; outputOffset: number; path: string | null };
type DetectorInternals = { lapBuffer?: TelemetryPacket[] };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function stable(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const fields = value as Record<string, unknown>;
  return `{${Object.keys(fields).sort().filter((key) => key !== "captureId" && key !== "createdAt").map((key) => `${JSON.stringify(key)}:${stable(fields[key])}`).join(",")}}`;
}
function signature(value: unknown): string {
  const semantic = { ...(value as Record<string, unknown>) };
  if (semantic.gameId === "acc" || semantic.gameId === "ac-evo") delete semantic.TimestampMS;
  delete semantic.timestamp;
  delete semantic.captureId;
  return sha256(Buffer.from(stable(semantic)));
}
function* readSourceFrames(path: string, support: RecordingGameSupport): Generator<SourceFrame> {
  const compressed = readFileSync(path);
  const bytes = path.endsWith(".gz") ? Buffer.from(gunzipSync(compressed)) : compressed;
  const adapter = support.adapter;
  const parserState = adapter.createParserState?.() ?? null;
  const parseFrame = (inputOffset: number, frame: Buffer): ParsedSourceFrame => ({
    inputOffset,
    frame,
    packet: adapter.tryParse(frame, parserState),
  });
  if (bytes.subarray(0, 8).equals(Buffer.from("IRIQDMP\0", "ascii"))) {
    const frames = readIRacingFramesFromBuffer(bytes);
    let offset = 16;
    for (const frame of frames) {
      yield parseFrame(offset + 5, frame);
      offset += 5 + frame.length;
    }
    return;
  }
  if (bytes.subarray(0, 8).equals(Buffer.from("LMUQDMP\0", "ascii"))) {
    const frames = readLMUFramesFromBuffer(bytes);
    let offset = 16;
    for (const frame of frames) {
      yield parseFrame(offset + 5, frame);
      offset += 5 + frame.length;
    }
    return;
  }
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xffffffff && bytes.readUInt32LE(4) === 4) {
    for (const record of iterateSessionCaptureRecords(bytes)) {
      if (record.kind === "frame") {
        const parsed = parseFrame(record.offset, record.frame);
        yield record.frameTimeMs === undefined ? parsed : { ...parsed, frameTimeMs: record.frameTimeMs };
      } else {
        yield { inputOffset: record.offset, kind: record.kind };
      }
    }
    return;
  }
  if (bytes.subarray(0, 8).equals(Buffer.from("ACCTEST\0", "ascii"))) {
    yield { inputOffset: 0, kind: "unsupported-source", reason: "ACCTEST v2/v3 has separate Kunos physics/graphics/static records; source triplet offsets are unavailable from current reader" };
    return;
  }
  const packets = readUdpDump(path);
  let offset = 0;
  for (const frame of packets) {
    yield parseFrame(offset + 4, frame);
    offset += 4 + frame.length;
  }
}

const outputArg = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
if (!outputArg) throw new Error("Usage: bun apps/backend/test/recorder-baseline/capture.ts --output=<path>");
const temporaryDataDir = mkdtempSync(join(tmpdir(), "raceiq-recorder-baseline-"));
process.env.DATA_DIR = temporaryDataDir;
// Runtime imports must follow DATA_DIR setup: DB/config modules bind paths during evaluation.
const [
  { initGameAdapters },
  { initServerGameAdapters },
  { LiveTelemetryPipeline, stopMaintenanceTasks },
  { CapturingDbAdapter, CapturingWsAdapter, SparseSessionRecorderAdapter },
  { getServerGame, registerServerGame },
  { iterateSessionCaptureRecords },
  { parseDump },
  { getGame },
  { fmRecordingSupport },
  { isForzaRaceOffPacket },
  { f1RecordingSupport },
  { accRecordingSupport },
  { acEvoRecordingSupport },
  { iracingRecordingSupport },
  { lmuRecordingSupport },
  { readIRacingFramesFromBuffer },
  { readLMUFramesFromBuffer },
  { readUdpDump },
] = await Promise.all([
  import("@raceiq/game-catalogs/games/init"),
  import("../../src/games/init"),
  import("@raceiq/backend-core/telemetry/live-pipeline"),
  import("@raceiq/backend-core/telemetry/pipeline-ports"),
  import("@raceiq/backend-core/games/registry"),
  import("@raceiq/backend-core/session-capture/framing"),
  import("@raceiq/backend-core/test-support/recordings/parse-dump"),
  import("@raceiq/shared/games/registry"),
  import("@raceiq/game-fm-2023/test-support/recordings"),
  import("@raceiq/game-fm-2023/parser"),
  import("@raceiq/game-f1-2025/test-support/recordings"),
  import("@raceiq/game-acc/test-support/recordings"),
  import("@raceiq/game-ac-evo/test-support/recordings"),
  import("@raceiq/game-iracing/test-support/recordings"),
  import("@raceiq/game-lmu/test-support/recordings"),
  import("@raceiq/capture-formats/iracing/dump"),
  import("@raceiq/capture-formats/lmu/dump"),
  import("@raceiq/backend-core/test-support/recordings/udp"),
]);
const fixtures = [
  { gameId: "fm-2023", path: "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz", support: fmRecordingSupport },
  { gameId: "f1-2025", path: "test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz", support: f1RecordingSupport },
  { gameId: "acc", path: "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz", support: accRecordingSupport },
  { gameId: "ac-evo", path: "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz", support: acEvoRecordingSupport },
  { gameId: "iracing", path: "test/artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz", support: iracingRecordingSupport },
  { gameId: "lmu", path: "test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz", support: lmuRecordingSupport },
  { gameId: "fm-2023", path: "test/artifacts/sessions/fm-2023-with-pitting.bin.gz", support: fmRecordingSupport, scenario: "Forza provisional snapshot and retraction" },
] as const;
initGameAdapters();
initServerGameAdapters();
// Keep DB initialization inside the same isolated module-loading boundary.
const { initDb, client } = await import("@raceiq/backend-core/db/index");
await initDb();
const games: Record<string, unknown>[] = [];
try {
for (const fixture of fixtures) {
  const fixtureBytes = readFileSync(fixture.path);
  const support = fixture.support as RecordingGameSupport;
  const replay = await parseDump(support, fixture.path, { capturePackets: true });
  const events: JournalEvent[] = [];
  const addEvent = (kind: string, data: unknown) => {
    events.push({ sequence: events.length, kind, data: JSON.parse(stable(data)) });
  };
  const dbCapture = new CapturingDbAdapter();
  const provisionalBuffers: Array<{ sessionId: number; signatures: string[]; active: boolean; consumed: boolean }> = [];
  const analysisBuffers: Array<{ sessionId: number; lapTime: number; signatures: string[]; consumed: boolean }> = [];
  const originalAdapter = getServerGame(fixture.gameId);
  const instrumentedAdapter = Object.create(originalAdapter) as typeof originalAdapter;
  instrumentedAdapter.createLapDetector = (options) => {
    const detector = originalAdapter.createLapDetector({
      ...options,
      callbacks: {
        ...options.callbacks,
        onLapComplete: (event) => {
          const signatures = event.packets.map(signature);
          analysisBuffers.push({ sessionId: dbCapture.sessions.length, lapTime: event.lapTime, signatures, consumed: false });
          addEvent("LAP_ANALYSIS_CAPTURED", {
            sessionId: dbCapture.sessions.length,
            lapTime: event.lapTime,
            isValid: event.isValid,
            lapDistStart: event.lapDistStart,
            packetCount: signatures.length,
            analysisPacketSignatureHash: sha256(Buffer.from(signatures.join("\n"))),
          });
          options.callbacks?.onLapComplete?.(event);
        },
      },
    });
    const snapshot = detector.snapshotIncompleteLap;
    if (snapshot) {
      detector.snapshotIncompleteLap = async () => {
        const internals = detector as unknown as DetectorInternals;
        const signatures = (internals.lapBuffer ?? []).map(signature);
        const candidate = { sessionId: dbCapture.sessions.length, signatures, active: true, consumed: false };
        provisionalBuffers.push(candidate);
        addEvent("LAP_PROVISIONAL_ANALYSIS_CAPTURED", {
          sessionId: candidate.sessionId,
          packetCount: signatures.length,
          analysisPacketSignatureHash: sha256(Buffer.from(signatures.join("\n"))),
        });
        try {
          await snapshot.call(detector);
        } finally {
          candidate.active = false;
        }
      };
    }
    return detector;
  };
  registerServerGame(instrumentedAdapter);
  const sparseRecorder = new SparseSessionRecorderAdapter();
  const outputRecordOffsets: OutputRecord[] = [];
  const outputPaths = new Set<string>();
  let currentInputOffset = -1;
  const recorder = new Proxy(sparseRecorder, {
    get(target, property, receiver) {
      if (property === "start") return (gameId: typeof fixture.gameId) => {
        target.start(gameId);
        if (target.path) outputPaths.add(target.path);
      };
      if (property === "writeRecord") return (frame: Buffer, frameTimeMs?: number) => {
        outputRecordOffsets.push({ inputOffset: currentInputOffset, outputOffset: target.getCurrentByteOffset(), path: target.path });
        target.writeRecord(frame, frameTimeMs);
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const sessionCapturePaths = new Map<number, string>();
  const db = new Proxy(dbCapture, {
    get(target, property, receiver) {
      if (property === "updateSessionRawFile") return async (...args: Parameters<typeof dbCapture.updateSessionRawFile>) => {
        sessionCapturePaths.set(args[0], args[1]);
        await target.updateSessionRawFile(...args);
      };
      if (property === "insertSession") return async (...args: Parameters<typeof dbCapture.insertSession>) => {
        const id = await target.insertSession(...args);
        addEvent("SESSION_STARTED", {
          sessionId: id,
          carOrdinal: args[0],
          trackOrdinal: args[1],
          gameId: args[2],
          sessionType: args[3],
          identity: args[6] ?? null,
        });
        return id;
      };
      if (property === "insertLap") return async (...args: Parameters<typeof dbCapture.insertLap>) => {
        const id = await target.insertLap(...args);
        const replayLap = replay.laps.find((lap) => lap.sessionId === args[0] && lap.lapNumber === args[1] && lap.lapTime === args[2]);
        const provisionalAnalysis = provisionalBuffers.find((candidate) => candidate.active && !candidate.consumed && candidate.sessionId === args[0]);
        if (provisionalAnalysis) provisionalAnalysis.consumed = true;
        const exactAnalysis = analysisBuffers.find((candidate) => !candidate.consumed && candidate.sessionId === args[0] && candidate.lapTime === args[2]);
        if (exactAnalysis) exactAnalysis.consumed = true;
        const analysisPacketSignatures = provisionalAnalysis?.signatures ?? exactAnalysis?.signatures ?? replayLap?.packets.map(signature) ?? [];
        addEvent("LAP_RECORDED", {
          lapId: id,
          sessionId: args[0],
          lapNumber: args[1],
          lapTime: args[2],
          isValid: args[3],
          invalidReason: args[8],
          rawByteOffset: args[4],
          rawFrameCount: args[5],
          analysisPacketCount: analysisPacketSignatures.length,
          analysisPacketSignatureHash: sha256(Buffer.from(analysisPacketSignatures.join("\n"))),
          analysisSource: provisionalAnalysis ? "detector provisional buffer" : exactAnalysis ? "detector callback" : replayLap ? "parseDump helper segment match" : "unavailable",
        });
        return id;
      };
      if (property === "deleteLap") return async (lapId: number) => {
        await target.deleteLap(lapId);
        addEvent("LAP_RETRACTED", { lapId });
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const wsCapture = new CapturingWsAdapter(false);
  const ws = new Proxy(wsCapture, {
    get(target, property, receiver) {
      if (property === "broadcastNotification") return (event: Record<string, unknown>) => {
        target.broadcastNotification(event);
        addEvent("NOTIFICATION", event);
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pipeline = new LiveTelemetryPipeline(db, ws, { bypassPacketRateFilter: true, recorder });
  const packetSignatureHash = createHash("sha256");
  let sourceRecordCount = 0;
  let sourceFrameCount = 0;
  let rejectedSourceFrames = 0;
  let processedPackets = 0;
  let active = false;
  let identity: { carOrdinal: number | null; trackOrdinal: number | null; carModel: string | null; trackName: string | null } = {
    carOrdinal: null, trackOrdinal: null, carModel: null, trackName: null,
  };
  const unsupportedScenarios: string[] = [];
  for (const source of readSourceFrames(fixture.path, support)) {
    sourceRecordCount++;
    if ("kind" in source) {
      addEvent("SOURCE_SEGMENT_MARKER", { offset: source.inputOffset, marker: source.kind });
      if (source.kind === "unsupported-source") {
        unsupportedScenarios.push(source.reason ?? "unsupported source format");
      } else {
        unsupportedScenarios.push(`segment marker ${source.kind} at source offset ${source.inputOffset}: LiveTelemetryPipeline replay has no segment-control API`);
      }
      continue;
    }
    sourceFrameCount++;
    currentInputOffset = source.inputOffset;
    if (!source.packet) {
      rejectedSourceFrames++;
      if (fixture.gameId === "fm-2023" && active && isForzaRaceOffPacket(source.frame)) {
        active = false;
        await pipeline.snapshotIncompleteLap();
      }
      continue;
    }
    active = true;
    const frameSignature = signature(source.packet);
    packetSignatureHash.update(frameSignature);
    packetSignatureHash.update("\n");
    processedPackets++;
    identity = {
      carOrdinal: source.packet.CarOrdinal ?? null,
      trackOrdinal: source.packet.TrackOrdinal ?? null,
      carModel: source.packet.iracing?.carName ?? getGame(fixture.gameId).getCarName(source.packet.CarOrdinal) ?? null,
      trackName: source.packet.iracing?.trackName ?? getGame(fixture.gameId).getTrackName(source.packet.TrackOrdinal) ?? null,
    };
    await pipeline.processPacket(source.packet, source.frame, source.frameTimeMs);
  }
  await pipeline.finalizeCurrentSession();
  await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 0));
  for (const event of events) {
    if (event.kind !== "LAP_RECORDED" || !event.data || typeof event.data !== "object") continue;
    const data = event.data as Record<string, unknown>;
    if (typeof data.rawByteOffset !== "number" || typeof data.rawFrameCount !== "number") continue;
    const rawByteOffset = data.rawByteOffset;
    const capturePath = sessionCapturePaths.get(Number(data.sessionId));
    const firstRecord = outputRecordOffsets.find((record) => record.path === capturePath && record.outputOffset === rawByteOffset);
    if (!firstRecord) continue;
    const sourceWindow = outputRecordOffsets
      .filter((record) => record.path === firstRecord.path && record.outputOffset >= rawByteOffset)
      .slice(0, data.rawFrameCount)
      .map((record) => ({ sourceOffset: record.inputOffset, outputOffset: record.outputOffset }));
    data.sourceWindow = {
      count: sourceWindow.length,
      first: sourceWindow[0] ?? null,
      last: sourceWindow.at(-1) ?? null,
      sha256: sha256(Buffer.from(stable(sourceWindow))),
    };
  }
  for (const retract of events.filter((event) => event.kind === "LAP_RETRACTED")) {
    const retractedId = retract.data && typeof retract.data === "object" ? (retract.data as Record<string, unknown>).lapId : undefined;
    const provisional = events.find((event) => event.kind === "LAP_RECORDED" && event.data && typeof event.data === "object" && (event.data as Record<string, unknown>).lapId === retractedId);
    if (provisional) {
      provisional.kind = "LAP_PROVISIONAL";
      (provisional.data as Record<string, unknown>).provisional = true;
    }
  }
  const captureFiles: Array<{ byteLength: number; sparseBytesSha256: string; headerFrameCount: number | null; headerCountMatches: boolean | null; decodedFrameCount: number; timestampedFrameCount: number; frameTimeMsSha256: string; decodedFramesSha256: string }> = [];
  for (const capturePath of outputPaths) {
    const capture = readFileSync(capturePath);
    const records = [...iterateSessionCaptureRecords(capture)].filter((record) => record.kind === "frame");
    const timedRecords = records.filter((record) => record.frameTimeMs !== undefined);
    const frameTimes = timedRecords.map((record) => record.frameTimeMs!.toString()).join("\n");
    const headerFrameCount = capture.length >= 12 && capture.readUInt32LE(0) === 0xffffffff && capture.readUInt32LE(4) === 4
      ? capture.readUInt32LE(8)
      : null;
    captureFiles.push({
      byteLength: capture.length,
      sparseBytesSha256: sha256(capture),
      headerFrameCount,
      headerCountMatches: headerFrameCount === null ? null : headerFrameCount === records.length,
      decodedFrameCount: records.length,
      timestampedFrameCount: timedRecords.length,
      frameTimeMsSha256: sha256(Buffer.from(frameTimes)),
      decodedFramesSha256: sha256(Buffer.concat(records.map((record) => record.frame))),
    });
  }
  games.push({
    gameId: fixture.gameId,
    scenario: "scenario" in fixture ? fixture.scenario : null,
    fixture: fixture.path,
    fixtureSha256: sha256(fixtureBytes),
    compressedBytes: fixtureBytes.length,
    sourceRecordCount,
    sourceFrameCount,
    rejectedSourceFrames,
    processedPacketWindow: { first: 0, count: processedPackets, last: processedPackets - 1 },
    identity,
    orderedEvents: events,
    packetSignatureHash: packetSignatureHash.digest("hex"),
    sparseCaptureFiles: captureFiles,
    unsupportedScenarios: sourceFrameCount === 0
      ? [...unsupportedScenarios, "fixture container produced no source frames through supported source readers"]
      : unsupportedScenarios,
  });
  registerServerGame(originalAdapter);
}
} finally {
  stopMaintenanceTasks();
  client.close();
  rmSync(temporaryDataDir, { recursive: true, force: true });
}
const manifest = {
  schemaVersion: 1,
  capturedAt: "NORMALIZED",
  normalization: { fixtureFilePaths: "relative manifest paths", captureFilePaths: "omitted", generatedDataDir: "omitted", generatedDatabaseTimes: "createdAt omitted", packetWallClock: "Kunos synthesized TimestampMS and host timestamp omitted only from packet signatures", nativeTiming: "preserved", detectorDatabaseIds: "deterministic CapturingDbAdapter sequence" },
  games,
};
const destination = resolve(outputArg);
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Recorder behavioral baseline written: ${destination}`);
