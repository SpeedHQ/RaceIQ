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
import { rmSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../server/db/index";
import { sessions, laps } from "../../server/db/schema";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { importSessionBin } from "../../server/session-capture/import-capture"
import { getSessionResult } from "../../server/db/session-result-queries";
import { buildLapsZip, importLapsZip } from "../../server/laps/archive"

initGameAdapters();
initServerGameAdapters();

/** 3 complete laps, the smallest committed capture that produces any. */
const MIN_FRAMES = 100;

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

    const sid = withCapture[0].sessionId;
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
  test("two selected laps from one session both round-trip", async () => {
    const { rows } = await seedSession();
    expect(rows.length).toBeGreaterThan(1);

    const selected = rows.slice(0, 2);
    const { bytes: zip, manifest } = await buildLapsZip(selected.map((row) => row.id));
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.laps).toHaveLength(2);

    const result = await importLapsZip(zip);
    expect(result.errors).toEqual([]);
    const got = result.laps.map((lap) => Math.round(lap.lapTime * 1000)).sort((a, b) => a - b);
    const want = selected.map((lap) => Math.round(lap.lapTime * 1000)).sort((a, b) => a - b);
    expect(got).toEqual(want);
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
