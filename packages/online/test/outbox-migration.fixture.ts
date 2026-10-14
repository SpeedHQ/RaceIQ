import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client/sqlite3";
import { enqueueOutboxJob, listDeliverableOutboxJobs, ensureOutboxStorage } from "../src/outbox-storage";

const directory = process.env.DATA_DIR;
if (!directory) throw new Error("DATA_DIR required");
mkdirSync(directory, { recursive: true });
const database = createClient({ url: `file:${join(directory, "raceiq-online-outbox.db")}` });
const existing = await database.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='raceiq_online_outbox'");
if (existing.rows.length === 0) {
  await database.execute(`CREATE TABLE raceiq_online_outbox (
    row_id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, account_epoch TEXT NOT NULL,
    game_id TEXT NOT NULL, track_id TEXT NOT NULL, car_id TEXT NOT NULL, lap_id INTEGER NOT NULL,
    lap_time_ms INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_error_code TEXT, eligibility_proof_id TEXT
  )`);
  await database.execute("CREATE TABLE raceiq_online_outbox_migrations (version INTEGER PRIMARY KEY)");
  await database.execute(`INSERT INTO raceiq_online_outbox VALUES
    (1,'legacy-owner','legacy-epoch','acc','legacy-track','car',1,90000,'transmitted',1,0,10,1234,NULL,NULL),
    (2,'legacy-owner','legacy-epoch','acc','keyless-track','car',2,91000,'pending',0,0,20,20,NULL,NULL)`);
}
await database.close();
await ensureOutboxStorage();
const seedDb = createClient({ url: `file:${join(directory, "raceiq-online-outbox.db")}` });
await seedDb.execute(`INSERT OR IGNORE INTO raceiq_online_outbox
  (row_id,account_id,account_epoch,game_id,track_id,car_id,lap_id,lap_time_ms,status,attempts,
   retry_not_before_at,created_at,updated_at,upload_key,last_error_code)
  VALUES (3,'recovery-owner','recovery-epoch','acc','prepayload-track','car',3,88000,'dispatching',1,0,30,30,'same-upload-key',NULL),
         (4,'recovery-owner','recovery-epoch','acc','stranded-track','car',4,87000,'ambiguous',1,0,31,31,'stranded-upload-key','process_interrupted'),
         (5,'recovery-owner','recovery-epoch','acc','uncertain-track','car',5,86000,'ambiguous',1,0,32,32,'uncertain-upload-key','network_uncertain'),
         (6,'recovery-owner','old-epoch','acc','cross-epoch-track','car',6,85000,'dispatching',1,0,33,33,'old-cross-epoch-key',NULL),
         (7,'recovery-owner','new-epoch','acc','cross-epoch-track','car',7,84000,'pending',0,0,34,34,'new-cross-epoch-key',NULL)`);
await seedDb.close();
const resultDb = createClient({ url: `file:${join(directory, "raceiq-online-outbox.db")}` });
const rows = await resultDb.execute("SELECT status,upload_key,transmitted_at FROM raceiq_online_outbox ORDER BY row_id");
const deliverable = await listDeliverableOutboxJobs("legacy-owner");
const recovered = await listDeliverableOutboxJobs("recovery-owner");
console.log(JSON.stringify({ rows: rows.rows, deliverableCount: deliverable.length,
  recovered: recovered.map(row => ({ uploadKey: row.uploadKey, trackId: row.trackId })) }));
await resultDb.close();
