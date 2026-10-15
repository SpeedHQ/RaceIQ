import { expect, test } from "bun:test";
import Database from "libsql";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUpgradeServer, type UpgradeServer } from "./support/upgrade-server";
import { seedReleaseDatabase } from "./support/release-database";
type Session = { id: number; track_id: string; lap_detector_version: string | null };


test("startup preserves ambiguous historical Tourist laps instead of destructively reprocessing them", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "raceiq-release-upgrade-"));
  let backend: UpgradeServer | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    const { dataDir } = await seedReleaseDatabase(temporary);
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    const before = database.prepare("SELECT id,lap_detector_version FROM sessions ORDER BY id").all() as Array<{ id: number; lap_detector_version: string | null }>;
    // The classification upgrade must not replace stale timing or unrelated session identity.
    database.exec("UPDATE laps SET lap_time=999; UPDATE sessions SET track_id='obsolete layout';");
    const lapIds = database.prepare("SELECT id FROM laps ORDER BY id").all();

    backend = startUpgradeServer(dataDir);
    await backend.ready();
    const deadline = Date.now() + 180_000;
    let outcomes = database.prepare("SELECT state,reason FROM classification_migration_recordings").all() as Array<{ state: string; reason: string | null }>;
    // Another process owns the production backfill; observe durable terminal results.
    while (outcomes.length === 0 || outcomes.some((row) => row.state === "pending" || row.state === "running")) {
      if (Date.now() >= deadline) throw new Error(`Historical classification did not settle: ${JSON.stringify(outcomes)}`);
      await Bun.sleep(20);
      outcomes = database.prepare("SELECT state,reason FROM classification_migration_recordings").all() as typeof outcomes;
    }
    const after = database.prepare("SELECT id,track_id,lap_detector_version FROM sessions ORDER BY id").all() as Session[];
    expect(after.map((session) => session.id)).toEqual(before.map((session) => session.id));
    expect(after.map((session) => session.track_id)).toEqual(before.map(() => "obsolete layout"));
    expect(database.prepare("SELECT id FROM laps ORDER BY id").all()).toEqual(lapIds);
    expect(database.prepare("SELECT id FROM laps WHERE lap_time<>999").all()).toEqual([]);
    expect(outcomes).toContainEqual({ state: "failed", reason: "ambiguous_match" });
  } finally {
    await backend?.stop();
    database?.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 600_000);
