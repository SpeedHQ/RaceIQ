import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ServerWebSocket } from "bun";
import { inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { deleteSession, insertSession, updateSessionRawFile, getCaptureMigrationCandidates } from "@raceiq/backend-core/db/session-queries";
import { sessionRoutes } from "../../src/routes/session-routes";
import { encodeFrameLength, encodeMetaFrame } from "@raceiq/capture-formats/session/framing";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { WSData, wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import { startSyncAndStaleSessionJobs } from "../../src/runtime/startup-jobs";

function socket() {
  const sent: string[] = [];
  return { data: { createdAt: Date.now(), devTelemetrySubscribed: false }, sent, send(value: string) { sent.push(value); }, close() {} } as unknown as ServerWebSocket<WSData> & { sent: string[] };
}

function capture(): Buffer {
  const frames = Array.from({ length: 40 }, (_, index) => {
    const frame = Buffer.alloc(350, 7);
    frame.writeUInt32LE(index, 0);
    return Buffer.concat([encodeFrameLength(frame.length), frame]);
  });
  return Buffer.concat([encodeMetaFrame(frames.length), ...frames]);
}

describe("capture migration consent and progress", () => {
  const directory = join(resolveDataDir(), "sessions", "fm-2023");
  const paths: string[] = [];
  const sessionIds: number[] = [];
  let corruptId: number;
  let candidateBaseline = { sessionCount: 0, captureCount: 0 };

  beforeAll(async () => {
    candidateBaseline = await getCaptureMigrationCandidates();
    await mkdir(directory, { recursive: true });
    const rawPath = join(directory, `consent-${process.pid}-${Date.now()}.bin`);
    const gzipPath = `${rawPath}.gz`;
    const corruptPath = join(directory, `consent-corrupt-${process.pid}-${Date.now()}.bin`);
    const bytes = capture();
    await writeFile(rawPath, bytes);
    await writeFile(gzipPath, gzipSync(bytes));
    await writeFile(corruptPath, Buffer.from("not a canonical capture"));
    paths.push(rawPath, gzipPath, corruptPath);
    for (const path of paths) {
      const id = await insertSession(1, 2, "fm-2023");
      sessionIds.push(id);
      await updateSessionRawFile(id, path, "test");
      if (path === corruptPath) corruptId = id;
    }
  });

  afterAll(async () => {
    for (const id of sessionIds) await deleteSession(id);
    await Promise.all(paths.map((path) => rm(path, { force: true })));
    wsManager.setCaptureMigrationNotification(0, 0);
  });

  test("status and startup notice count both encodings without converting; reconnect replays notice", async () => {
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const response = await sessionRoutes.request("/api/sessions/capture-migration-status");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessionCount: candidateBaseline.sessionCount + 3,
      captureCount: candidateBaseline.captureCount + 3,
      migrationProgress: { status: "idle", done: 0, total: 0 },
    });
    const completed = Promise.withResolvers<void>();
    const original = wsManager.setCaptureMigrationNotification.bind(wsManager);
    const noticeSpy = spyOn(wsManager, "setCaptureMigrationNotification").mockImplementation((sessionsCount, capturesCount) => {
      original(sessionsCount, capturesCount);
      completed.resolve();
    });
    try {
      startSyncAndStaleSessionJobs({
        startCommunityTunesSync: () => {},
        startSessionCompressor: () => {},
        startUpdateCheckSchedule: () => {},
        countStaleSessions: async () => 0,
        countStaleRaceResults: async () => 0,
      });
      await completed.promise;
      expect(noticeSpy).toHaveBeenCalledWith(candidateBaseline.sessionCount + 3, candidateBaseline.captureCount + 3);
      const notification = wsManager.captureMigrationNotification;
      expect(notification).toEqual({ type: "capture-migration-available", sessionCount: candidateBaseline.sessionCount + 3, captureCount: candidateBaseline.captureCount + 3 });

      const connecting = socket();
      wsManager.addClient(connecting);
      try {
        expect(connecting.sent.map((value) => JSON.parse(value))).toContainEqual(notification);
      } finally {
        wsManager.removeClient(connecting);
      }
    } finally {
      noticeSpy.mockRestore();
    }
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
    const rows = await db.select({ version: sessions.captureFormatVersion }).from(sessions).where(inArray(sessions.id, sessionIds)).all();
    expect(rows).toEqual([{ version: null }, { version: null }, { version: null }]);
  });

  test("explicit conversion reports per-capture progress and retains failed candidates for retry", async () => {
    const connected = socket();
    wsManager.addClient(connected);
    try {
      const response = await sessionRoutes.request("/api/sessions/migrate-captures", { method: "POST" });
      expect(response.status).toBe(200);
      const body = await response.json() as { migrated: number; failed: number; results: Array<{ status: string }> };
      expect(body.migrated).toBe(2);
      expect(body.failed).toBe(1);
      expect(body.results.filter(({ status }) => status === "migrated")).toHaveLength(2);
      expect(body.results.filter(({ status }) => status === "error")).toHaveLength(1);
      const progress = connected.sent.map((value) => JSON.parse(value)).filter((event) => event.type === "capture-migration-progress");
      expect(progress).toHaveLength(candidateBaseline.captureCount + 4);
      expect(progress.slice(0, -1).map((event) => event.done)).toEqual(Array.from({ length: candidateBaseline.captureCount + 3 }, (_, index) => index + 1));
      expect(progress.filter((event) => event.status === "error")).toHaveLength(1);
      const notifications = connected.sent.map((value) => JSON.parse(value));
      expect(notifications.at(-2)).toMatchObject({
        type: "capture-migration-available",
        sessionCount: candidateBaseline.sessionCount + 1,
        captureCount: candidateBaseline.captureCount + 1,
      });
      expect(notifications.at(-1)).toMatchObject({ type: "capture-migration-progress", status: "partial" });
      const migrationStatus = await (await sessionRoutes.request("/api/sessions/capture-migration-status")).json() as {
        migrationProgress: { status: string; done: number; total: number; migrated: number; failed: number };
      };
      expect(migrationStatus.migrationProgress).toMatchObject({
        status: "partial",
        done: body.migrated + body.failed,
        total: body.migrated + body.failed,
        migrated: body.migrated,
        failed: body.failed,
      });

      const retry = await sessionRoutes.request("/api/sessions/migrate-captures", { method: "POST" });
      expect(retry.status).toBe(200);
      const retryBody = await retry.json() as { migrated: number; failed: number; results: Array<{ rawFile: string; status: string }> };
      expect(retryBody.migrated + retryBody.failed).toBe(retryBody.results.length);
      expect(retryBody.failed).toBe(1);
      expect(retryBody.results).toHaveLength(candidateBaseline.captureCount + 1);
      expect(retryBody.results.find(({ rawFile }) => rawFile === paths[2])?.status).toBe("error");
    } finally {
      wsManager.removeClient(connected);
    }
    await deleteSession(corruptId);
  });
});
