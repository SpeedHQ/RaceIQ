/**
 * Standalone raw telemetry recorder.
 *
 * Usage: bun run server/record.ts <gameId>
 *   e.g. bun run server/record.ts f1-2025
 *        bun run server/record.ts fm-2023
 *        bun run server/record.ts acc
 *
 * Records raw packets/frames to data/recordings/<timestamp>/ (UDP)
 * or data/acc-recordings/ (ACC, using existing AccRecorder format).
 * Does NOT start HTTP, WebSocket, lap detector, or pipeline.
 */
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "./games/init";
import { getAllServerGames, tryGetServerGame } from "./games/registry";
import { tryGetGame } from "../shared/games/registry";
import { loadSettings } from "./settings";
import { UdpRecorder } from "./udp-recorder";
import { writeRecordingMeta, type RecordingMeta } from "./record-meta";
import { resolve } from "path";
import { accRecorder } from "./games/acc/recorder";
import { PHYSICS, GRAPHICS, STATIC, AC_STATUS } from "./games/acc/structs";
import { readWString, toWideString } from "./games/acc/utils";
import { getAccCarByModel } from "../shared/acc-car-data";
import { getAccTrackByName } from "../shared/acc-track-data";

// Register all game adapters (needed for canHandle + parsing)
initGameAdapters();
initServerGameAdapters();

const gameId = process.argv[2];
if (!gameId) {
  console.error("Usage: bun run server/record.ts <gameId>");
  console.error("  Known games:", getAllServerGames().map((g) => g.id).join(", "));
  process.exit(1);
}

const serverAdapter = tryGetServerGame(gameId);
const sharedAdapter = tryGetGame(gameId);
if (!serverAdapter || !sharedAdapter) {
  console.error(`Unknown game: ${gameId}`);
  console.error("  Known games:", getAllServerGames().map((g) => g.id).join(", "));
  process.exit(1);
}

// --- Session directory ---
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const sessionDir = resolve(process.cwd(), "data", "recordings", timestamp);

const meta: RecordingMeta = {
  gameId: gameId as import("../shared/types").GameId,
  trackOrdinal: null,
  trackName: null,
  carOrdinal: null,
  carName: null,
  startedAt: new Date().toISOString(),
};

// Write initial meta immediately
writeRecordingMeta(sessionDir, meta);

if (gameId === "acc") {
  await recordAcc(sessionDir, meta);
} else {
  await recordUdp(serverAdapter, sharedAdapter, sessionDir, meta);
}

// ─── UDP recording ────────────────────────────────────────────────────────────

