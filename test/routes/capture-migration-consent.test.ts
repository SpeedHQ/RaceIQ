import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ServerWebSocket } from "bun";
import { inArray } from "drizzle-orm";
import { db } from "../../server/db";
import { sessions } from "../../server/db/schema";
import { deleteSession, insertSession, updateSessionRawFile, getCaptureMigrationCandidates } from "../../server/db/session-queries";
import { sessionRoutes } from "../../server/routes/session-routes";
import { encodeFrameLength, encodeMetaFrame } from "../../server/session-capture/framing";
import { resolveDataDir } from "../../server/runtime/config/data-dir";
import { WSData, wsManager } from "../../server/runtime/websocket-manager";
import { startSyncAndStaleSessionJobs } from "../../server/runtime/startup-jobs";

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
    expect(await response.json()).toEqual({ sessionCount: candidateBaseline.sessionCount + 3, captureCount: candidateBaseline.captureCount + 3 });

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
      const body = await response.json() as { migrated: number; unchanged: number; failed: number; results: Array<{ status: string }> };
      expect(body.failed).toBe(1);
      expect(body.migrated + body.unchanged).toBe(2);
      expect(body.results.filter(({ status }) => status === "error")).toHaveLength(1);
      const progress = connected.sent.map((value) => JSON.parse(value)).filter((event) => event.type === "capture-migration-progress");
      expect(progress).toHaveLength(candidateBaseline.captureCount + 3);
      expect(progress.map((event) => event.done)).toEqual(Array.from({ length: candidateBaseline.captureCount + 3 }, (_, index) => index + 1));
      expect(progress.at(-1)?.status).toBe("error");
      expect(await (await sessionRoutes.request("/api/sessions/capture-migration-status")).json()).toEqual({ sessionCount: candidateBaseline.sessionCount + 1, captureCount: candidateBaseline.captureCount + 1 });

      const retry = await sessionRoutes.request("/api/sessions/migrate-captures", { method: "POST" });
      expect(retry.status).toBe(200);
      const retryBody = await retry.json() as { failed: number; results: Array<{ status: string }> };
      expect(retryBody.failed).toBe(1);
      expect(retryBody.results).toHaveLength(candidateBaseline.captureCount + 1);
      expect(retryBody.results.some(({ status }) => status === "error")).toBe(true);
    } finally {
      wsManager.removeClient(connected);
    }
    await deleteSession(corruptId);
  });
});
