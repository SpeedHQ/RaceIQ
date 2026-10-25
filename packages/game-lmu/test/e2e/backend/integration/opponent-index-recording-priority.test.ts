import { expect, test } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import { inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { getLapReplaySource } from "@raceiq/backend-core/db/telemetry-replay-storage";
import {
  enableLmuOpponentIndexInstrumentation,
  getLmuOpponentIndexInstrumentation,
  resetLmuOpponentIndexInstrumentation,
} from "@raceiq/backend-core/session-capture/test-instrumentation";
import {
  getLmuOpponentIndexStatus,
  reconcileLmuOpponentIndexes,
  setLmuOpponentIndexTestPortForTest,
} from "@raceiq/backend-core/session-capture/lmu-opponent-index-runtime";
import { setDirectCaptureStopTestBarrierForTest } from "@raceiq/backend-core/session-capture/direct-recorder";
import { isSessionActive } from "@raceiq/backend-core/telemetry/live-pipeline";
import { resetParserState } from "@raceiq/backend-core/games/packet-dispatch";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  feedLmuOpponentFrames,
  finalizeLmuOpponentCapture,
  getLmuOpponentCaptureState,
  startLmuOpponentCapture,
} from "../../../support/opponent-ingress";

test("LMU opponent indexing waits for seal and yields across recording and draining", async () => {
  const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(({ id }) => id));
  const channel = new MessageChannel();
  const restorePort = setLmuOpponentIndexTestPortForTest(channel.port1);
  const held = new Map<string, { resolve: (fail?: boolean) => void; name: string }>();
  const events: Record<string, unknown>[] = [];
  const stopEntered = Promise.withResolvers<void>();
  const releaseStop = Promise.withResolvers<void>();
  const boundedBoundaryEntered = Promise.withResolvers<void>();
  let heldInitialBoundary = false;
  const workerYielded = Promise.withResolvers<void>();
  let recorderStopHeld = false;
  const progress = (message: string) => console.info(`[priority-handshake] ${message}`);
  const restoreStop = setDirectCaptureStopTestBarrierForTest(async (point, detail) => {
    progress(`recorder stop event: ${point}${detail ? `; ${detail}` : ""}`);
    if (point === "index-skipped-companion-failure") {
      boundedBoundaryEntered.reject(new Error(`First capture companion failed: ${detail ?? "unknown error"}`));
      return;
    }
    if (point !== "before-final-seal" || !recorderStopHeld) return;
    stopEntered.resolve();
    await releaseStop.promise;
    progress(`stop barrier released: ${point}`);
  });
  channel.port2.on("message", (event: Record<string, unknown>) => {
    events.push(event);
    if (event.type === "barrier") {
      const id = String(event.id);
      const name = String(event.name);
      held.set(id, { name, resolve: (fail = false) => {
        progress(`barrier ${fail ? "fail" : "release"}: ${name}`);
        channel.port2.postMessage({ type: fail ? "fail" : "release", id });
      } });
      progress(`barrier entered: ${name}`);
      if (name === "bounded-block-boundary") {
        if (!heldInitialBoundary) {
          heldInitialBoundary = true;
          boundedBoundaryEntered.resolve();
        } else {
          held.get(id)!.resolve();
        }
      } else {
        held.get(id)!.resolve();
      }
    }
    if (event.type === "source-status") {
      progress(`source status: ${JSON.stringify(event)}`);
    }
    if (event.type === "scheduler-enqueue") {
      progress(`scheduler enqueue: ${String(event.sourcePath)}`);
    }
    if (event.type === "scheduler-enqueue-ignored") {
      progress(`scheduler enqueue ignored: ${String(event.sourcePath)} reason=${String(event.reason)}`);
    }
    if (event.type === "scheduler-request") {
      progress(`requested source: ${String(event.sourcePath)} status=${String(event.indexState)} retention=${JSON.stringify(event.retention)} candidate=${String(event.candidate)} recording=${String(event.recordingOrDraining)}`);
    }
    if (event.type === "worker-yielded") {
      progress("worker yielded");
      workerYielded.resolve();
    }
  });
  channel.port2.start();
  let firstFinalized = false;
  let secondStarted = false;
  try {
    progress("starting first capture");
    await startLmuOpponentCapture(`priority-first-${crypto.randomUUID()}`);
    await feedLmuOpponentFrames();
    progress("first capture frames fed; reading laps");
    const active = await getLmuOpponentCaptureState();
    expect(active.lapIds.length).toBeGreaterThan(1);
    const firstLaps = await Promise.all(active.lapIds.map((lapId) => getLapReplaySource(lapId)));
    const firstLap = firstLaps[0];
    if (!firstLap || firstLaps.some((lap) => !lap || (lap.captureManifestFile ?? lap.rawFile) !== (firstLap.captureManifestFile ?? firstLap.rawFile))) {
      throw new Error("Controlled recording laps do not share one physical capture source");
    }
    const firstSource = {
      rawFile: firstLap.captureManifestFile ?? firstLap.rawFile!, source: firstLap.source,
      gameId: "lmu" as const, carId: firstLap.carId ?? "", trackId: firstLap.trackId ?? "",
      captureFormatVersion: firstLap.captureFormatVersion,
    };
    expect((await getLmuOpponentIndexStatus(firstSource)).indexState).toBe("waiting-finalization");
    expect(await reconcileLmuOpponentIndexes()).toBe("pending");
    expect((await getLmuOpponentIndexStatus(firstSource)).publicationPath).toBeNull();

    enableLmuOpponentIndexInstrumentation(true);
    resetLmuOpponentIndexInstrumentation();
    const firstSeal = finalizeLmuOpponentCapture().then(() => {
      firstFinalized = true;
      progress("first seal resolved");
    }, (error) => {
      progress(`first seal rejected: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
    progress("first seal started; waiting for first bounded boundary");
    await boundedBoundaryEntered.promise;
    progress("first bounded boundary observed; waiting for seal completion");
    await firstSeal;
    progress("first seal completed");
    expect(firstFinalized).toBe(true);

    progress("starting second capture");
    secondStarted = true;
    const secondFeed = (async () => {
      await startLmuOpponentCapture(`priority-second-${crypto.randomUUID()}`);
      return feedLmuOpponentFrames(3);
    })();
    let recordingIntentActive = isSessionActive();
    while (!recordingIntentActive) {
      const nextTurn = Promise.withResolvers<void>();
      setImmediate(nextTurn.resolve);
      await nextTurn.promise;
      recordingIntentActive = isSessionActive();
    }
    expect(recordingIntentActive).toBe(true);
    progress("second capture intent active; releasing worker boundary");
    const boundary = [...held.values()].find((barrier) => barrier.name === "bounded-block-boundary");
    if (!boundary) throw new Error("Worker did not expose bounded admission barrier");
    const beforeYield = getLmuOpponentIndexInstrumentation();
    boundary.resolve();
    progress("bounded boundary released; waiting for worker yield");
    await workerYielded.promise;
    const yielded = getLmuOpponentIndexInstrumentation();
    expect(yielded.sourceFramesScanned - beforeYield.sourceFramesScanned).toBeLessThanOrEqual(256);
    await secondFeed;
    progress("second capture frames fed");
    expect((await getLmuOpponentIndexStatus(firstSource)).indexState).toBe("queued");

    progress("worker yielded; checking second stop barrier");
    recorderStopHeld = true;
    const secondSeal = finalizeLmuOpponentCapture();
    progress("second seal started; waiting for recorder stop barrier");
    await stopEntered.promise;
    const whileDraining = getLmuOpponentIndexInstrumentation();
    expect(whileDraining).toMatchObject({
      sourceFramesScanned: yielded.sourceFramesScanned,
      playerPacketsDecoded: yielded.playerPacketsDecoded,
      framesDecoded: yielded.framesDecoded,
      blocksWritten: yielded.blocksWritten,
      bytesWritten: yielded.bytesWritten,
    });
    expect((await getLmuOpponentIndexStatus(firstSource)).indexState).toBe("queued");
    releaseStop.resolve();
    progress("second recorder barrier released; waiting for finalization");
    recorderStopHeld = false;
    await secondSeal;
    progress("second capture finalized; awaiting index preparation");
    secondStarted = false;
    expect(await reconcileLmuOpponentIndexes({ awaitPreparation: true })).toBe("ready");
    const sharedStatuses = await Promise.all(firstLaps.map((lap) => getLmuOpponentIndexStatus({
      rawFile: lap!.captureManifestFile ?? lap!.rawFile!, source: lap!.source, gameId: "lmu" as const,
      carId: lap!.carId ?? "", trackId: lap!.trackId ?? "", captureFormatVersion: lap!.captureFormatVersion,
    })));
    expect(sharedStatuses.every((status) => status.indexState === "ready" &&
      status.publicationPath === sharedStatuses[0]!.publicationPath)).toBe(true);
    expect(await reconcileLmuOpponentIndexes({ awaitPreparation: true })).toBe("ready");
    expect((await getLmuOpponentIndexStatus(firstSource)).publicationPath).toBe(sharedStatuses[0]!.publicationPath);
    expect((await getLmuOpponentIndexStatus(firstSource)).indexState).toBe("ready");
    expect(events.filter((event) => event.type === "worker-yielded")).toHaveLength(1);

  } finally {
    releaseStop.resolve();
    for (const [id, barrier] of held) barrier.resolve();
    restoreStop();
    restorePort();
    channel.port1.close();
    enableLmuOpponentIndexInstrumentation(false);
    channel.port2.close();
    if (secondStarted) await finalizeLmuOpponentCapture().catch(() => {});
    else if (!firstFinalized) await finalizeLmuOpponentCapture().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter(({ id }) => !before.has(id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map(({ id }) => id))).run();
    for (const row of created) if (row.rawFile) {
      const manifest = row.captureManifestFile ?? row.rawFile;
      await rm(manifest.endsWith("manifest.json") ? dirname(manifest) : row.rawFile, { recursive: manifest.endsWith("manifest.json"), force: true });
    }
    resetParserState("lmu");
  }
}, 60_000);
