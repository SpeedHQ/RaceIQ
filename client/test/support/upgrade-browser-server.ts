import { cp, mkdtemp, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import dgram from "node:dgram";
import Database from "libsql";
import type { Subprocess } from "bun";
import { SparseSessionRecorder } from "../../../packages/capture-formats/src/session/sparse-recorder";
import { iterateSessionFrames } from "../../../packages/capture-formats/src/session/framing";
import { createAccMigrationFixture, seedReleaseDatabase } from "../../../apps/backend/test/e2e/support/release-database";
import { cloneReleaseData } from "../../../apps/backend/test/e2e/support/clone-release-data";
import { ROOT, startUpgradeServer, type UpgradeServer, command, upgradeEnvironment } from "../../../apps/backend/test/e2e/support/upgrade-server";

// Owned child process for Playwright: real upgraded DB, production boot, and incumbent Vite UI.
const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-browser-"));
const dataDir = join(directory, "data");
let backend: UpgradeServer | undefined;
let frontend: Subprocess<"ignore", "pipe", "pipe"> | undefined;
let frontendDrained: Promise<void[]> | undefined;
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
  const udpReservation = dgram.createSocket("udp4");
  await new Promise<void>((resolve, reject) => { udpReservation.once("error", reject); udpReservation.bind(0, "127.0.0.1", resolve); });
  const boundUdp = udpReservation.address();
  if (typeof boundUdp === "string") throw new Error("UDP did not bind an IP port");
  const udpPort = boundUdp.port;
  await new Promise<void>((resolve) => udpReservation.close(() => resolve()));
  const settingsPath = join(dataDir, "settings.json");
  const initialSettings = await Bun.file(settingsPath).json();
  await Bun.write(settingsPath, JSON.stringify({ ...initialSettings, udpPort }));
  const backendEnv = { RACEIQ_UPGRADE_UDP_PORT: String(udpPort) };
  backend = startUpgradeServer(dataDir, backendEnv);
  let address = await backend.address();
  let response = await fetch(`${address}/api/auth/setup`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: address },
    body: JSON.stringify({ password: null, exposureConfirmed: true }),
  });
  if (!response.ok && response.status !== 409) throw new Error(`Setup failed: ${response.status} ${await response.text()}`);
  await backend.stop();

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
  backend = startUpgradeServer(dataDir, { ...backendEnv, RACEIQ_UPGRADE_HTTP_PORT: new URL(address).port });
  address = await backend.address();
  // Use the project's standard Node Vite runtime; Bun's HTTP upgrade proxy can hang.
  const viteCli = join(dirname(Bun.resolveSync("vite/package.json", join(ROOT, "client"))), "bin/vite.js");
  frontend = Bun.spawn(["node", viteCli, "--host", "127.0.0.1", "--port", "0"], {
    cwd: join(ROOT, "client"), env: { ...process.env, NODE_ENV: "development", PROXY_TARGET: address, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const frontendReady = Promise.withResolvers<string>();
  let frontendOutput = "";
  const consumeFrontend = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      frontendOutput += text;
      process.stdout.write(text);
      const match = /Local:\s+(http:\/\/[^\s]+)/.exec(frontendOutput);
      if (match) frontendReady.resolve(new URL(match[1]!).origin);
    }
  };
  frontendDrained = Promise.all([consumeFrontend(frontend.stdout), consumeFrontend(frontend.stderr)]);
  void frontend.exited.then((code) => frontendReady.reject(new Error(`Vite exited ${code}:\n${frontendOutput}`)));
  AbortSignal.timeout(120_000).addEventListener("abort", () => frontendReady.reject(new Error(`Vite readiness timed out:\n${frontendOutput}`)), { once: true });
  const browserAddress = await frontendReady.promise;
  const access = await fetch(`${address}/api/auth/status`).then((result) => result.json());
  if (!access.network || !Array.isArray(access.network.hosts) || !access.network.hosts.every((host: unknown) => typeof host === "string")) throw new Error("Missing saved listener hosts");
  response = await fetch(`${address}/api/auth/network`, {
    method: "PUT", headers: { "Content-Type": "application/json", Origin: address },
    body: JSON.stringify({ hosts: access.network.hosts, origins: [browserAddress], originsEnabled: true }),
  });
  if (!response.ok) throw new Error(`Network setup failed: ${response.status} ${await response.text()}`);
  const backendPort = new URL(address).port;
  await backend.stop();
  backend = startUpgradeServer(dataDir, { ...backendEnv, RACEIQ_UPGRADE_HTTP_PORT: backendPort });
  address = await backend.address();
  console.log(`UPGRADE_BROWSER_READY=${JSON.stringify({ address: browserAddress, backend: address, dataDir })}`);
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === "repair") {
      await cp(repairBackup, missing);
      console.log("UPGRADE_CONTROL=repair");
    } else if (line === "stop-backend") {
      await backend.stop();
      console.log("UPGRADE_CONTROL=stop-backend");
    } else if (line === "start-backend") {
      backend = startUpgradeServer(dataDir, { ...backendEnv, RACEIQ_UPGRADE_HTTP_PORT: backendPort });
      await backend.address();
      console.log("UPGRADE_CONTROL=start-backend");
    } else if (line === "quit") break;
  }
} finally {
  await backend?.stop();
  if (frontend?.exitCode === null) frontend.kill();
  await frontend?.exited;
  await frontendDrained;
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
