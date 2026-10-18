import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions, dashboardSummaryState } from "@raceiq/backend-core/db/schema";
import { deleteSession, insertSession, updateSession, updateSessionRawFile } from "@raceiq/backend-core/db/session-queries";
import { getSessionResult } from "@raceiq/backend-core/db/session-result-queries";
import { reconcileSessionResult } from "@raceiq/backend-core/race-results/reconcile";
import { encodeFrameLength, encodeMetaFrame, encodeSparseCaptureFormatFrame } from "@raceiq/capture-formats/session/framing";
import { F1_HEADER_SIZE, F1_PACKET_IDS } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { initServerGameAdapters } from "../../src/games/init";
import { sessionRoutes } from "../../src/routes/session-routes";

initServerGameAdapters();

function nativeFrame(packetId: number, body: Buffer): Buffer {
  const frame = Buffer.alloc(F1_HEADER_SIZE + body.length);
  frame.writeUInt16LE(2025, 0);
  frame.writeUInt8(25, 2);
  frame.writeUInt8(1, 3);
  frame.writeUInt8(1, 5);
  frame.writeUInt8(packetId, 6);
  frame.writeBigUInt64LE(1n, 7);
  frame.writeUInt8(255, 28);
  body.copy(frame, F1_HEADER_SIZE);
  return frame;
}

async function capture(path: string, sessionCodes: number[]): Promise<void> {
  const frames = [
    nativeFrame(F1_PACKET_IDS.MOTION, Buffer.alloc(60)),
    nativeFrame(F1_PACKET_IDS.LAP_DATA, Buffer.alloc(57)),
    nativeFrame(F1_PACKET_IDS.CAR_TELEMETRY, Buffer.alloc(60)),
    ...sessionCodes.map((code) => {
      const session = Buffer.alloc(125);
      session.writeUInt8(code, 6);
      return nativeFrame(F1_PACKET_IDS.SESSION, session);
    }),
  ];
  await Bun.write(path, Buffer.concat([encodeMetaFrame(), encodeSparseCaptureFormatFrame(), ...frames.flatMap((frame) => [encodeFrameLength(frame.length), frame])]));
}

for (const savedType of ["unknown", "qualifying-1"]) {
  test(`reprocessing repairs ${savedType} from native Race evidence without replacing laps`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "f1-type-repair-"));
    const sessionId = await insertSession("0", "0", "f1-2025", savedType);
    try {
      const path = join(directory, "session.bin");
      await capture(path, [15]);
      await updateSessionRawFile(sessionId, path, "test");
      await db.insert(laps).values({ sessionId, lapNumber: 2, lapTime: 81.5, isValid: true, classification: "pace", notes: "Keep my note", isFavorite: true });
      const before = await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all();
      const response = await sessionRoutes.request("/api/race-results/backfill", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: "f1-2025", afterSessionId: sessionId - 1, limit: 1 }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).errors).toBe(0);
      expect((await db.select().from(sessions).where(eq(sessions.id, sessionId)).get())?.sessionType).toBe("race");
      expect((await getSessionResult(sessionId, "f1-2025"))?.sessionType).toBe("race");
      expect(await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all()).toEqual(before);
      expect((await reconcileSessionResult(sessionId, "f1-2025")).status).toBe("unchanged");
      // Even an otherwise unchanged result must repair stale row metadata and invalidate its projection.
      await updateSession(sessionId, { sessionType: savedType });
      await db.update(dashboardSummaryState).set({ metadataDirty: 0 }).where(eq(dashboardSummaryState.sessionId, sessionId));
      expect((await reconcileSessionResult(sessionId, "f1-2025")).status).toBe("unchanged");
      expect((await db.select().from(sessions).where(eq(sessions.id, sessionId)).get())?.sessionType).toBe("race");
      expect((await db.select().from(dashboardSummaryState).where(eq(dashboardSummaryState.sessionId, sessionId)).get())?.metadataDirty).toBe(1);
      expect(await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all()).toEqual(before);
    } finally {
      await deleteSession(sessionId);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const codes of [[15, 5], [19]]) {
  test(`reprocessing preserves saved type for ${codes.length > 1 ? "mixed" : "unrecognized"} native session evidence`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "f1-type-preserve-"));
    const sessionId = await insertSession("0", "0", "f1-2025", "practice-1");
    try {
      const path = join(directory, "session.bin");
      await capture(path, codes);
      await updateSessionRawFile(sessionId, path, "test");
      await reconcileSessionResult(sessionId, "f1-2025");
      expect((await db.select().from(sessions).where(eq(sessions.id, sessionId)).get())?.sessionType).toBe("practice-1");
      if (codes.length > 1) {
        expect((await getSessionResult(sessionId, "f1-2025"))?.evidence.conflicts.some((conflict) => conflict.startsWith("session-type:"))).toBe(true);
      }
    } finally {
      await deleteSession(sessionId);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("reprocessing preserves saved session type when raw capture is unavailable", async () => {
  const sessionId = await insertSession("0", "0", "f1-2025", "qualifying-1");
  try {
    await reconcileSessionResult(sessionId, "f1-2025");
    expect((await db.select().from(sessions).where(eq(sessions.id, sessionId)).get())?.sessionType).toBe("qualifying-1");
    expect((await getSessionResult(sessionId, "f1-2025"))?.sessionType).toBe("qualifying");
  } finally {
    await deleteSession(sessionId);
  }
});
