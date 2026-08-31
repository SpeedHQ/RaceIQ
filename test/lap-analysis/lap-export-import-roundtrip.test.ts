/**
 * End-to-end round-trip for the lap/session ZIP feature, against a *real*
 * recorded capture rather than the synthetic frames used in
 * lap-export-zip.test.ts.
 *
 * lap-export-zip.test.ts proves the export byte maths in isolation; it cannot
 * prove the bytes it produces are actually importable, because its frames are
 * 8-byte stubs that no parser accepts. This suite closes that gap: seed a real
 * session by replaying a committed capture, export a lap from it, import the
 * zip back, and assert the same lap reappears with the same lap time.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { rmSync, readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { unzipSync, zipSync } from "fflate";
import { db } from "../../server/db/index";
import { sessions, laps } from "../../server/db/schema";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { isIRacingSessionFrame } from "../../server/games/iracing/source-frame";
import { readIRacingFrames } from "../../server/games/iracing/recorder";
import { importSessionFrames } from "../../server/session-capture/import-pipeline";
import { getSessionResult } from "../../server/db/session-result-queries";
import { buildLapsZip, importLapsZip, type LapsZipManifest } from "../../server/laps/archive";
import { getSessionTelemetry, parseRawLapFrames, parseSessionLapsBatched } from "../../server/db/telemetry-replay-storage";
import { readRecordedTelemetry } from "../../server/session-capture/replay-packets";
import { reprocessSession } from "../../server/session-capture/reprocess";
import {
  iterateSessionCaptureRecords,
  iterateSessionFrames,
  META_FRAME_BYTES,
} from "../../server/session-capture/framing";
import { queryLapTelemetryBySemanticId } from "../../server/telemetry/replay";
import type { GameId } from "../../shared/games/ids";
initGameAdapters();
initServerGameAdapters();

/** Complete laps from committed capture with valid raw windows. */
const MIN_FRAMES = 0;

const CAPTURE = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
const IRACING_CAPTURE = "test/artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz";
const ALL_GAME_CAPTURES: { gameId: GameId; capture: string; label: string }[] = [
  { gameId: "fm-2023", capture: CAPTURE, label: "Forza Motorsport" },
  { gameId: "f1-2025", capture: "test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz", label: "F1 25" },
  { gameId: "acc", capture: "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz", label: "Assetto Corsa Competizione" },
  { gameId: "ac-evo", capture: "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz", label: "Assetto Corsa Evo" },
  { gameId: "iracing", capture: IRACING_CAPTURE, label: "iRacing" },
];


