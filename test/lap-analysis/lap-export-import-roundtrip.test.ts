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
import {
  importSessionBin,
  type ImportSessionBinOptions,
} from "../../server/session-capture/import-capture";
import { getSessionResult } from "../../server/db/session-result-queries";
import { buildLapsZip, importLapsZip } from "../../server/laps/archive";
import type {
  EvidenceSourceKind,
  SourceChannelProfile,
} from "../../shared/racing/quality/contracts";

initGameAdapters();
initServerGameAdapters();

/** 3 complete laps, the smallest committed capture that produces any. */
const MIN_FRAMES = 100;

const CAPTURE = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
const MOTEC_SOURCE_PROFILE: SourceChannelProfile = {
  schemaVersion: "1",
  sourceKind: "motec",
  channels: {
    "inputs.steer": {
      treatment: "assumed",
      mappingStatus: "simplified",
      sourceChannels: [
        { name: "STEERANGLE", declaredHz: 60, effectiveHz: 60 },
      ],
      limitations: ["Steering normalized using assumed lock."],
      evidenceId: "source-channel-profile:1:motec:inputs.steer",
    },
    "tires.tire-wear": {
      treatment: "absent",
      mappingStatus: "derived",
      sourceChannels: [],
      limitations: ["MoTeC import does not provide tire wear."],
      evidenceId: "source-channel-profile:1:motec:tires.tire-wear",
    },
    "motion.position-x": {
      treatment: "dead-reckoned",
      mappingStatus: "derived",
      sourceChannels: [
        { name: "SPEED", declaredHz: 60, effectiveHz: 60 },
        { name: "ROTY", declaredHz: 60, effectiveHz: 60 },
      ],
      limitations: ["Position dead-reckoned from speed and yaw rate."],
      evidenceId: "source-channel-profile:1:motec:motion.position-x",
    },
  },
};
const EXTERNAL_SOURCE_PROFILE: SourceChannelProfile = {
  schemaVersion: "1",
  sourceKind: "external-log",
  channels: {
    "motion.speed": {
      treatment: "resampled",
      mappingStatus: "normalized",
      sourceChannels: [
        { name: "Ground Speed", declaredHz: 50, effectiveHz: 20 },
      ],
      limitations: ["Resampled external export."],
      evidenceId: "source-channel-profile:1:external-log:motion.speed",
    },
  },
};

function archivedProfile(profile: SourceChannelProfile): SourceChannelProfile {
  return { ...profile, sourceKind: "raceiq-archive" };
}

