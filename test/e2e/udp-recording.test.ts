import { describe, test, expect, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import dgram from "dgram";
import { mkdtempSync, rmSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { readUdpDump } from "../helpers/recording";

const RECORDINGS_DIR = resolve(process.cwd(), "test", "artifacts", "sessions");

async function waitFor(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function killAndWait(proc: ChildProcess, signal: NodeJS.Signals, timeoutMs = 10_000) {
  return new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)), timeoutMs);
    proc.on("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    proc.kill(signal);
  });
}

describe("UDP recording integration", () => {
  let dataDir: string | null = null;
  let createdBin: string | null = null;

  afterEach(async () => {
    if (createdBin) {
      try { unlinkSync(createdBin); } catch {}
      createdBin = null;
    }
    if (dataDir) {
      // Windows sometimes holds file handles briefly after the spawned server
      // exits — retry rmSync with a short backoff to dodge transient EBUSY.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          rmSync(dataDir, { recursive: true, force: true });
          break;
        } catch (err) {
          if (attempt === 9) throw err;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      dataDir = null;
    }
  });

  test("fm-2023 recording writes raw datagrams and finalises on SIGINT", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "raceiq-udprec-"));
    const SERVER_PORT = "3219";
    const UDP_PORT = "15329";
    // settings.udpPort has a schema default of 5301 that pre-empts the
    // UDP_PORT env var, so pre-seed settings.json with our test port.
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ udpPort: Number(UDP_PORT) }));

    const existingBefore = new Set(
      readdirSync(RECORDINGS_DIR).filter((f) => f.startsWith("fm-2023-") && f.endsWith(".bin"))
    );

    const server = spawn(
      "bun",
      ["run", "server/index.ts", "--record=fm-2023"],
      {
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          SERVER_PORT,
          UDP_PORT,
          NODE_ENV: "development",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // Wait for the UDP listener to be ready
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("server boot timed out")), 30_000);
      const onData = (chunk: Buffer) => {
        const str = chunk.toString();
        if (str.includes("[UDP] Listening on")) {
          clearTimeout(timer);
          server.stdout!.off("data", onData);
          resolvePromise();
        }
      };
      server.stdout!.on("data", onData);
      server.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
      server.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited with code ${code} before becoming ready`));
      });
    });

    // Blast 50 fake FM-shaped datagrams (324-byte Forza Dash size)
    const client = dgram.createSocket("udp4");
    const fake = Buffer.alloc(324);
    fake.writeUInt32LE(1, 0);
    const PACKET_COUNT = 50;
    for (let i = 0; i < PACKET_COUNT; i++) {
      await new Promise<void>((res, rej) =>
        client.send(fake, Number(UDP_PORT), "127.0.0.1", (err) => (err ? rej(err) : res())),
      );
    }
    await waitFor(300);
    client.close();

    // Graceful stop — the SIGINT handler should flush the recorder
    await killAndWait(server, "SIGINT");

    // Find the new .bin
    const after = readdirSync(RECORDINGS_DIR).filter((f) => f.startsWith("fm-2023-") && f.endsWith(".bin"));
    const newFile = after.find((f) => !existingBefore.has(f));
    expect(newFile, `expected a new fm-2023-*.bin in ${RECORDINGS_DIR}`).toBeTruthy();
    createdBin = join(RECORDINGS_DIR, newFile!);

    // Read back and verify packet round-trip
    const packets = readUdpDump(createdBin);
    expect(packets.length).toBe(PACKET_COUNT);
    expect(packets[0].length).toBe(324);
    expect(packets[0].readUInt32LE(0)).toBe(1);
  }, 60_000);
});
