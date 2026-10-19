import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import dgram from "node:dgram";
import { spawn } from "node:child_process";
import Database from "libsql";
import { SparseSessionRecorder } from "../../../packages/capture-formats/src/session/sparse-recorder";
import { iterateSessionFrames } from "../../../packages/capture-formats/src/session/framing";
import { createAccMigrationFixture, seedReleaseDatabase } from "../../../apps/backend/test/e2e/support/release-database";
import { cloneReleaseData } from "../../../apps/backend/test/e2e/support/clone-release-data";
import { ROOT, command, upgradeEnvironment } from "../../../apps/backend/test/e2e/support/upgrade-server";

interface ProductionServer {
  address(): Promise<string>;
  stop(): Promise<void>;
}

function startProductionServer(dataDir: string, httpPort: number, udpPort: number): ProductionServer {
  const binary = resolve(ROOT, "dist", process.platform === "win32" ? "raceiq.exe" : "raceiq");
  if (!existsSync(binary)) throw new Error(`Compiled RaceIQ binary missing at ${binary}; run the production build with both release feature flags enabled.`);
  const child = spawn(binary, {
    cwd: dirname(binary),
    env: {
      ...upgradeEnvironment(dataDir), SERVER_PORT: String(httpPort), UDP_PORT: String(udpPort),
      RACEIQ_APP_ROOT: ROOT, RACEIQ_FEATURE_F1_EXPERIMENTS: "true", RACEIQ_FEATURE_IRACING_ADAPTER: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exited = false;
  let spawnError: Error | undefined;
  const consume = async (stream: NodeJS.ReadableStream) => {
    for await (const chunk of stream) {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    }
  };
  const drained = Promise.all([consume(child.stdout!), consume(child.stderr!)]);
  const exitPromise = new Promise<void>((resolve) => child.once("close", () => { exited = true; resolve(); }));
  child.once("error", (error) => { spawnError = error; exited = true; });
  const waitFor = async (predicate: () => boolean, what: string) => {
    const deadline = Date.now() + 180_000;
    while (!predicate()) {
      if (spawnError) throw new Error(`Failed to start compiled RaceIQ binary: ${spawnError.message}`);
      if (exited || Date.now() >= deadline) throw new Error(`${what} failed:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return {
    async address() {
      await waitFor(() => output.includes("[Server] RaceIQ Server is ready!"), "Production HTTP startup");
      const match = /\[Server\] HTTP\/WS server listening on (https?:\/\/[^\s]+)/.exec(output);
      if (!match) throw new Error(`Production server readiness log omitted address:\n${output}`);
      return match[1]!;
    },
    async stop() {
      if (!exited) child.kill("SIGTERM");
      await exitPromise;
      await drained;
      if (spawnError) throw new Error(`Failed to start compiled RaceIQ binary: ${spawnError.message}`);
    },
  };
}

async function reservePort(protocol: "udp4" | "tcp4"): Promise<number> {
  if (protocol === "udp4") {
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.bind(0, "127.0.0.1", resolve); });
    const address = socket.address();
    if (typeof address === "string") throw new Error("UDP did not bind an IP port");
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    return address.port;
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop();
  if (port === undefined) throw new Error("TCP did not bind a loopback port");
  return port;
}

// Owned child process for Playwright: compiled production app, packaged client, real upgraded DB.
const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-browser-"));
const dataDir = join(directory, "data");
let backend: ProductionServer | undefined;
let backendPort = 0;
let udpPort = 0;
try {
  if (process.env.RACEIQ_UPGRADE_BASELINE_DIR) {
    await cloneReleaseData(process.env.RACEIQ_UPGRADE_BASELINE_DIR, dataDir);
  } else {
    const seeded = await seedReleaseDatabase(directory, {
      gameId: "acc",
      paths: [createAccMigrationFixture(directory)],
    });
    // seedReleaseDatabase already creates directory/data.
    if (seeded.dataDir !== dataDir) throw new Error("Unexpected seed location");
  }
  const database = new Database(join(dataDir, "app.db"));
  const original = database.prepare("SELECT raw_file FROM sessions WHERE EXISTS(SELECT 1 FROM laps WHERE laps.session_id=sessions.id) ORDER BY id LIMIT 1").get() as { raw_file: string };
  const repairBackup = join(directory, "repair-backup.bin");
  await cp(original.raw_file, repairBackup);
  const missing = join(dirname(original.raw_file), "repairable.bin");
  database.prepare("UPDATE sessions SET raw_file=? WHERE raw_file=?").run(missing, original.raw_file);
  database.close();
  await rm(original.raw_file);
  udpPort = await reservePort("udp4");
  backendPort = await reservePort("tcp4");
  const settingsPath = join(dataDir, "settings.json");
  const initialSettings = await Bun.file(settingsPath).json();
  await Bun.write(settingsPath, JSON.stringify({ ...initialSettings, udpPort }));
  backend = startProductionServer(dataDir, backendPort, udpPort);
  let address = await backend.address();
  let response = await fetch(`${address}/api/auth/setup`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: address },
    body: JSON.stringify({ password: null, exposureConfirmed: true }),
  });
  if (!response.ok && response.status !== 409) throw new Error(`Setup failed: ${response.status} ${await response.text()}`);
  await backend.stop();
  backend = undefined;
  // Seed real cross-session classification data and one eligible sparse source after current-schema startup.
  const mixedDatabase = new Database(join(dataDir, "app.db"));
  const raceSessionId = Number(mixedDatabase.prepare(
    "INSERT INTO sessions (car_id,track_id,game_id,session_type,ownership) VALUES ('0','0','f1-2025','race','mine')",
  ).run().lastInsertRowid);
  const qualiSessionId = Number(mixedDatabase.prepare(
    "INSERT INTO sessions (car_id,track_id,game_id,session_type,ownership) VALUES ('0','0','f1-2025','qualifying','mine')",
  ).run().lastInsertRowid);
  mixedDatabase.prepare(
    "INSERT INTO laps (session_id,lap_number,lap_time,is_valid,classification) VALUES (?,1,70,1,'grid_start'),(?,2,71,1,'caution'),(?,1,90,1,'pace')",
  ).run(raceSessionId, raceSessionId, qualiSessionId);

  const sparsePath = join(dataDir, "sessions", "f1-2025", "own", "upgrade-regression-sparse.bin");
  const nativePath = join(ROOT, "test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz");
  const nativeBytes = gunzipSync(Buffer.from(await Bun.file(nativePath).arrayBuffer()));
  const recorder = new SparseSessionRecorder("f1-2025");
  recorder.start(sparsePath);
  recorder.writeMetaFrame();
  let rawByteOffset = recorder.getCurrentByteOffset();
  let rawFrameCount = 0;
  for (const frame of iterateSessionFrames(nativeBytes)) {
    if (rawFrameCount === 128) break;
    if (rawFrameCount === 0) rawByteOffset = recorder.getCurrentByteOffset();
    recorder.writeRecord(frame);
    rawFrameCount++;
  }
  await recorder.stop();
  if (rawFrameCount < 2) throw new Error("F1 sparse fixture lacks native frames");
  const sparseSessionId = Number(mixedDatabase.prepare(
    "INSERT INTO sessions (car_id,track_id,game_id,session_type,raw_file,capture_format_version,capture_layout_version,lap_detector_version,ownership) VALUES ('0','0','f1-2025','race',?,1,NULL,?,'mine')",
  ).run(sparsePath, null).lastInsertRowid);
  mixedDatabase.prepare(
    "INSERT INTO laps (session_id,lap_number,lap_time,is_valid,classification,raw_byte_offset,raw_frame_count) VALUES (?,1,90,1,'pace',?,?)",
  ).run(sparseSessionId, rawByteOffset, rawFrameCount);
  mixedDatabase.close();
  await command([process.execPath, "--eval", `
    import { initServerGameAdapters } from "./apps/backend/src/games/init";
    import { client, initDb } from "./server/db/index";
    import { enqueueSessionCaptureSplit } from "./server/db/session-queries";
    import { LAP_DETECTOR_ID } from "./server/lap-detection/detector";
    initServerGameAdapters();
    await initDb();
    await client.execute({ sql: "UPDATE sessions SET lap_detector_version=? WHERE id=?", args: [LAP_DETECTOR_ID, Number(process.argv[1])] });
    if (!(await enqueueSessionCaptureSplit(Number(process.argv[1])))) throw new Error("F1 sparse fixture was not enqueued");
    client.close();
  `, String(sparseSessionId)], ROOT, upgradeEnvironment(dataDir));
  backend = startProductionServer(dataDir, backendPort, udpPort);
  address = await backend.address();
  const status = await fetch(`${address}/api/auth/status`).then((result) => result.json());
  if (status.features?.f1Experiments !== true || status.features?.iracingAdapter !== true) {
    throw new Error("Compiled app missing required release features; rebuild with RACEIQ_FEATURE_F1_EXPERIMENTS=true and RACEIQ_FEATURE_IRACING_ADAPTER=true.");
  }
  console.log(`UPGRADE_BROWSER_READY=${JSON.stringify({ address, backend: address, dataDir })}`);
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === "repair") {
      await cp(repairBackup, missing);
      console.log("UPGRADE_CONTROL=repair");
    } else if (line === "stop-backend") {
      await backend.stop();
      backend = undefined;
      console.log("UPGRADE_CONTROL=stop-backend");
    } else if (line === "start-backend") {
      backend = startProductionServer(dataDir, backendPort, udpPort);
      await backend.address();
      console.log("UPGRADE_CONTROL=start-backend");
    } else if (line === "quit") break;
  }
} finally {
  await backend?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
