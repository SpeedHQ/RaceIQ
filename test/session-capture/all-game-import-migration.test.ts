import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";
import { deleteSession } from "../../server/db/session-queries";
import { initServerGameAdapters } from "../../server/games/init";
import { transferRoutes } from "../../server/routes/laps/transfer-routes";
import { sessionRoutes } from "../../server/routes/session-routes";
import { lapRoutes } from "../../server/routes/laps";
import { iterateSessionCaptureRecordsFromSource } from "../../server/session-capture/source-loader";
import { initGameAdapters } from "@raceiq/games/init";
import type { GameId } from "@raceiq/games/ids";

const fixtures: ReadonlyArray<{ gameId: GameId; file: string }> = [
  { gameId: "fm-2023", file: "fm-2023-2026-04-09T21-55-03-186Z.bin.gz" },
  { gameId: "f1-2025", file: "f1-2025-2026-04-22T11-42-43-029Z.bin.gz" },
  { gameId: "acc", file: "acc-2026-04-23T16-42-16-158Z.bin.gz" },
  { gameId: "ac-evo", file: "session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz" },
  { gameId: "iracing", file: "iracing-daytona-am-vantage-gt3-pit.bin.gz" },
  { gameId: "lmu", file: "lmu-spa-iron-lynx-gte.bin.gz" },
];

initGameAdapters();
initServerGameAdapters();
const importedIds = new Set<number>();
const backupDir = mkdtempSync(join(tmpdir(), "raceiq-all-game-migration-"));
afterAll(async () => {
  for (const id of importedIds) await deleteSession(id);
  rmSync(backupDir, { recursive: true, force: true });
});

type StoredCapture = {
  gameId: GameId;
  original: string;
  backup: string;
  sessionIds: number[];
  sourceLaps: (typeof laps.$inferSelect)[];
};

function captureSource(path: string, gameId: GameId) {
  return { rawFile: path, gameId, source: null, carOrdinal: -1, trackOrdinal: -1 };
}

async function compareEveryRecord(capture: StoredCapture, finalPath: string, remapped: Map<number, number>): Promise<void> {
  const oldRecords = iterateSessionCaptureRecordsFromSource(captureSource(capture.backup, capture.gameId), { strict: true });
  const newRecords = iterateSessionCaptureRecordsFromSource(captureSource(finalPath, capture.gameId), { strict: true });
  const after = newRecords[Symbol.asyncIterator]();
  let frames = 0;
  try {
    for await (const before of oldRecords) {
      const next = await after.next();
      if (next.done || next.value.kind !== before.kind) {
        throw new Error(`${capture.gameId}: record type/count mismatch at ${before.offset}`);
      }
      if (before.kind !== "frame" || next.value.kind !== "frame") continue;
      if (!next.value.frame.equals(before.frame) || next.value.frameTimeMs !== before.frameTimeMs) {
        throw new Error(`${capture.gameId}: source frame differs at ${before.offset}`);
      }
      const mapped = remapped.get(before.offset);
      if (mapped !== undefined && next.value.offset !== mapped) {
        throw new Error(`${capture.gameId}: lap seek remapped to wrong frame at ${before.offset}`);
      }
      frames++;
    }
    expect((await after.next()).done).toBe(true);
  } finally {
    await after.return?.(undefined);
  }
  expect(frames).toBeGreaterThan(0);
}

test("imports all six complete game bins through API, then migrates every candidate losslessly", async () => {
  const captures: StoredCapture[] = [];
  for (const { gameId, file } of fixtures) {
    const existing = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(({ id }) => id));
    const form = new FormData();
    form.append("file", new File([readFileSync(join(import.meta.dir, "../artifacts/sessions", file))], file));
    form.append("ownership", "mine");
    form.append("captureStorage", "raw");
    const response = await transferRoutes.request("/api/laps/import", { method: "POST", body: form });
    expect(response.status).toBe(200);
    const result = await response.json() as { gameId: GameId; packetCount: number; laps: Array<{ lapId: number }> };
    expect(result.gameId).toBe(gameId);
    expect(result.packetCount).toBeGreaterThan(0);
    expect(result.laps.length).toBeGreaterThan(0);
    const created = (await db.select().from(sessions).all()).filter(({ id }) => !existing.has(id));
    for (const row of created) importedIds.add(row.id);
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((row) => row.gameId === gameId && row.captureFormatVersion === null)).toBe(true);
    const grouped = new Map<string, number[]>();
    for (const row of created) {
      expect(row.rawFile).toBeTruthy();
      const ids = grouped.get(row.rawFile!);
      if (ids) ids.push(row.id);
      else grouped.set(row.rawFile!, [row.id]);
    }
    for (const [original, sessionIds] of grouped) {
      const backup = join(backupDir, `${captures.length}.bin`);
      copyFileSync(original, backup);
      const sourceLaps = await db.select().from(laps).where(inArray(laps.sessionId, sessionIds)).all();
      captures.push({ gameId, original, backup, sessionIds, sourceLaps });
    }
  }

  const candidates = new Map<GameId, { id: number; frames: number }>();
  const response = await sessionRoutes.request("/api/sessions/migrate-captures", { method: "POST" });
  expect(response.status).toBe(200);
  const result = await response.json() as { results: Array<{ rawFile: string; status: "migrated" | "error"; error?: string }> };
  for (const capture of captures) {
    const outcome = result.results.find(({ rawFile }) => rawFile === capture.original);
    expect(outcome?.status).toBe("migrated");
    const updated = await db.select().from(sessions).where(inArray(sessions.id, capture.sessionIds)).all();
    expect(updated.every((row) => row.captureFormatVersion === 1)).toBe(true);
    const finalPath = updated[0]!.rawFile!;
    expect(updated.every((row) => row.rawFile === finalPath)).toBe(true);
    expect(existsSync(finalPath)).toBe(true);
    expect(finalPath).not.toBe(capture.original);
    expect(existsSync(capture.original)).toBe(false);
    const remapped = new Map<number, number>();
    for (const lap of capture.sourceLaps) {
      const current = await db.select().from(laps).where(eq(laps.id, lap.id)).get();
      expect(current).toMatchObject({ id: lap.id, rawFrameCount: lap.rawFrameCount, lapTime: lap.lapTime, isValid: lap.isValid, notes: lap.notes });
      if (lap.rawByteOffset !== null) remapped.set(lap.rawByteOffset, current!.rawByteOffset!);
      const frameCount = current!.rawFrameCount ?? 0;
      if (frameCount > (candidates.get(capture.gameId)?.frames ?? 0)) {
        candidates.set(capture.gameId, { id: current!.id, frames: frameCount });
      }
    }
    await compareEveryRecord(capture, finalPath, remapped);
  }
  for (const { gameId } of fixtures) {
    const candidate = candidates.get(gameId);
    expect(candidate?.frames).toBeGreaterThan(0);
    const replay = await lapRoutes.request(`/api/laps/${candidate!.id}/semantic-telemetry`, {
      headers: { "X-Game-Id": gameId },
    });
    expect(replay.status).toBe(200);
    const body = await replay.json() as { detectorCoverage: Array<{ status: string; reason?: string }> };
    expect(body.detectorCoverage.some((detector) => detector.status === "checked" || detector.status === "finding")).toBe(true);
    const findings = await lapRoutes.request(`/api/laps/${candidate!.id}/insights`, {
      headers: { "X-Game-Id": gameId },
    });
    expect(findings.status).toBe(200);
    expect((await findings.json() as { insights: unknown[] }).insights.length).toBeGreaterThan(0);
  }
  expect(result.results.length).toBe(captures.length);
}, { timeout: 300_000 });
