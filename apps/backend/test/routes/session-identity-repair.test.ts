import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { fmCarCatalog } from "@raceiq/game-fm-2023-metadata/racing/cars/fm";
import { fmTrackCatalog } from "@raceiq/game-fm-2023-metadata/racing/tracks/catalogs/fm";
import { sessionRoutes } from "../../src/routes/session-routes";

const sessionIds: number[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const sessionId of sessionIds.splice(0)) {
    await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("session identity repair", () => {
  test("updates only canonical session identity and preserves source bytes and lap metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raceiq-session-identity-"));
    tempDirs.push(dir);
    const sourcePath = join(dir, "original.ldx");
    const sourceBytes = Buffer.from([0, 1, 2, 10, 13, 255]);
    await writeFile(sourcePath, sourceBytes);
    const inserted = await db.insert(sessions).values({
      gameId: "fm-2023",
      carId: "unresolved-car",
      trackId: "unresolved-track",
      source: "motec",
      rawFile: sourcePath,
      notes: "session notes",
    }).returning({ id: sessions.id }).get();
    const sessionId = inserted!.id;
    sessionIds.push(sessionId);
    const lap = await db.insert(laps).values({ sessionId, lapNumber: 7, lapTime: 91.25, isValid: true, notes: "lap note" })
      .returning({ id: laps.id }).get();
    const carId = String(fmCarCatalog.keys().next().value);
    const trackId = String(fmTrackCatalog.keys().next().value);

    const response = await sessionRoutes.request(`/api/sessions/${sessionId}/identity`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "fm-2023", carId, trackId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, sessionId, carId, trackId });
    expect(await db.select({ carId: sessions.carId, trackId: sessions.trackId, source: sessions.source, rawFile: sessions.rawFile, notes: sessions.notes })
      .from(sessions).where(eq(sessions.id, sessionId)).get()).toEqual({ carId, trackId, source: "motec", rawFile: sourcePath, notes: "session notes" });
    expect(await db.select({ id: laps.id, lapNumber: laps.lapNumber, lapTime: laps.lapTime, isValid: laps.isValid, notes: laps.notes })
      .from(laps).where(eq(laps.sessionId, sessionId)).get()).toEqual({ id: lap!.id, lapNumber: 7, lapTime: 91.25, isValid: true, notes: "lap note" });
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
  });

  test("rejects non-catalog identities and missing sessions", async () => {
    const inserted = await db.insert(sessions).values({ gameId: "fm-2023", carId: "old", trackId: "old" })
      .returning({ id: sessions.id }).get();
    const sessionId = inserted!.id;
    sessionIds.push(sessionId);
    const request = (id: number, carId: string, trackId: string) => sessionRoutes.request(`/api/sessions/${id}/identity`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "fm-2023", carId, trackId }),
    });

    const invalidResponse = await request(sessionId, "not-in-catalog", String(fmTrackCatalog.keys().next().value));
    expect(invalidResponse.status).toBe(400);
    expect((await invalidResponse.json()).error).toContain("catalog");
    const missingResponse = await request(2_000_000_000, String(fmCarCatalog.keys().next().value), String(fmTrackCatalog.keys().next().value));
    expect(missingResponse.status).toBe(404);
    expect((await missingResponse.json()).error).toBe("Session not found");
  });
});
