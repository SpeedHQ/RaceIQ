import { afterEach, describe, expect, test } from "bun:test";
import dgram from "node:dgram";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RecorderClient } from "../../src/runtime/recorder-client";
import { ReplayedUdpDataSource } from "@raceiq/backend-core/test-support/recordings/replayed-udp-data-source";
import { RecorderMessageDecoder, RecorderOpcode, encodeControlMessage } from "@raceiq/backend-core/runtime/recorder-protocol";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const FIXTURES = [
  { gameId: "fm-2023", path: "test/artifacts/sessions/fm-2023-2026-04-09T21-53-00-102Z.bin.gz" },
  { gameId: "f1-2025", path: "test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz" },
] as const;
const clients = new Set<RecorderClient>();
const dirs = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "raceiq-recorder-client-"));
  dirs.add(root);
  return root;
}

async function freeUdpPort(): Promise<number> {
  const socket = dgram.createSocket("udp4");
  const bound = Promise.withResolvers<number>();
  socket.once("error", bound.reject);
  socket.bind(0, "127.0.0.1", () => {
    const address = socket.address();
    if (typeof address === "string") return bound.reject(new Error("Unexpected UDP socket address"));
    socket.close(() => bound.resolve(address.port));
  });
  return bound.promise;
}

async function bindUdp(port: number): Promise<void> {
  const socket = dgram.createSocket("udp4");
  const bound = Promise.withResolvers<void>();
  socket.once("error", bound.reject);
  socket.bind(port, "127.0.0.1", () => socket.close(() => bound.resolve()));
  await bound.promise;
}

async function startClient(dataDir: string, stagingRoot: string, port: number, gameId?: string): Promise<RecorderClient> {
  const client = new RecorderClient();
  clients.add(client);
  await client.start({ dataDir, stagingRoot, udpHostname: "127.0.0.1", udpPort: port, ...(gameId ? { udpGameId: gameId } : {}) });
  return client;
}

afterEach(async () => {
  for (const client of clients) {
    try { await client.shutdown("signal"); } catch { /* Cleanup must not mask assertion failures. */ }
  }
  clients.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

describe("RecorderClient real-child lifecycle", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.gameId} drains finalization subscriber replay before child exit`, async () => {
      const root = tempRoot();
      const dataDir = join(root, "data");
      const stagingRoot = join(root, "staging");
      const port = await freeUdpPort();
      const client = await startClient(dataDir, stagingRoot, port, fixture.gameId);
      const source = new ReplayedUdpDataSource(resolve(REPO_ROOT, fixture.path));
      expect(source.packets.length).toBeGreaterThan(0);
      const packets = source.packets.filter((packet) => fixture.gameId !== "fm-2023" || packet.readInt32LE(0) === 1).slice(0, 500);
      let liveFrames = 0;
      let sessionStarted = false;
      const sessionReady = Promise.withResolvers<void>();
      let completion: Record<string, unknown> | null = null;
      let finalizedRead: Record<string, unknown> | null = null;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const unsubscribe = client.subscribe(async (event) => {
        if (event.type === "live-frame") liveFrames++;
        if (event.type !== "event") return;
        if (event.kind === "SESSION_STARTED") { sessionStarted = true; sessionReady.resolve(); }
        if (event.kind !== "RECORDING_COMPLETED") return;
        const finalized = event.data as Record<string, unknown>;
        completion = finalized;
        entered.resolve();
        await release.promise;
        const result = await client.requestFinalizationRead("read-capture", {
          jobId: "finalization-read",
          input: { path: finalized.path },
          options: { gameId: fixture.gameId },
          outputRoot: join(stagingRoot, "finalization-read"),
        }) as Record<string, unknown>;
        finalizedRead = result;
        const manifest = JSON.parse(readFileSync(String(result.resultPath), "utf8")) as { packetCount: number };
        expect(manifest.packetCount).toBeGreaterThan(0);
      });
      try {
        const sender = dgram.createSocket("udp4");
        try {
          for (const packet of packets) {
            await new Promise<void>((resolveSend, rejectSend) => sender.send(packet, port, "127.0.0.1", (error) => error ? rejectSend(error) : resolveSend()));
          }
        } finally {
          sender.close();
        }
        // Wait for actual child admission, not a guessed OS socket-drain delay.
        await sessionReady.promise;
        let shutdownDone = false;
        const stopping = client.shutdown("signal").then(() => { shutdownDone = true; });
        await entered.promise;
        expect(client.exited).toBe(false);
        await Promise.resolve();
        expect(shutdownDone).toBe(false);
        release.resolve();
        await stopping;
        expect(client.exited).toBe(true);
        expect(sessionStarted).toBe(true);
        expect(completion).not.toBeNull();
        expect(finalizedRead).not.toBeNull();
        expect(readdirSync(join(dataDir, "sessions", fixture.gameId)).some((name) => name.endsWith(".bin"))).toBe(true);
        await bindUdp(port);
      } finally {
        release.resolve();
        unsubscribe();
      }
    }, 60_000);
  }

  test("occupied UDP port fails startup; fresh client retries and idle source stays healthy", async () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    const stagingRoot = join(root, "staging");
    const occupied = dgram.createSocket("udp4");
    const bound = Promise.withResolvers<void>();
    occupied.once("error", bound.reject);
    occupied.bind(0, "127.0.0.1", bound.resolve);
    await bound.promise;
    const address = occupied.address();
    if (typeof address === "string") throw new Error("Unexpected UDP socket address");
    const port = address.port;
    let occupiedClosed = false;
    const failed = new RecorderClient();
    clients.add(failed);
    try {
      await expect(failed.start({ dataDir, stagingRoot, udpHostname: "127.0.0.1", udpPort: port })).rejects.toThrow();
      expect(failed.exited).toBe(true);
      const closed = Promise.withResolvers<void>();
      occupied.close(() => { occupiedClosed = true; closed.resolve(); });
      await closed.promise;
      const retry = await startClient(dataDir, stagingRoot, port);
      // Exercise actual 2-second health probes for >10 seconds without source datagrams.
      const idle = Promise.withResolvers<void>();
      setTimeout(idle.resolve, 10_500);
      await idle.promise;
      expect(retry.health.state).toBe("ready");
      expect(retry.exited).toBe(false);
      await retry.shutdown("signal");
      expect(retry.exited).toBe(true);
      await bindUdp(port);
    } finally {
      if (!occupiedClosed) {
        const closed = Promise.withResolvers<void>();
        occupied.close(() => { occupiedClosed = true; closed.resolve(); });
        await closed.promise;
      }
    }
  }, 30_000);
});

describe("recorder protocol framing boundaries", () => {
  test("decodes fragmented and coalesced messages, and rejects invalid lengths and truncated EOF", () => {
    const first = encodeControlMessage(RecorderOpcode.Status, 0, { state: "ready" });
    const second = encodeControlMessage(RecorderOpcode.Event, 0, { eventSequence: "1" });
    const decoder = new RecorderMessageDecoder();
    expect(decoder.push(first.slice(0, 3))).toHaveLength(0);
    expect(decoder.push(new Uint8Array([...first.slice(3), ...second]))).toHaveLength(2);
    decoder.finish();

    const invalidLength = new Uint8Array(4);
    new DataView(invalidLength.buffer).setUint32(0, 4, true);
    expect(() => new RecorderMessageDecoder().push(invalidLength)).toThrow("Invalid recorder frame length");
    const truncated = new RecorderMessageDecoder();
    truncated.push(first.slice(0, 6));
    expect(() => truncated.finish()).toThrow("truncated frame");
  });
});
