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
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { zipSync, unzipSync } from "fflate";
import { gunzipSync } from "node:zlib";
import { rmSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../server/db/index";
import { sessions, laps } from "../../server/db/schema";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { importSessionBin } from "../../server/session-capture/import-capture";
import { getSessionResult } from "../../server/db/session-result-queries";
import { buildLapsZip, importLapsZip } from "../../server/laps/archive";
import type { SourceChannelProfile } from "../../shared/racing/quality/contracts";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { sha256ContentHash } from "../../server/session-capture/identity";

initGameAdapters();
initServerGameAdapters();

/** 3 complete laps, the smallest committed capture that produces any. */
const MIN_FRAMES = 100;

const CAPTURE = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";

const SOURCE_CHANNEL_PROFILE: SourceChannelProfile = {
  schemaVersion: "1",
  sourceKind: "motec",
  channels: {
    "inputs.steer": {
      treatment: "assumed",
      mappingStatus: "unavailable",
      sourceChannels: [{ name: "Steering Angle", declaredHz: 20, effectiveHz: 20 }],
      limitations: ["Steering reconstructed from source telemetry."],
      evidenceId: "source-channel-profile:1:motec:inputs.steer",
    },
  },
};

describe("lap export → import round-trip (real capture)", () => {
  afterAll(() => {
    stopMaintenanceTasks();
  });
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

  test("uses decompressed bytes as canonical identity for raw and gzip imports", async () => {
    const gzipBytes = Buffer.from(await Bun.file(CAPTURE).arrayBuffer());
    const rawBytes = Buffer.from(gunzipSync(gzipBytes));
    const expectedGeneration = sha256ContentHash(rawBytes);

    for (const bytes of [rawBytes, gzipBytes]) {
      const result = await importSessionBin(bytes, "fm-2023");
      expect(result.laps.length).toBeGreaterThan(0);
      const sessionIds = [...new Set(result.laps.map((lap) => lap.sessionId))];
      createdSessions.push(...sessionIds);
      const importedSessions = await db
        .select()
        .from(sessions)
        .where(inArray(sessions.id, sessionIds))
        .all();
      expect(importedSessions.length).toBeGreaterThan(0);
      for (const imported of importedSessions) {
        if (imported.rawFile) tmpFiles.push(imported.rawFile);
        expect(imported.recordingQuality?.archiveVerification?.sourceGeneration).toBe(
          expectedGeneration,
        );
      }
    }
  }, 120000);

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

  test("preserves original source fidelity while verifying the ZIP member separately", async () => {
    const { sid, rows } = await seedSession();
    await db.update(sessions).set({ source: "motec", sourceChannelProfile: SOURCE_CHANNEL_PROFILE }).where(eq(sessions.id, sid)).run();
    const sourceSession = await db.select({ recordingQuality: sessions.recordingQuality }).from(sessions).where(eq(sessions.id, sid)).get();
    const sourceVerification = sourceSession?.recordingQuality?.archiveVerification;
    if (!sourceVerification) throw new Error("Seed session is missing source verification");

    const { bytes, manifest } = await buildLapsZip([rows[0].id]);
    expect(manifest.version).toBe(3);
    expect(manifest.entries[0]).toMatchObject({
      sourceKind: "motec",
      sourceChannelProfile: SOURCE_CHANNEL_PROFILE,
      sourceVerification,
    });

    const result = await importLapsZip(bytes);
    expect(result.errors).toEqual([]);
    expect(result.imported).toBeGreaterThan(0);
    const importedSessionIds = [...new Set(result.laps.map((lap) => lap.sessionId))];
    createdSessions.push(...importedSessionIds);
    const importedSessions = await db.select().from(sessions).where(inArray(sessions.id, importedSessionIds)).all();
    for (const imported of importedSessions) {
      if (imported.rawFile) tmpFiles.push(imported.rawFile);
      expect(imported.source).toBe("motec");
      expect(imported.sourceChannelProfile).toEqual(SOURCE_CHANNEL_PROFILE);
      expect(imported.recordingQuality?.sourceKind).toBe("motec");
      expect(imported.recordingQuality?.archiveVerification).toEqual(sourceVerification);
      expect(imported.recordingQuality?.transportVerification).toEqual({
        state: "verified",
        sourceGeneration: manifest.entries[0].memberSha256 ?? null,
      });
      expect(imported.recordingQuality?.canonicalVerification).toMatchObject({
        state: "verified",
        sourceGeneration: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
    }
  }, 120000);

  test("imports archives without a manifest as legacy unverified evidence", async () => {
    const { rows } = await seedSession();
    const { bytes } = await buildLapsZip([rows[0].id]);
    const files = unzipSync(bytes);
    delete files["manifest.json"];

    const result = await importLapsZip(zipSync(files));
    for (const lap of result.laps) createdSessions.push(lap.sessionId);

    expect(result.errors).toEqual([]);
    expect(result.imported).toBeGreaterThan(0);
    const importedSessionIds = [...new Set(result.laps.map((lap) => lap.sessionId))];
    const importedSessions = await db.select().from(sessions).where(inArray(sessions.id, importedSessionIds)).all();
    for (const imported of importedSessions) {
      if (imported.rawFile) tmpFiles.push(imported.rawFile);
    }
    const importedSession = importedSessions.find(({ id }) => id === result.laps[0]!.sessionId);
    expect(importedSession?.recordingQuality?.archiveVerification).toMatchObject({
      state: "unknown",
      sourceGeneration: "legacy",
    });
  }, 120000);

  test("imports released v2 manifests without v3-only fields", async () => {
    const { rows } = await seedSession();
    const { bytes, manifest } = await buildLapsZip([rows[0].id]);
    const files = unzipSync(bytes);
    manifest.version = 2;
    for (const entry of manifest.entries) {
      delete entry.memberSha256;
      delete entry.sourceKind;
      delete entry.sourceChannelProfile;
      delete entry.sourceVerification;
      delete entry.recordingQualitySchemaVersion;
      delete entry.sourceGeneration;
    }
    files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));

    const result = await importLapsZip(zipSync(files));
    expect(result.errors).toEqual([]);
    expect(result.imported).toBeGreaterThan(0);
    const importedSessionIds = [...new Set(result.laps.map((lap) => lap.sessionId))];
    createdSessions.push(...importedSessionIds);
    const importedSessions = await db
      .select()
      .from(sessions)
      .where(inArray(sessions.id, importedSessionIds))
      .all();
    for (const imported of importedSessions) {
      if (imported.rawFile) tmpFiles.push(imported.rawFile);
      expect(imported.source).toBe("raceiq-archive");
      expect(imported.recordingQuality?.archiveVerification).toMatchObject({
        state: "unknown",
        sourceGeneration: "legacy",
      });
    }
  }, 120000);

  test("rejects a v3 manifest that declares a missing capture member", async () => {
    const { rows } = await seedSession();
    const { bytes, manifest } = await buildLapsZip([rows[0].id]);
    const files = unzipSync(bytes);
    manifest.entries.push({
      ...manifest.entries[0],
      file: "missing-session.bin.gz",
    });
    files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));

    await expect(importLapsZip(zipSync(files))).rejects.toThrow(
      "version 3 strict layout declares a missing capture member",
    );
  }, 120000);
  test("rejects v3 manifest entries for ancillary members", async () => {
    const { rows } = await seedSession();
    const { bytes, manifest } = await buildLapsZip([rows[0].id]);
    const files = unzipSync(bytes);
    const notes = new TextEncoder().encode("notes");
    files["notes.txt"] = notes;
    manifest.entries.push({
      ...manifest.entries[0],
      file: "notes.txt",
      memberSha256: sha256ContentHash(Buffer.from(notes)),
    });
    files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));

    await expect(importLapsZip(zipSync(files))).rejects.toThrow(
      "version 3 strict layout only allows .bin/.bin.gz capture entries",
    );
  }, 120000);

  test("rejects undeclared ancillary members in v3 archives", async () => {
    const { rows } = await seedSession();
    const { bytes } = await buildLapsZip([rows[0].id]);
    const files = unzipSync(bytes);
    files["notes.txt"] = new TextEncoder().encode("notes");

    await expect(importLapsZip(zipSync(files))).rejects.toThrow(
      "version 3 strict layout contains an undeclared member",
    );
  }, 120000);

  test("verifies every v3 checksum before importing any capture", async () => {
    const first = await seedSession();
    const second = await seedSession();
    const { bytes, manifest } = await buildLapsZip([first.rows[0].id, second.rows[0].id]);
    expect(manifest.entries).toHaveLength(2);
    const files = unzipSync(bytes);
    const corruptName = manifest.entries[1].file;
    files[corruptName] = files[corruptName].slice();
    files[corruptName][files[corruptName].length - 1] ^= 0xff;
    const beforeSessionIds = (await db.select({ id: sessions.id }).from(sessions).all())
      .map(({ id }) => id)
      .sort((a, b) => a - b);

    await expect(importLapsZip(zipSync(files))).rejects.toThrow(
      "version 3 capture member checksum mismatch",
    );

    const afterSessionIds = (await db.select({ id: sessions.id }).from(sessions).all())
      .map(({ id }) => id)
      .sort((a, b) => a - b);
    expect(afterSessionIds).toEqual(beforeSessionIds);
  }, 120000);


  test("rejects a present corrupt v2 manifest instead of importing as legacy", async () => {
    const { rows } = await seedSession();
    const { bytes } = await buildLapsZip([rows[0].id]);
    const files = unzipSync(bytes);
    files["manifest.json"] = new TextEncoder().encode('{"version":2,"exportedAt":');

    await expect(importLapsZip(zipSync(files))).rejects.toThrow("Invalid RaceIQ archive manifest");
  }, 120000);
});