describe("lap export → import round-trip (real capture)", () => {
  const createdSessions: number[] = [];
  const tmpFiles: string[] = [];

  afterEach(async () => {
    if (createdSessions.length) {
      await db.delete(laps).where(inArray(laps.sessionId, createdSessions)).run();
      await db.delete(sessions).where(inArray(sessions.id, createdSessions)).run();
    }
    createdSessions.length = 0;
    for (const f of tmpFiles) rmSync(f, { force: true });
    tmpFiles.length = 0;
  });

  /**
   * Replay a committed capture. The replay runs the real pipeline, so the UDP
   * recorder writes its own .bin and the lap rows' raw offsets point into it —
   * exactly the state a live-recorded session is in. Do NOT repoint rawFile at
   * the source capture: the recorder's file is framed differently and the
   * offsets would no longer line up.
   *
   * A replay can produce several sessions (a race restart splits them), most of
   * which are junk — e.g. a 2-frame "incomplete lap (session ended)" stub. Pick
   * the session holding the real laps rather than assuming it is the first.
   */
  async function seedSession({
    capture = CAPTURE,
    gameId = "fm-2023",
    minimumLaps = 2,
  }: {
    capture?: string;
    gameId?: GameId;
    minimumLaps?: number;
  } = {}) {
    const frames = gameId === "iracing"
      ? readIRacingFrames(capture)
      : iterateSessionFrames(
          Buffer.from(gunzipSync(await Bun.file(capture).arrayBuffer())),
        );
    const res = await importSessionFrames(frames, gameId);
    expect(res.laps.length).toBeGreaterThan(0);

    const sids = [...new Set(res.laps.map((l) => l.sessionId))];
    createdSessions.push(...sids);

    const all = await db.select().from(laps).where(inArray(laps.sessionId, sids)).all();
    const withCapture = all.filter((r) => r.rawByteOffset !== null && (r.rawFrameCount ?? 0) > MIN_FRAMES);
    expect(withCapture.length).toBeGreaterThan(0);

    const sessionCounts = new Map<number, number>();
    for (const row of withCapture) sessionCounts.set(row.sessionId, (sessionCounts.get(row.sessionId) ?? 0) + 1);
    const sid = [...sessionCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(sessionCounts.get(sid)).toBeGreaterThanOrEqual(minimumLaps);
    if (gameId === "fm-2023") {
      expect(await getSessionResult(sid, gameId)).not.toBeNull();
    }
    const rows = withCapture.filter((r) => r.sessionId === sid);

    const session = await db.select().from(sessions).where(eq(sessions.id, sid)).get();
    if (session?.rawFile) tmpFiles.push(session.rawFile);

    return { sid, rows };
  }

  test("a lap exported from a real session imports back with the same lap time", async () => {
    const { rows } = await seedSession();
    const exported = rows[0];

    const { bytes: zip } = await buildLapsZip([exported.id]);
    const result = await importLapsZip(zip);

    expect(result.errors).toEqual([]);
    expect(result.imported).toBeGreaterThan(0);
    for (const l of result.laps) createdSessions.push(l.sessionId);

    const match = result.laps.find((l) => Math.abs(l.lapTime - exported.lapTime) < 0.001);
    expect(match).toBeDefined();
  }, 120000);
  for (const { gameId, capture, label } of ALL_GAME_CAPTURES) {
    test(`${label} selected lap preserves source telemetry through export and import`, async () => {
      const { sid, rows } = await seedSession({ capture, gameId, minimumLaps: 1 });
      const exported = rows.at(-1)!;
      const sourceSession = await db.select().from(sessions).where(eq(sessions.id, sid)).get();
      const sourcePackets = await parseRawLapFrames(
        sourceSession!.rawFile!,
        exported.rawByteOffset!,
        exported.rawFrameCount!,
        gameId,
      );
      expect(sourcePackets.length).toBeGreaterThan(0);

      const { bytes: zip } = await buildLapsZip([exported.id]);
      const result = await importLapsZip(zip);
      expect(result.errors).toEqual([]);
      expect(result.laps).toHaveLength(1);
      const imported = result.laps[0]!;
      createdSessions.push(imported.sessionId);
      const importedSession = await db.select().from(sessions).where(eq(sessions.id, imported.sessionId)).get();
      if (importedSession?.rawFile) tmpFiles.push(importedSession.rawFile);
      const importedRow = (await db.select().from(laps).where(eq(laps.sessionId, imported.sessionId)).all())
        .find((lap) => lap.lapNumber === exported.lapNumber);
      expect(importedRow).toBeDefined();
      const importedPackets = await parseRawLapFrames(
        importedSession!.rawFile!,
        importedRow!.rawByteOffset!,
        importedRow!.rawFrameCount!,
        gameId,
      );

      expect(imported.lapNumber).toBe(exported.lapNumber);
      expect(imported.lapTime).toBe(exported.lapTime);
      expect(importedPackets.length).toBe(sourcePackets.length);
      expect(importedPackets.map(({ TimestampMS: _timestamp, ...packet }) => packet))
        .toEqual(sourcePackets.map(({ TimestampMS: _timestamp, ...packet }) => packet));
    }, 120000);
  }

  test("first and last selected laps round-trip as compact segments", async () => {
    const { sid, rows } = await seedSession();
    const exportable = rows.sort((a, b) => a.lapNumber - b.lapNumber);
    expect(exportable).toHaveLength(2);
    const [first, last] = exportable;
    const { bytes: zip, manifest } = await buildLapsZip([first.id, last.id]);
    expect(manifest.version).toBe(3);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.laps.map((l) => l.lapNumber)).toEqual([first.lapNumber, last.lapNumber]);
    expect(manifest.entries[0]?.laps.map((l) => l.lapTime)).toEqual([first.lapTime, last.lapTime]);
    const result = await importLapsZip(zip);
    expect(result.errors).toEqual([]);
    expect(result.laps).toHaveLength(2);
    result.laps.forEach((l) => createdSessions.push(l.sessionId));
    expect(new Set(result.laps.map((l) => l.sessionId)).size).toBe(1);
    expect(result.laps.map((l) => l.lapNumber).sort((a, b) => a - b)).toEqual([first.lapNumber, last.lapNumber]);
    const importedSid = result.laps[0]!.sessionId;
    const importedRows = await db.select().from(laps).where(eq(laps.sessionId, importedSid)).all();
    expect(importedRows).toHaveLength(2);
    expect(importedRows.every((l) => l.lapNumber === first.lapNumber || l.lapNumber === last.lapNumber)).toBe(true);
    const importedSession = await db.select().from(sessions).where(eq(sessions.id, importedSid)).get();
    const rawFile = importedSession!.rawFile!;
    const raw = readFileSync(rawFile);
    expect([...iterateSessionCaptureRecords(raw)].filter((r) => r.kind === "segment-boundary")).toHaveLength(1);
    const sourceSession = await db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(raw.length).toBeLessThan(readFileSync(sourceSession!.rawFile!).length);
    expect((await getSessionTelemetry(importedSid, "fm-2023")).length).toBeGreaterThan(0);
    expect(readRecordedTelemetry("fm-2023", rawFile).packets.length).toBeGreaterThan(0);
    const metas = importedRows.map((l) => ({ id: l.id, rawByteOffset: l.rawByteOffset!, rawFrameCount: l.rawFrameCount! }));
    const batch = await parseSessionLapsBatched(rawFile, metas, "fm-2023");
    for (const meta of metas) {
      const individual = await parseRawLapFrames(rawFile, meta.rawByteOffset, meta.rawFrameCount, "fm-2023");
      expect(individual.length).toBeGreaterThan(0);
      expect(batch.get(meta.id)).toEqual(individual);
    }
    await reprocessSession(importedSid);
    expect(await db.select().from(laps).where(eq(laps.sessionId, importedSid)).all()).toHaveLength(2);
  }, 120000);

  test("non-contiguous iRacing laps preserve source telemetry through export, import, replay, and reprocess", async () => {
    const { sid, rows } = await seedSession({
      capture: IRACING_CAPTURE,
      gameId: "iracing",
      minimumLaps: 4,
    });
    const exportable = rows.sort((a, b) => a.lapNumber - b.lapNumber);
    const selected = [exportable[0]!, exportable.at(-1)!];
    const selectedNumbers = selected.map((lap) => lap.lapNumber);
    const omittedNumbers = exportable.slice(1, -1).map((lap) => lap.lapNumber);
    expect(omittedNumbers.length).toBeGreaterThan(0);

    const { bytes: zip, manifest } = await buildLapsZip(selected.map((lap) => lap.id));
    expect(manifest.entries[0]?.laps.map((lap) => lap.lapNumber)).toEqual(selectedNumbers);

    const archived = unzipSync(zip);
    const exportedCapture = Buffer.from(gunzipSync(archived[manifest.entries[0]!.file]!));
    const records = [...iterateSessionCaptureRecords(exportedCapture)];
    const boundaryIndexes = records.flatMap((record, index) =>
      record.kind === "segment-boundary" ? [index] : [],
    );
    expect(boundaryIndexes).toHaveLength(2);
    for (const boundaryIndex of boundaryIndexes) {
      const record = records[boundaryIndex + 1];
      expect(record?.kind === "frame" && isIRacingSessionFrame(record.frame)).toBe(true);
    }

    const result = await importLapsZip(zip);
    expect(result.errors).toEqual([]);
    expect(result.laps.map((lap) => lap.lapNumber).sort((a, b) => a - b)).toEqual(selectedNumbers);
    expect(result.laps.some((lap) => omittedNumbers.includes(lap.lapNumber))).toBe(false);
    expect(new Set(result.laps.map((lap) => lap.sessionId)).size).toBe(1);
    result.laps.forEach((lap) => createdSessions.push(lap.sessionId));

    const importedSid = result.laps[0]!.sessionId;
    const importedSession = await db.select().from(sessions).where(eq(sessions.id, importedSid)).get();
    const sourceSession = await db.select().from(sessions).where(eq(sessions.id, sid)).get();
    const importedRawFile = importedSession!.rawFile!;
    const sourceRawFile = sourceSession!.rawFile!;
    tmpFiles.push(importedRawFile);
    const importedRows = await db.select().from(laps).where(eq(laps.sessionId, importedSid)).all();

    for (const sourceLap of selected) {
      const importedLap = importedRows.find((lap) => lap.lapNumber === sourceLap.lapNumber)!;
      const sourcePackets = await parseRawLapFrames(
        sourceRawFile,
        sourceLap.rawByteOffset!,
        sourceLap.rawFrameCount!,
        "iracing",
      );
      const importedPackets = await parseRawLapFrames(
        importedRawFile,
        importedLap.rawByteOffset!,
        importedLap.rawFrameCount!,
        "iracing",
      );
      expect(importedPackets).toEqual(sourcePackets);
      expect((await queryLapTelemetryBySemanticId(importedLap.id, ["motion.speed"]))?.envelopes.length).toBeGreaterThan(0);
    }

    await reprocessSession(importedSid);
    const reprocessed = await db.select().from(laps).where(eq(laps.sessionId, importedSid)).all();
    expect(reprocessed.map((lap) => lap.lapNumber).sort((a, b) => a - b)).toEqual(selectedNumbers);
  }, 120000);

  test("imports legacy v2 manifest for a single segment", async () => {
    const { rows } = await seedSession();
    const { bytes: zip } = await buildLapsZip([rows[0]!.id]);
    const entries = unzipSync(zip);
    const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"])) as LapsZipManifest;
    const memberName = manifest.entries[0]!.file;
    const capture = Buffer.from(gunzipSync(entries[memberName]!));
    const firstFrame = [...iterateSessionCaptureRecords(capture)].find(
      (record) => record.kind === "frame",
    );
    expect(firstFrame).toBeDefined();
    entries[memberName] = gzipSync(
      Buffer.concat([
        capture.subarray(0, META_FRAME_BYTES),
        capture.subarray(firstFrame!.offset),
      ]),
    );
    manifest.version = 2;
    const legacyZip = zipSync({ ...entries, "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)) });
    const result = await importLapsZip(legacyZip);
    expect(result.errors).toEqual([]);
    expect(result.laps.some((l) => Math.abs(l.lapTime - rows[0]!.lapTime) < 0.001)).toBe(true);
    for (const l of result.laps) createdSessions.push(l.sessionId);
  }, 120000);


  test("a whole session round-trips every lap that has a raw capture", async () => {
    const { rows } = await seedSession();
    const exportable = rows;
    expect(exportable.length).toBeGreaterThan(1);

    const { bytes: zip } = await buildLapsZip(exportable.map((r) => r.id));
    const result = await importLapsZip(zip);
    for (const l of result.laps) createdSessions.push(l.sessionId);

    expect(result.errors).toEqual([]);
    const got = result.laps.map((l) => Math.round(l.lapTime * 1000)).sort((a, b) => a - b);
    const want = exportable.map((r) => Math.round(r.lapTime * 1000)).sort((a, b) => a - b);
    expect(got).toEqual(want);
  }, 120000);
});
