import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { deleteLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";

const SHUTDOWN_DRAIN_CHILD = String.raw`
const { initDb, closeDb } = await import("@raceiq/backend-core/db/index");
await initDb();
try {
  const { initGameAdapters } = await import("@raceiq/game-catalogs/games/init");
  const { registerServerGame } = await import("@raceiq/backend-core/games/registry");
  const { lmuServerAdapter } = await import("@raceiq/game-lmu");
  initGameAdapters();
  registerServerGame(lmuServerAdapter);
  const { makeLmuOpponentCapture } = await import("@raceiq/game-lmu/test-support/opponents");
  const { importSessionBin } = await import("@raceiq/backend-core/session-capture/import-capture");
  const runtime = await import("@raceiq/backend-core/session-capture/lmu-opponent-index-runtime");
  const { MessageChannel } = await import("node:worker_threads");
  const { getLapReplaySource } = await import("@raceiq/backend-core/db/telemetry-replay-storage");
  const imported = await importSessionBin(makeLmuOpponentCapture({ identity: "shutdown-" + crypto.randomUUID() }), "lmu", { notifyDriverProfile: false });
  const lapSource = await getLapReplaySource(imported.laps[0].lapId);
  if (!lapSource) throw new Error("Missing source after import");
  const source = { ...lapSource, rawFile: lapSource.captureManifestFile ?? lapSource.rawFile };
  if (!source.rawFile) throw new Error("Missing capture source path after import");
  const channel = new MessageChannel();
  runtime.setLmuOpponentIndexTestPortForTest(channel.port1);
  const barrier = Promise.withResolvers();
  channel.port2.on("message", (event) => {
    if (event.type !== "barrier") return;
    if (event.name === "before-publication-fence") barrier.resolve(event.id);
    else channel.port2.postMessage({ type: "release", id: event.id });
  });
  channel.port2.start();
  const preparation = runtime.reconcileLmuOpponentIndexes({ awaitPreparation: true });
  const barrierId = await barrier.promise;
  const shutdown = runtime.stopLmuOpponentIndexRuntime();
  channel.port2.postMessage({ type: "release", id: barrierId });
  await preparation.catch(() => {});
  await shutdown;
  const status = await runtime.getLmuOpponentIndexStatus(source);
  process.stdout.write("__E6_SHUTDOWN__" + JSON.stringify({
    indexState: status.indexState, publicationPath: status.publicationPath,
  }) + "\n");
  channel.port2.close();
} finally {
  await closeDb();
}
`;

test("runtime shutdown drains gated worker before resolving", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "raceiq-opponent-shutdown-"));
  try {
    const child = spawn(process.execPath, ["-e", SHUTDOWN_DRAIN_CHILD], {
      cwd: join(process.cwd(), "apps/backend"),
      env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: "test", RACEIQ_TEST_MODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    expect(result, stderr).toEqual({ code: 0, signal: null });
    const line = stdout.split("\n").find((entry) => entry.startsWith("__E6_SHUTDOWN__"));
    expect(line, stdout + stderr).toBeTruthy();
    expect(JSON.parse(line!.slice("__E6_SHUTDOWN__".length)).indexState).not.toBe("ready");
    expect(JSON.parse(line!.slice("__E6_SHUTDOWN__".length)).publicationPath).toBeNull();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
test("relocation preserves native source and indexed opponent replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "raceiq-opponent-relocation-"));
const script = String.raw`
const { initDb, closeDb } = await import("@raceiq/backend-core/db/index");
await initDb();
const runtime = await import("@raceiq/backend-core/session-capture/lmu-opponent-index-runtime");
try {
  const { initGameAdapters } = await import("@raceiq/game-catalogs/games/init");
  const { registerServerGame } = await import("@raceiq/backend-core/games/registry");
  const { lmuServerAdapter } = await import("@raceiq/game-lmu");
  initGameAdapters();
  registerServerGame(lmuServerAdapter);
  const { makeLmuOpponentCapture } = await import("@raceiq/game-lmu/test-support/opponents");
  const { importSessionBin } = await import("@raceiq/backend-core/session-capture/import-capture");
  const { getLapReplaySource } = await import("@raceiq/backend-core/db/telemetry-replay-storage");
  const { startRecordingDirectoryMove, getRecordingDirectoryMoveStatus } = await import("@raceiq/backend-core/session-capture/relocate-recordings");
  const { replayRoutes } = await import("@raceiq/lap-replay/server");
  const { readFile } = await import("node:fs/promises");
  const imported = await importSessionBin(makeLmuOpponentCapture({ identity: "relocation-e6" }), "lmu", { notifyDriverProfile: false });
  const lapId = imported.laps[0].lapId;
  await runtime.reconcileLmuOpponentIndexes({ awaitPreparation: true });
  const sourceBefore = await getLapReplaySource(lapId);
  if (!sourceBefore) throw new Error("Missing source before relocation");
  const sourcePathBefore = sourceBefore.captureManifestFile ?? sourceBefore.rawFile;
  if (!sourcePathBefore) throw new Error("Missing source path before relocation");
  const nativeBytesBefore = await readFile(sourcePathBefore);
  const catalogResponseBefore = await replayRoutes.request("/api/laps/" + lapId + "/opponent-laps", { headers: { "X-Game-Id": "lmu" } });
  const catalogBefore = await catalogResponseBefore.json();
  if (catalogBefore.indexState !== "ready" || !catalogBefore.laps[0]) throw new Error("Fixture index was not ready before relocation: " + JSON.stringify(catalogBefore));
  const opponentLap = catalogBefore.laps[0];
  const replayPath = "/api/laps/" + lapId + "/opponent-laps/" + encodeURIComponent(opponentLap.opponentLapId) +
    "/semantic-telemetry?sourceRevision=" + encodeURIComponent(catalogBefore.sourceRevision);
  const replayBeforeResponse = await replayRoutes.request(replayPath, { headers: { "X-Game-Id": "lmu" } });
  if (replayBeforeResponse.status !== 200) throw new Error("Opponent replay unavailable before relocation: " + replayBeforeResponse.status);
  const replayBefore = await replayBeforeResponse.json();
  await startRecordingDirectoryMove(process.env.OPPONENT_MOVE_DESTINATION);
  // Relocation exposes completion only through its real status; wait for filesystem work to finish.
  while (getRecordingDirectoryMoveStatus().state === "moving") await new Promise((resolve) => setTimeout(resolve, 10));
  const move = getRecordingDirectoryMoveStatus();
  if (move.state !== "complete") throw new Error("Relocation failed: " + JSON.stringify(move));
  const sourceAfter = await getLapReplaySource(lapId);
  if (!sourceAfter) throw new Error("Missing source after relocation");
  const sourcePathAfter = sourceAfter.captureManifestFile ?? sourceAfter.rawFile;
  if (!sourcePathAfter) throw new Error("Missing relocated source path");
  await runtime.reconcileLmuOpponentIndexes({ awaitPreparation: true });
  const statusAfter = await runtime.getLmuOpponentIndexStatus(sourceAfter);
  const catalogResponseAfter = await replayRoutes.request("/api/laps/" + lapId + "/opponent-laps", { headers: { "X-Game-Id": "lmu" } });
  const catalogAfter = await catalogResponseAfter.json();
  const replayAfterResponse = await replayRoutes.request(replayPath, { headers: { "X-Game-Id": "lmu" } });
  const replayAfter = await replayAfterResponse.json();
  process.stdout.write("__E6_RELOCATION__" + JSON.stringify({
    sourcePathBefore, sourcePathAfter,
    sourceRevisionBefore: catalogBefore.sourceRevision, sourceRevisionAfter: catalogAfter.sourceRevision,
    nativeBytesPreserved: nativeBytesBefore.equals(await readFile(sourcePathAfter)),
    beforeIndexState: catalogBefore.indexState, afterIndexState: catalogAfter.indexState, statusAfter: statusAfter.indexState,
    replayBeforeStatus: replayBeforeResponse.status, replayAfterStatus: replayAfterResponse.status,
    replayPreserved: JSON.stringify(replayBefore) === JSON.stringify(replayAfter),
  }) + "\n");
} finally {
  await runtime.stopLmuOpponentIndexRuntime();
  await closeDb();
}
`;
  try {
    const child = spawn(process.execPath, ["-e", script], {
      cwd: join(process.cwd(), "apps/backend"),
      env: {
        ...process.env,
        DATA_DIR: join(root, "data"),
        OPPONENT_MOVE_DESTINATION: join(root, "moved-recordings"),
        NODE_ENV: "test",
        RACEIQ_TEST_MODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    const result = await exit;
    expect(result, stderr).toEqual({ code: 0, signal: null });
    const line = stdout.split("\n").find((entry) => entry.startsWith("__E6_RELOCATION__"));
    expect(line, stdout + stderr).toBeTruthy();
    const evidence = JSON.parse(line!.slice("__E6_RELOCATION__".length));
    expect(evidence).toMatchObject({
      nativeBytesPreserved: true,
      beforeIndexState: "ready",
      afterIndexState: "ready",
      statusAfter: "ready",
      replayBeforeStatus: 200,
      replayAfterStatus: 200,
      replayPreserved: true,
    });
    expect(evidence.sourcePathAfter).not.toBe(evidence.sourcePathBefore);
    expect(evidence.sourceRevisionAfter).toBe(evidence.sourceRevisionBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
import { getLapReplaySource } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { registerServerGame } from "@raceiq/backend-core/games/registry";
import { lmuServerAdapter } from "@raceiq/game-lmu";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import { importSessionBin } from "@raceiq/backend-core/session-capture/import-capture";
import { reconcileLmuOpponentIndexes, getLmuOpponentIndexStatus, setLmuOpponentIndexTestPortForTest, stopLmuOpponentIndexRuntime } from "@raceiq/backend-core/session-capture/lmu-opponent-index-runtime";
import { startSessionOpponentRemoval, getSessionOpponentRemovalStatus } from "@raceiq/backend-core/session-capture/opponent-removal";
import { getRecordingMaintenanceController } from "@raceiq/backend-core/session-capture/maintenance-runtime";
import type { SessionCaptureSource } from "@raceiq/backend-core/session-capture/source-loader";
async function readSessionCaptureSource(lapId: number): Promise<SessionCaptureSource> {
  const source = await getLapReplaySource(lapId);
  if (!source) throw new Error(`Missing replay source for lap ${lapId}`);
  const rawFile = source.captureManifestFile ?? source.rawFile;
  if (!rawFile) throw new Error(`Missing capture source path for lap ${lapId}`);
  return {
    rawFile: realpathSync(rawFile),
    source: source.source,
    gameId: "lmu",
    carId: source.carId ?? "",
    trackId: source.trackId ?? "",
    captureFormatVersion: source.captureFormatVersion,
  };
}





function registerLmu(): void {
  initGameAdapters();
  registerServerGame(lmuServerAdapter);
}

test("shared imported source keeps opponent blocks until its final player-lap owner is deleted", async () => {
  registerLmu();
  const imported = await importSessionBin(makeLmuOpponentCapture({ identity: `ownership-${crypto.randomUUID()}` }), "lmu", { notifyDriverProfile: false });
  const lapIds = [...new Set(imported.laps.map(({ lapId }) => lapId))];
  const sessionIds = [...new Set(imported.laps.map(({ sessionId }) => sessionId))];
  expect(lapIds.length).toBeGreaterThan(1);
  try {
    await reconcileLmuOpponentIndexes({ awaitPreparation: true });
    const source = await readSessionCaptureSource(lapIds[0]!);
    const sourcePath = source.rawFile;
    let ready = await getLmuOpponentIndexStatus(source);
    expect(ready.indexState).toBe("ready");
    expect(ready.publicationPath).toBeTruthy();
    expect(existsSync(ready.publicationPath!)).toBe(true);
    const originalSource = readFileSync(sourcePath!);
    writeFileSync(sourcePath!, Buffer.concat([originalSource, Buffer.from("rewrite")]));
    expect((await getLmuOpponentIndexStatus(source)).indexState).not.toBe("ready");
    writeFileSync(sourcePath!, originalSource);
    await reconcileLmuOpponentIndexes({ awaitPreparation: true });
    ready = await getLmuOpponentIndexStatus(source);
    expect(ready.indexState).toBe("ready");
    expect(ready.publicationPath).toBeTruthy();
    expect(existsSync(ready.publicationPath!)).toBe(true);
    expect(await deleteLap(lapIds[0]!)).toBe(true);
    const remaining = await readSessionCaptureSource(lapIds[1]!);
    expect(await getLmuOpponentIndexStatus(remaining)).toMatchObject({ indexState: "ready", publicationPath: ready.publicationPath });
    expect(existsSync(ready.publicationPath!)).toBe(true);
    for (const lapId of lapIds.slice(1)) expect(await deleteLap(lapId)).toBe(true);
    expect(existsSync(ready.publicationPath!)).toBe(false);
  } finally {
    for (const sessionId of sessionIds) await deleteSession(sessionId).catch(() => {});
  }
});

test("removal while an index worker is gated cannot republish opponent artifacts", async () => {
  registerLmu();
  const imported = await importSessionBin(makeLmuOpponentCapture({ identity: `removal-race-${crypto.randomUUID()}` }), "lmu", { notifyDriverProfile: false });
  const lapId = imported.laps[0]!.lapId;
  const sessionIds = [...new Set(imported.laps.map(({ sessionId }) => sessionId))];
  const source = await readSessionCaptureSource(lapId);
  const channel = new MessageChannel();
  const releaseTestPort = setLmuOpponentIndexTestPortForTest(channel.port1);
  try {
    const barrier = Promise.withResolvers<{ id: string; sourcePath: string }>();
    channel.port2.on("message", (event: { type?: string; name?: string; id?: string; sourcePath?: string }) => {
      if (event.type !== "barrier") return;
      if (event.name === "before-publication-fence") {
        barrier.resolve({ id: event.id!, sourcePath: event.sourcePath! });
      } else {
        channel.port2.postMessage({ type: "release", id: event.id });
      }
    });
    channel.port2.start();
    const preparation = reconcileLmuOpponentIndexes({ awaitPreparation: true });
    const held = await barrier.promise;
    expect(held.sourcePath).toBe(source.rawFile);
    await expect(startSessionOpponentRemoval({ sessionIds })).rejects.toMatchObject({
      code: "MOVE_ACTIVE",
      message: "Recording storage operation is active",
    });
    channel.port2.postMessage({ type: "release", id: held.id });
    await preparation.catch(() => {});
    const maintenance = getRecordingMaintenanceController();
    const fibersBeforeRemoval = new Set(maintenance.fibers);
    await startSessionOpponentRemoval({ sessionIds });
    const removalFibers = [...maintenance.fibers].filter((fiber) => !fibersBeforeRemoval.has(fiber));
    expect(removalFibers).toHaveLength(1);
    await Promise.all(removalFibers.map((fiber) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      fiber.addObserver(() => resolve());
      return promise;
    }));
    expect(getSessionOpponentRemovalStatus().status).toBe("success");
    const after = await getLmuOpponentIndexStatus(source);
    expect(after.indexState).not.toBe("ready");
    expect(after.publicationPath).toBeNull();
    await reconcileLmuOpponentIndexes({ awaitPreparation: true });
    const afterReconcile = await getLmuOpponentIndexStatus(source);
    expect(afterReconcile.indexState).not.toBe("ready");
    expect(afterReconcile.publicationPath).toBeNull();
  } finally {
    releaseTestPort();
    channel.port2.close();
    for (const sessionId of sessionIds) await deleteSession(sessionId).catch(() => {});
  }
});
