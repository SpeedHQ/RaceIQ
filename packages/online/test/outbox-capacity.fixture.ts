import assert from "node:assert/strict";
import { join } from "node:path";
import { createClient } from "@libsql/client/sqlite3";
import {
  beginOutboxAttempt, enqueueOutboxJob, ensureOutboxStorage, getAccountOutboxStatus,
  getOutboxJob, listDeliverableOutboxJobs, listRetiredOutboxPayloads, persistOutboxPayload,
  settleOutboxDelivery, withdrawAccountOutboxJobs,
} from "../src/outbox-storage";

const directory = process.env.DATA_DIR;
if (!directory) throw new Error("DATA_DIR required for isolated capacity fixture");
await ensureOutboxStorage();
const database = createClient({ url: `file:${join(directory, "raceiq-online-outbox.db")}` });
const candidate = {
  accountId: "history-owner", accountEpoch: "epoch", gameId: "acc", trackId: "track",
  carId: "car", lapId: 2001, lapTimeMs: 90000,
};
try {
  await database.execute(`WITH RECURSIVE sequence(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<1000
  ) INSERT INTO raceiq_online_outbox
    (account_id,account_epoch,game_id,track_id,car_id,lap_id,lap_time_ms,status,
     retry_not_before_at,created_at,updated_at,upload_key,transmitted_at)
    SELECT 'history-owner','epoch','acc','track','car',n,200000-n,
      CASE n%3 WHEN 0 THEN 'rejected' WHEN 1 THEN 'transmitted' ELSE 'withdrawn' END,
      0,0,0,'history-'||n,CASE WHEN n%3=1 THEN 1234 ELSE NULL END FROM sequence`);
  assert.equal(await enqueueOutboxJob(candidate), "queued", "terminal history must not consume capacity");
  assert.equal((await getAccountOutboxStatus(candidate.accountId)).lastSyncedAt, new Date(1234).toISOString());
  assert.equal(await enqueueOutboxJob({ ...candidate, lapId: 1, lapTimeMs: 100000 }), "unchanged",
    "transmitted lap identity must remain deduplicated");
  await withdrawAccountOutboxJobs(candidate.accountId);

  await database.execute(`WITH RECURSIVE sequence(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<1000
  ) INSERT INTO raceiq_online_outbox
    (account_id,account_epoch,game_id,track_id,car_id,lap_id,lap_time_ms,status,
     retry_not_before_at,created_at,updated_at,upload_key)
    SELECT 'capacity-owner','epoch','acc','track-'||n,'car',n,90000,
      CASE n%3 WHEN 1 THEN 'pending' WHEN 2 THEN 'dispatching' ELSE 'ambiguous' END,
      0,0,0,'active-'||n FROM sequence`);
  const fullCandidate = { ...candidate, accountId: "capacity-owner", trackId: "new-track" };
  assert.equal(await enqueueOutboxJob(fullCandidate), "full", "all unresolved statuses must consume account capacity");
  const original = (await listDeliverableOutboxJobs(fullCandidate.accountId)).find(row => row.trackId === "track-1");
  assert.ok(original);
  const recordingPath = join(directory, "online-upload-payloads", "capacity-original.bin");
  assert.ok(await persistOutboxPayload(original, { fingerprint: "capacity-original", recordingPath, setupPath: null }));
  const replacement = { ...fullCandidate, trackId: "track-1", lapTimeMs: 80000 };
  assert.equal(await enqueueOutboxJob(replacement), "queued", "faster replacement must fit at account capacity");
  assert.equal((await getOutboxJob(original.rowId, original.accountId))?.status, "withdrawn");
  assert.deepEqual(await listRetiredOutboxPayloads(), [{ rowId: original.rowId, recordingPath, setupPath: null }]);
  assert.equal(await enqueueOutboxJob(fullCandidate), "full", "replacement must not increase active capacity");

  await database.execute(`WITH RECURSIVE sequence(n) AS (
    SELECT 1001 UNION ALL SELECT n+1 FROM sequence WHERE n<10000
  ) INSERT INTO raceiq_online_outbox
    (account_id,account_epoch,game_id,track_id,car_id,lap_id,lap_time_ms,status,
     retry_not_before_at,created_at,updated_at,upload_key)
    SELECT 'global-owner-'||n,'epoch','acc','track','car',n,90000,
      CASE n%3 WHEN 1 THEN 'pending' WHEN 2 THEN 'dispatching' ELSE 'ambiguous' END,
      0,0,0,'global-'||n FROM sequence`);
  const globalCandidate = { ...candidate, accountId: "global-new-owner" };
  assert.equal(await enqueueOutboxJob(globalCandidate), "full", "global active-work cap must remain enforced");
  const pending = (await listDeliverableOutboxJobs(replacement.accountId)).find(row => row.lapId === replacement.lapId);
  assert.ok(pending?.uploadKey);
  const attempt = await beginOutboxAttempt({ rowId: pending.rowId, accountId: pending.accountId,
    accountEpoch: pending.accountEpoch, uploadKey: pending.uploadKey, attempts: 1 });
  assert.ok(attempt);
  assert.equal(await settleOutboxDelivery({ job: attempt, status: "rejected", errorCode: "validation_rejected" }), true);
  assert.equal(await enqueueOutboxJob(globalCandidate), "queued", "terminal settlement must release global capacity");
  console.log("active-capacity-history-and-replacement-verified");
} finally {
  await database.close();
}