async function recordUdp(
  serverAdapter: NonNullable<ReturnType<typeof tryGetServerGame>>,
  sharedAdapter: NonNullable<ReturnType<typeof tryGetGame>>,
  sessionDir: string,
  meta: RecordingMeta
): Promise<void> {
  const settings = loadSettings();
  const udpPort = settings.udpPort ?? (Number(process.env.UDP_PORT) || 5301);

  const recorder = new UdpRecorder();
  recorder.start(sessionDir);

  // Parser state for metadata extraction (first ~100 packets only)
  const parserState = serverAdapter.createParserState();
  let metaResolved = false;
  let parsedCount = 0;
  const META_RESOLVE_LIMIT = 100;

  const dgram = require("dgram");
  const sock = dgram.createSocket("udp4");

  sock.on("message", (buf: Buffer) => {
    recorder.writePacket(buf);

    // Resolve track/car from first few packets
    if (!metaResolved && parsedCount < META_RESOLVE_LIMIT) {
      parsedCount++;
      try {
        const packet = serverAdapter.tryParse(buf, parserState);
        if (packet && packet.TrackOrdinal && packet.CarOrdinal) {
          meta.trackOrdinal = packet.TrackOrdinal;
          meta.carOrdinal = packet.CarOrdinal;
          meta.trackName = sharedAdapter.getTrackName(packet.TrackOrdinal) ?? null;
          meta.carName = sharedAdapter.getCarName(packet.CarOrdinal) ?? null;
          metaResolved = true;
          writeRecordingMeta(sessionDir, meta);
          console.log(`[Record] Resolved: track=${meta.trackName} car=${meta.carName}`);
        }
      } catch {
        // Ignore parse errors during metadata resolution
      }
    }
    if (!metaResolved && parsedCount === META_RESOLVE_LIMIT) {
      console.log(`[Record] Metadata not resolved after ${META_RESOLVE_LIMIT} packets — proceeding without track/car info`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    sock.bind(udpPort, "0.0.0.0", () => {
      try {
        sock.setRecvBufferSize(64 * 1024 * 1024);
      } catch {}
      resolve();
    });
    sock.on("error", reject);
  });

  console.log(`[Record] Listening on UDP :${udpPort} — game=${gameId}`);
  console.log(`[Record] Writing to ${sessionDir}`);
  console.log(`[Record] Press Ctrl+C to stop`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[Record] Stopping...");
    sock.close();
    await recorder.stop();
    // Write final meta (in case meta was never resolved, null fields stay null)
    writeRecordingMeta(sessionDir, meta);
    console.log(`[Record] Done. ${recorder.packetCount} packets recorded.`);
    process.exit(0);
  };

  sock.on("error", (err: Error) => {
    console.error("[Record] UDP socket error:", err);
    shutdown();
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ─── ACC recording ────────────────────────────────────────────────────────────

async function recordAcc(sessionDir: string, meta: RecordingMeta): Promise<void> {
  const FILE_MAP_READ = 0x0004;

  // Load kernel32.dll FFI — same calls as AccSharedMemoryReader._loadFfi()
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  type Kernel32 = {
    symbols: {
      OpenFileMappingW(access: number, inherit: boolean, name: unknown): unknown;
      MapViewOfFile(handle: unknown, access: number, offHigh: number, offLow: number, size: number): unknown;
      UnmapViewOfFile(view: unknown): boolean;
      CloseHandle(handle: unknown): boolean;
      RtlCopyMemory(dest: unknown, src: unknown, length: number): void;
    };
  };
  let kernel32: Kernel32;
  try {
    kernel32 = dlopen("kernel32.dll", {
      OpenFileMappingW: { args: [FFIType.u32, FFIType.bool, FFIType.ptr], returns: FFIType.ptr },
      MapViewOfFile: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.ptr },
      UnmapViewOfFile: { args: [FFIType.ptr], returns: FFIType.bool },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
      RtlCopyMemory: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.void },
    }) as Kernel32;
  } catch (err) {
    console.error("[Record] Failed to load kernel32.dll — ACC recording requires Windows:", err);
    process.exit(1);
  }

  const ffiPtr = ptr as (buf: Buffer) => unknown;

  type MappedFile = { handle: number; view: number; size: number };

  function openMem(name: string, size: number): MappedFile | null {
    const wideName = toWideString(name);
    const handle = kernel32.symbols.OpenFileMappingW(FILE_MAP_READ, false, ffiPtr(wideName));
    if (!handle || handle === 0) return null;
    const view = kernel32.symbols.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
    if (!view || view === 0) { kernel32.symbols.CloseHandle(handle); return null; }
    return { handle: Number(handle), view: Number(view), size };
  }

  function closeMem(mapped: MappedFile): void {
    kernel32.symbols.UnmapViewOfFile(mapped.view);
    kernel32.symbols.CloseHandle(mapped.handle);
  }

  function readMem(mapped: MappedFile): Buffer {
    const dest = Buffer.alloc(mapped.size);
    kernel32.symbols.RtlCopyMemory(ffiPtr(dest), mapped.view, mapped.size);
    return dest;
  }

  // Wait for ACC to be reachable
  console.log("[Record] Waiting for ACC shared memory...");
  let physics: MappedFile | null = null;
  let graphics: MappedFile | null = null;
  let staticMem: MappedFile | null = null;

  await new Promise<void>((resolveConn) => {
    const tryConnect = setInterval(() => {
      physics = openMem("Local\\acpmf_physics", PHYSICS.SIZE);
      graphics = openMem("Local\\acpmf_graphics", GRAPHICS.SIZE);
      staticMem = openMem("Local\\acpmf_static", STATIC.SIZE);
      if (physics && graphics && staticMem) {
        clearInterval(tryConnect);
        resolveConn();
      } else {
        if (physics) closeMem(physics);
        if (graphics) closeMem(graphics);
        if (staticMem) closeMem(staticMem);
        physics = null; graphics = null; staticMem = null;
      }
    }, 2000);
  });

  console.log("[Record] ACC shared memory connected");

  // Resolve track/car from static buffer
  const staticBuf = readMem(staticMem!);
  const carModel = readWString(staticBuf, STATIC.carModel.offset, (STATIC.carModel as { offset: number; size: number }).size);
  const trackStr = readWString(staticBuf, STATIC.track.offset, (STATIC.track as { offset: number; size: number }).size);
  const car = getAccCarByModel(carModel);
  const track = getAccTrackByName(trackStr);
  if (car) { meta.carOrdinal = car.id; meta.carName = carModel; }
  if (track) { meta.trackOrdinal = track.id; meta.trackName = trackStr; }
  writeRecordingMeta(sessionDir, meta);
  console.log(`[Record] Resolved: track=${meta.trackName ?? "unknown"} car=${meta.carName ?? "unknown"}`);

  // Start recording using existing AccRecorder (writes to data/acc-recordings/)
  const accDir = resolve(process.cwd(), "data", "acc-recordings");
  accRecorder.start(accDir);
  console.log(`[Record] ACC recording started`);
  console.log(`[Record] Meta written to ${sessionDir}`);
  console.log(`[Record] Press Ctrl+C to stop`);

  // Poll at 60Hz — write raw frames, no pipeline
  const pollTimer = setInterval(() => {
    if (!physics || !graphics || !staticMem) return;
    try {
      const physicsBuf = readMem(physics);
      const graphicsBuf = readMem(graphics);
      const graphicsStatus = graphicsBuf.readInt32LE(GRAPHICS.status.offset);
      if (graphicsStatus !== AC_STATUS.AC_LIVE) return;
      const staticBuf = readMem(staticMem);
      accRecorder.writeFrame(physicsBuf, graphicsBuf, staticBuf);
    } catch (err) {
      console.error("[Record] Error reading shared memory:", err);
    }
  }, 1000 / 60);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[Record] Stopping...");
    clearInterval(pollTimer);
    if (physics) { closeMem(physics); physics = null; }
    if (graphics) { closeMem(graphics); graphics = null; }
    if (staticMem) { closeMem(staticMem); staticMem = null; }
    await accRecorder.stop();
    writeRecordingMeta(sessionDir, meta);
    console.log(`[Record] Done. ${accRecorder.frameCount} frames recorded.`);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
