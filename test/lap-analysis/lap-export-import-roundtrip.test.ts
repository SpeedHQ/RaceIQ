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
import { gunzipSync } from "node:zlib";
import { rmSync, readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { unzipSync, zipSync } from "fflate";
import { db } from "../../server/db/index";
import { sessions, laps } from "../../server/db/schema";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { importSessionBin } from "../../server/session-capture/import-capture";
import { getSessionResult } from "../../server/db/session-result-queries";
import { buildLapsZip, importLapsZip, type LapsZipManifest } from "../../server/laps/archive";
import { getSessionTelemetry, parseRawLapFrames, parseSessionLapsBatched } from "../../server/db/telemetry-replay-storage";
import { readRecordedTelemetry } from "../../server/session-capture/replay-packets";
import { reprocessSession } from "../../server/session-capture/reprocess";
import { iterateSessionCaptureRecords } from "../../server/session-capture/framing";
initGameAdapters();
initServerGameAdapters();

/** Complete laps from committed capture with valid raw windows. */
const MIN_FRAMES = 0;

const CAPTURE = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";

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
  async function seedSession() {
    const gz = Buffer.from(await Bun.file(CAPTURE).arrayBuffer());
    const raw = Buffer.from(gunzipSync(gz));

    const res = await importSessionBin(raw, "fm-2023");
    expect(res.laps.length).toBeGreaterThan(0);

    const sids = [...new Set(res.laps.map((l) => l.sessionId))];
    createdSessions.push(...sids);

    const all = await db.select().from(laps).where(inArray(laps.sessionId, sids)).all();
    const withCapture = all.filter((r) => r.rawByteOffset !== null && (r.rawFrameCount ?? 0) > MIN_FRAMES);
    expect(withCapture.length).toBeGreaterThan(0);

    const sessionCounts = new Map<number, number>();
    for (const row of withCapture) sessionCounts.set(row.sessionId, (sessionCounts.get(row.sessionId) ?? 0) + 1);
    const sid = [...sessionCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(sessionCounts.get(sid)).toBeGreaterThan(1);
    expect(await getSessionResult(sid, "fm-2023")).not.toBeNull();
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

  test("imports legacy v2 manifest for a single segment", async () => {
    const { rows } = await seedSession();
    const { bytes: zip } = await buildLapsZip([rows[0]!.id]);
    const entries = unzipSync(zip);
    const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"])) as LapsZipManifest;
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
