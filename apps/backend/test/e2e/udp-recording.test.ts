import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GameId } from "@raceiq/shared/games/ids";
import { ReplayedUdpDataSource } from "@raceiq/backend-core/test-support/recordings/replayed-udp-data-source";
import Database from "libsql";
import { isLiveTelemetrySchemaMessageV1, isLiveTelemetryFrameMessageV1, type LiveTelemetrySchemaMessageV1 } from "@raceiq/shared/telemetry/live/contracts";

import {
  decompressIfGzipSync,
  iterateSessionFrames,
  containsSparseCaptureFrames,
} from "@raceiq/capture-formats/session/framing";
import { killAndWait, removeProcessDirectory } from "./support/process";
const BACKEND_ENTRY = resolve(process.cwd(), "apps/backend/src/index.ts");
const RECORDING_CASES: readonly {
  gameId: GameId;
  fixture: string;
  startPacket: number;
  packetCount: number;
  serverPort: number;
  udpPort: number;
}[] = [
  {
    gameId: "fm-2023",
    fixture: "test/artifacts/sessions/fm-2023-2026-04-09T21-53-00-102Z.bin.gz",
    startPacket: 5218, // First driving sample; preceding frames are race-off menus.
    packetCount: 80,
    serverPort: 3219,
    udpPort: 15329,
  },
  {
    gameId: "f1-2025",
    fixture: "test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz",
    startPacket: 0, // Keep the session/lap/telemetry prelude required before motion can publish.
    packetCount: 476,
    serverPort: 3220,
    udpPort: 15330,
  },
];


describe("UDP recording integration", () => {
  let dataDir: string | null = null;
  let server: ChildProcess | null = null;

  afterEach(async () => {
    if (server) {
      await killAndWait(server, "SIGINT");
      server = null;
    }
    if (dataDir) {
      await removeProcessDirectory(dataDir);
      dataDir = null;
    }
  });

  for (const recordingCase of RECORDING_CASES) {
    test(`${recordingCase.gameId} dump preserves raw datagrams in one BIN and streams live without saving sessions`, async () => {
      dataDir = mkdtempSync(join(tmpdir(), `raceiq-${recordingCase.gameId}-recording-`));
      writeFileSync(
        join(dataDir, "settings.json"),
        JSON.stringify({ udpPort: recordingCase.udpPort }),
      );

      const recordingsDir = join(dataDir, "test", "artifacts", "sessions");
      server = spawn(
        "bun",
        ["run", BACKEND_ENTRY, `--record=${recordingCase.gameId}`, "--dump-only"],
        {
          cwd: dataDir,
          env: {
            ...process.env,
            DATA_DIR: dataDir,
            SERVER_PORT: String(recordingCase.serverPort),
            UDP_PORT: String(recordingCase.udpPort),
            NODE_ENV: "development",
            RACEIQ_TEST_MODE: "0",
            RACEIQ_E2E: "1",
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );

      const ready = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => ready.reject(new Error("server boot timed out")),
        30_000,
      );
      let stdout = "";
      const onData = (chunk: Buffer) => {
        stdout += chunk.toString();
        if (!stdout.includes("[UDP] Listening on")) return;
        clearTimeout(timer);
        server!.stdout!.off("data", onData);
        ready.resolve();
      };
      server.stdout!.on("data", onData);
      server.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
      server.on("exit", (code) => {
        clearTimeout(timer);
        ready.reject(
          new Error(`server exited with code ${code} before becoming ready`),
        );
      });
      await ready.promise;
      const authSetup = await fetch(`http://127.0.0.1:${recordingCase.serverPort}/api/auth/setup`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: null, exposureConfirmed: true }),
      });
      expect(authSetup.status).toBe(200);
      const socket = new WebSocket(`ws://127.0.0.1:${recordingCase.serverPort}/ws`);
      const connected = Promise.withResolvers<void>();
      const live = Promise.withResolvers<void>();
      let schema: LiveTelemetrySchemaMessageV1 | undefined;
      socket.onopen = () => connected.resolve();
      socket.onerror = () => connected.reject(new Error("Dump WebSocket failed"));
      socket.onmessage = ({ data }) => {
        const message: unknown = JSON.parse(String(data));
        if (isLiveTelemetrySchemaMessageV1(message)) schema = message;
        if (schema?.simulator === recordingCase.gameId && isLiveTelemetryFrameMessageV1(message, schema)) {
          expect(message.sessionId).toBeNull();
          live.resolve();
        }
      };
      await connected.promise;

      const source = new ReplayedUdpDataSource(recordingCase.fixture, recordingCase.packetCount, recordingCase.startPacket);
      await source.replay(recordingCase.udpPort);
      // Bound external-process WebSocket failure; its clock cannot use this runner's fake timers.
      const liveTimeout = setTimeout(() => live.reject(new Error(`No ${recordingCase.gameId} live frame received`)), 5_000);
      try { await live.promise; } finally { clearTimeout(liveTimeout); }
      socket.close();
      // UDP has no delivery acknowledgement; allow OS receive queue to drain.
      const drain = Promise.withResolvers<void>();
      setTimeout(drain.resolve, 300);
      await drain.promise;
      await killAndWait(server, "SIGINT");
      server = null;

      const createdFiles = readdirSync(recordingsDir).filter(
        (file) =>
          file.startsWith(`${recordingCase.gameId}-`) && file.endsWith(".bin"),
      );
      expect(createdFiles).toHaveLength(1);
      const createdBin = join(recordingsDir, createdFiles[0]!);
      const recordedBytes = decompressIfGzipSync(readFileSync(createdBin));
      expect(recordedBytes.readUInt32LE(8)).toBe(source.packets.length);
      expect(containsSparseCaptureFrames(recordedBytes)).toBe(false);
      const recordedFrames = [
        ...iterateSessionFrames(
          recordedBytes,
        ),
      ];
      expect(recordedFrames).toEqual([...source.packets]);
      const database = new Database(join(dataDir, "app.db"), { readonly: true });
      try {
        expect(database.prepare("SELECT count(*) AS count FROM sessions").get()?.count).toBe(0);
        expect(database.prepare("SELECT count(*) AS count FROM laps").get()?.count).toBe(0);
      } finally { database.close(); }
    }, 60_000);
  }
});
