import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "libsql";
import { seedReleaseDatabase, prepareOrganizedReleaseData } from "@raceiq/backend/test-support/release-database";
import type { UpgradeServer } from "@raceiq/backend/test-support/upgrade-server";
import { openUpgrade, prepareCurrentSchema, settled } from "@raceiq/backend/test-support/classification-migration";
import { removeProcessDirectory } from "@raceiq/backend/test-support/process";
import { fixturePath } from "../../support/fixtures";

test("production migration persists known incomplete LMU laps and updates other laps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-incomplete-lmu-"));
  let server: UpgradeServer | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    const seeded = await seedReleaseDatabase(directory, {
      gameId: "lmu",
      paths: [fixturePath("laps/lmu-2026-09-19T20-09-44-686Z.bin.gz")],
    });
    await prepareOrganizedReleaseData(seeded.dataDir);
    await prepareCurrentSchema(seeded.dataDir);
    database = new Database(join(seeded.dataDir, "app.db"));
    database.exec("UPDATE laps SET profile_id=1 WHERE profile_id IS NULL;");
    const original = database.prepare("SELECT id,lap_number,classification,is_valid,invalid_reason FROM laps ORDER BY lap_number").all() as Array<{
      id: number; lap_number: number; classification: string | null; is_valid: number; invalid_reason: string | null;
    }>;
    const incomplete = original.find((lap) => lap.invalid_reason === "incomplete");
    if (!incomplete) throw new Error("LMU fixture has no known incomplete lap");
    const updateable = original.find((lap) => lap.id !== incomplete.id);
    if (!updateable) throw new Error("LMU fixture has no additional lap");
    database.prepare("UPDATE laps SET classification='legacy',is_valid=1,invalid_reason=NULL WHERE id=?").run(incomplete.id);
    database.prepare("UPDATE laps SET classification='legacy',is_valid=1,invalid_reason=NULL WHERE id=?").run(updateable.id);
    database.close();
    database = undefined;

    const running = await openUpgrade(seeded.dataDir);
    server = running.server;
    const result = await settled(running.address);
    expect(result.completed).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
    const rows = new Database(join(seeded.dataDir, "app.db"));
    try {
      expect(rows.prepare("SELECT classification,is_valid,invalid_reason FROM laps WHERE id=?").get(incomplete.id)).toMatchObject({
        classification: null, is_valid: 0, invalid_reason: "incomplete",
      });
      expect(rows.prepare("SELECT classification FROM laps WHERE id=?").get(updateable.id)).toMatchObject({
        classification: expect.not.stringMatching(/^legacy$/),
      });
      expect(rows.prepare("SELECT state,reason FROM classification_migration_recordings").all()).toContainEqual(
        expect.objectContaining({ state: "completed", reason: null }),
      );
    } finally {
      rows.close();
    }
  } finally {
    await server?.stop();
    database?.close();
    // Release GC-owned native handles before Windows removes the fixture tree.
    Bun.gc(true);
    await removeProcessDirectory(directory);
  }
}, 240_000);