async function expectSessionSource(
  sessionIds: readonly number[],
  source: EvidenceSourceKind,
  sourceChannelProfile: SourceChannelProfile | null = null,
): Promise<void> {
  const uniqueIds = [...new Set(sessionIds)];
  const rows = await db
    .select({
      source: sessions.source,
      sourceChannelProfile: sessions.sourceChannelProfile,
    })
    .from(sessions)
    .where(inArray(sessions.id, uniqueIds))
    .all();
  expect(rows).toHaveLength(uniqueIds.length);
  expect(rows.every((row) => row.source === source)).toBe(true);
  for (const row of rows) {
    expect(row.sourceChannelProfile).toEqual(sourceChannelProfile);
  }
}


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
  async function seedSession(options: ImportSessionBinOptions = {}) {
    const gz = Buffer.from(await Bun.file(CAPTURE).arrayBuffer());
    const raw = Buffer.from(gunzipSync(gz));

    const res = await importSessionBin(raw, "fm-2023", options);
    expect(res.laps.length).toBeGreaterThan(0);

    const sids = [...new Set(res.laps.map((l) => l.sessionId))];
    createdSessions.push(...sids);
    await expectSessionSource(
      sids,
      options.source ?? "raceiq-raw",
      options.sourceChannelProfile ?? null,
    );

    const all = await db.select().from(laps).where(inArray(laps.sessionId, sids)).all();
    const withCapture = all.filter((r) => r.rawByteOffset !== null && (r.rawFrameCount ?? 0) > MIN_FRAMES);
    expect(withCapture.length).toBeGreaterThan(0);

    const sid = withCapture[0].sessionId;
    expect(await getSessionResult(sid, "fm-2023")).not.toBeNull();
    const rows = withCapture.filter((r) => r.sessionId === sid);
    const session = await db
      .select({ rawFile: sessions.rawFile })
      .from(sessions)
      .where(eq(sessions.id, sid))
      .get();

    if (session?.rawFile) tmpFiles.push(session.rawFile);

    return { sid, rows };
  }

  test("an old manifest without a source profile imports with a null profile", async () => {
    const { rows } = await seedSession();
    const exported = rows[0];

    const { bytes: zip, manifest } = await buildLapsZip([exported.id]);
    expect(manifest.entries[0].sourceChannelProfile).toBeUndefined();
    const result = await importLapsZip(zip);

    expect(result.errors).toEqual([]);
    expect(result.imported).toBeGreaterThan(0);
    for (const l of result.laps) createdSessions.push(l.sessionId);
    await expectSessionSource(
      result.laps.map((lap) => lap.sessionId),
      "raceiq-archive",
      null,
    );

    const match = result.laps.find((l) => Math.abs(l.lapTime - exported.lapTime) < 0.001);
    expect(match).toBeDefined();
  }, 120000);

  test("a MoTeC fidelity profile survives a whole-session round trip", async () => {
    const { rows } = await seedSession({
      source: "motec",
      sourceChannelProfile: MOTEC_SOURCE_PROFILE,
    });
    expect(rows.length).toBeGreaterThan(1);

    const { bytes: zip, manifest } = await buildLapsZip(rows.map((r) => r.id));
    expect(manifest.entries[0].sourceChannelProfile).toEqual(MOTEC_SOURCE_PROFILE);
    const result = await importLapsZip(zip);
    for (const l of result.laps) createdSessions.push(l.sessionId);
    await expectSessionSource(
      result.laps.map((lap) => lap.sessionId),
      "raceiq-archive",
      archivedProfile(MOTEC_SOURCE_PROFILE),
    );

    expect(result.errors).toEqual([]);
    const got = result.laps.map((l) => Math.round(l.lapTime * 1000)).sort((a, b) => a - b);
    const want = rows.map((r) => Math.round(r.lapTime * 1000)).sort((a, b) => a - b);
    expect(got).toEqual(want);
  }, 120000);

  test("multi-session archives restore each capture's profile deterministically", async () => {
    const motec = await seedSession({
      source: "motec",
      sourceChannelProfile: MOTEC_SOURCE_PROFILE,
    });
    const external = await seedSession({
      source: "external-log",
      sourceChannelProfile: EXTERNAL_SOURCE_PROFILE,
    });

    const { bytes: zip, manifest } = await buildLapsZip([
      motec.rows[0].id,
      external.rows[1].id,
    ]);
    expect(manifest.entries).toHaveLength(2);
    expect(
      new Map(manifest.entries.map((entry) => [entry.sessionId, entry.sourceChannelProfile])),
    ).toEqual(
      new Map([
        [motec.sid, MOTEC_SOURCE_PROFILE],
        [external.sid, EXTERNAL_SOURCE_PROFILE],
      ]),
    );

    const result = await importLapsZip(zip);
    expect(result.errors).toEqual([]);
    for (const lap of result.laps) createdSessions.push(lap.sessionId);
    const importedSessionIds = [
      ...new Set(result.laps.map((lap) => lap.sessionId)),
    ];
    const entriesByImportOrder = [...manifest.entries].sort((a, b) =>
      a.file.localeCompare(b.file),
    );
    expect(importedSessionIds).toHaveLength(entriesByImportOrder.length);
    for (let i = 0; i < importedSessionIds.length; i++) {
      await expectSessionSource(
        [importedSessionIds[i]],
        "raceiq-archive",
        archivedProfile(entriesByImportOrder[i].sourceChannelProfile!),
      );
    }
  }, 120000);
});
