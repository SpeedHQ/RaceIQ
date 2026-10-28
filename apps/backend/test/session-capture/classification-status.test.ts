import { expect, test } from "bun:test";
import { client, db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { CLASSIFICATION_MIGRATION_VERSION, getClassificationMigrationStatus, listClassificationMigrationRecordings } from "@raceiq/backend-core/session-capture/classification-migration";

test("historical classification ignores summary work from sessions created after its cutoff", async () => {
  const originalMeta = (await client.execute("SELECT version,cutoff_session_id FROM classification_migration_meta WHERE id=1")).rows[0]!;
  const originalDirty = (await client.execute("SELECT session_id,metadata_dirty,capture_dirty FROM dashboard_summary_state WHERE metadata_dirty=1 OR capture_dirty=1")).rows;
  const historical = await db.insert(sessions).values({ gameId: "ams2", carId: "test", trackId: "test", ownership: "mine" }).returning().get();
  const newer = await db.insert(sessions).values({ gameId: "ac-evo", carId: "test", trackId: "test", ownership: "mine" }).returning().get();
  try {
    await client.execute("UPDATE dashboard_summary_state SET metadata_dirty=0,capture_dirty=0");
    await client.execute({ sql: "UPDATE classification_migration_meta SET version=?,cutoff_session_id=? WHERE id=1", args: [CLASSIFICATION_MIGRATION_VERSION, historical!.id] });
    await client.execute({ sql: "INSERT INTO classification_migration_recordings(recording_id,source_key,version,state) VALUES('test-complete','session:' || ?,?,'completed')", args: [historical!.id, CLASSIFICATION_MIGRATION_VERSION] });
    await client.execute({ sql: "UPDATE dashboard_summary_state SET metadata_dirty=0,capture_dirty=0 WHERE session_id IN (?,?)", args: [historical!.id, newer!.id] });
    await client.execute({ sql: "UPDATE dashboard_summary_state SET capture_dirty=1,capture_ready=0 WHERE session_id=?", args: [newer!.id] });
    expect(await getClassificationMigrationStatus()).toMatchObject({ status: "complete", aggregatesPending: false });
    expect(await listClassificationMigrationRecordings(10)).not.toBeNull();
    await client.execute({ sql: "UPDATE dashboard_summary_state SET capture_dirty=1,capture_ready=1 WHERE session_id=?", args: [historical!.id] });
    expect(await getClassificationMigrationStatus()).toMatchObject({ status: "running", aggregatesPending: true });
    await client.execute({ sql: "UPDATE dashboard_summary_state SET capture_dirty=0 WHERE session_id=?", args: [historical!.id] });
    expect(await getClassificationMigrationStatus()).toMatchObject({ status: "complete", aggregatesPending: false });
  } finally {
    await client.execute("DELETE FROM classification_migration_recordings WHERE recording_id='test-complete'");
    for (const row of originalDirty) {
      await client.execute({ sql: "UPDATE dashboard_summary_state SET metadata_dirty=?,capture_dirty=? WHERE session_id=?", args: [row.metadata_dirty, row.capture_dirty, row.session_id] });
    }
    await client.execute({ sql: "DELETE FROM sessions WHERE id IN (?,?)", args: [historical!.id, newer!.id] });
    await client.execute({ sql: "UPDATE classification_migration_meta SET version=?,cutoff_session_id=? WHERE id=1", args: [originalMeta.version!, originalMeta.cutoff_session_id!] });
  }
});
