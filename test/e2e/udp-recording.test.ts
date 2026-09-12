import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GameId } from "../../shared/games/ids";
import { ReplayedUdpDataSource } from "../support/recordings/replayed-udp-data-source";
import { readUdpDump } from "../support/recordings/udp";

const RECORDINGS_DIR = resolve(process.cwd(), "test", "artifacts", "sessions");
const RECORDING_CASES: readonly {
  gameId: GameId;
  fixture: string;
  serverPort: number;
  udpPort: number;
}[] = [
  {
    gameId: "fm-2023",
    fixture: "test/artifacts/sessions/fm-2023-2026-04-09T21-53-00-102Z.bin.gz",
    serverPort: 3219,
    udpPort: 15329,
  },
  {
    gameId: "f1-2025",
    fixture: "test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz",
    serverPort: 3220,
    udpPort: 15330,
  },
];

async function killAndWait(
  proc: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs = 10_000,
): Promise<void> {
  const { promise, resolve: resolveExit, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => reject(new Error(`process did not exit within ${timeoutMs}ms`)),
    timeoutMs,
  );
  proc.on("exit", () => {
    clearTimeout(timer);
    resolveExit();
  });
  proc.kill(signal);
  return promise;
}

describe("UDP recording integration", () => {
  let dataDir: string | null = null;
  let createdBin: string | null = null;
  let server: ChildProcess | null = null;

  afterEach(async () => {
    if (server) {
      await killAndWait(server, "SIGINT");
      server = null;
    }
    if (createdBin) {
      try {
        unlinkSync(createdBin);
      } catch {}
      createdBin = null;
    }
    if (dataDir) {
      // Windows sometimes holds file handles briefly after spawned server exits.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          rmSync(dataDir, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt === 9) throw error;
          const retry = Promise.withResolvers<void>();
          setTimeout(retry.resolve, 200);
          await retry.promise;
        }
      }
      dataDir = null;
    }
  });

  for (const recordingCase of RECORDING_CASES) {
    test(`${recordingCase.gameId} replays a healthy capture through the live recorder`, async () => {
      dataDir = mkdtempSync(join(tmpdir(), `raceiq-${recordingCase.gameId}-recording-`));
      writeFileSync(
        join(dataDir, "settings.json"),
        JSON.stringify({ udpPort: recordingCase.udpPort }),
      );

      const existingBefore = new Set(
        readdirSync(RECORDINGS_DIR).filter(
          (file) =>
            file.startsWith(`${recordingCase.gameId}-`) && file.endsWith(".bin"),
        ),
      );
      server = spawn(
        "bun",
        ["run", "server/index.ts", `--record=${recordingCase.gameId}`],
        {
          env: {
            ...process.env,
            DATA_DIR: dataDir,
            SERVER_PORT: String(recordingCase.serverPort),
            UDP_PORT: String(recordingCase.udpPort),
            NODE_ENV: "development",
          },
          stdio: ["ignore", "pipe", "pipe"],
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

      const source = new ReplayedUdpDataSource(recordingCase.fixture, 80);
      expect(source.packets.length).toBeGreaterThan(0);
      await source.replay(recordingCase.udpPort);
      // UDP has no delivery acknowledgement; allow OS receive queue to drain.
      const drain = Promise.withResolvers<void>();
      setTimeout(drain.resolve, 300);
      await drain.promise;
      await killAndWait(server, "SIGINT");
      server = null;

      const createdFile = readdirSync(RECORDINGS_DIR).find(
        (file) =>
          file.startsWith(`${recordingCase.gameId}-`) &&
          file.endsWith(".bin") &&
          !existingBefore.has(file),
      );
      expect(
        createdFile,
        `expected a new ${recordingCase.gameId}-*.bin in ${RECORDINGS_DIR}`,
      ).toBeTruthy();
      createdBin = join(RECORDINGS_DIR, createdFile!);
      expect(readUdpDump(createdBin)).toEqual([...source.packets]);
    }, 60_000);
  }
});
