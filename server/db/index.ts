import { createClient as createSqliteClient, type Client, type Transaction } from "@libsql/client/sqlite3";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { migrations } from "./migrations";
import { pendingMigrations } from "./migration-plan";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../runtime/config/data-dir";
import { assertDashboardDatabasePresent } from "../runtime/config/dashboard-access-state";

// Always resolve the data dir, even when the DB itself lives in memory: the
// call doubles as the safety net that throws if a test run somehow reaches
// here with DATA_DIR unset (see server/runtime/config/data-dir.ts), and sibling state such as
// settings.json still lives on disk.
const DB_DIR = resolveDataDir();

/**
 * Opt-in only: set DB_IN_MEMORY=1. Tests deliberately do NOT default to this.
 *
 * `:memory:` in libsql is per-connection, not per-process. Migrations run on
 * the connection this module opens; any second connection the client opens is
 * a brand-new empty database, so queries there fail with "no such table: X"
 * for whichever table they touch. A file: DB is shared across connections and
 * does not have this failure mode.
 *
 * Measured on an 11-file subset: DB_IN_MEMORY=1 gave 59 pass / 18 fail (all
 * "no such table"), the same files on the file DB gave 77 pass / 0 fail.
 * Don't flip this default without re-running that comparison.
 */
const IN_MEMORY = process.env.DB_IN_MEMORY === "1";

// Ensure data directory exists
if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

export const DB_PATH = join(
  DB_DIR,
  process.env.RACEIQ_TEST_MODE === "1" ? "test.db" : "app.db",
);

// Check before libSQL can create a replacement or migrate an older database.
assertDashboardDatabasePresent(DB_PATH);

function migrateLegacyDatabase(): void {
  const legacyPath = join(DB_DIR, "forza-telemetry.db");
  const currentPath = DB_PATH;
  if (!existsSync(legacyPath) || existsSync(currentPath)) return;
  renameSync(legacyPath, currentPath);
  console.log(`[DB] Migrated legacy database from "${legacyPath}" to "${currentPath}".`);
}

if (!IN_MEMORY && process.env.RACEIQ_TEST_MODE !== "1") {
  migrateLegacyDatabase();
}

// The local driver executes synchronously. A second connection's busy wait
// blocks the JS continuation that must commit the first transaction. Keep
// this client's operations ordered, holding its slot for the entire transaction.
// Independent worker clients still coordinate through SQLite's busy timeout.
function serializeClient(nativeClient: Client): Client {
  let tail: Promise<void> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  return new Proxy(nativeClient, {
    get(target, property) {
      if (property === "execute" || property === "batch" || property === "executeMultiple" || property === "migrate") {
        const method = Reflect.get(target, property, target) as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) => enqueue(() => method.apply(target, args));
      }
      if (property === "transaction") {
        const begin = target.transaction.bind(target);
        return (...args: Parameters<Client["transaction"]>) => {
          let expose!: (tx: Transaction) => void;
          let reject!: (error: unknown) => void;
          const exposed = new Promise<Transaction>((resolve, fail) => { expose = resolve; reject = fail; });
          const slot = enqueue(async () => {
            let nativeTx: Transaction;
            try {
              nativeTx = await begin(...args);
            } catch (error) {
              reject(error);
              throw error;
            }
            let release!: () => void;
            const lifetime = new Promise<void>((resolve) => { release = resolve; });
            let released = false;
            const finish = () => {
              if (!released) {
                released = true;
                release();
              }
            };
            const tx = new Proxy(nativeTx, {
              get(txTarget, txProperty) {
                if (txProperty === "commit" || txProperty === "rollback" || txProperty === "close") {
                  const fn = Reflect.get(txTarget, txProperty, txTarget) as (...a: unknown[]) => unknown;
                  return (...a: unknown[]) => {
                    try {
                      const value = fn.apply(txTarget, a);
                      if (value instanceof Promise) return value.finally(() => {
                        try {
                          if (!txTarget.closed) txTarget.close();
                        } finally {
                          finish();
                        }
                      });
                      finish();
                      return value;
                    } catch (error) {
                      try {
                        if (!txTarget.closed) txTarget.close();
                      } finally {
                        finish();
                      }
                      throw error;
                    }
                  };
                }
                const value = Reflect.get(txTarget, txProperty, txTarget);
                return typeof value === "function" ? value.bind(txTarget) : value;
              },
            });
            expose(tx);
            await lifetime;
          });
          void slot.catch(reject);
          return exposed;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const client: Client = serializeClient(createSqliteClient({ url: IN_MEMORY ? ":memory:" : `file:${DB_PATH}` }));

// Bindings are created synchronously so importing this module can never block
// and `db` can never be observed in its temporal dead zone. All async setup
// (PRAGMAs, migrations, backfills) moved into initDb() below.
export const db = drizzle(client, { schema });
export { client };

let initPromise: Promise<void> | null = null;

/**
 * Idempotent async DB setup. Must be awaited once by every entry point before
 * queries run: the server (server/index.ts), the test preload
 * (test/support/setup-data-dir.ts), and standalone scripts.
 *
 * Previously this ran as top-level await in module scope. That made every
 * importer of `db` wait on the module graph, so a SQLite/WAL lock here wedged
 * the whole process before any test started — the per-test timeout could never
 * fire — and any access to `db` while this was suspended threw
 * "Cannot access 'db' before initialization".
 */
export function initDb(): Promise<void> {
  if (!initPromise) initPromise = (async () => {

// Enable WAL mode for better concurrent read/write performance
await client.execute("PRAGMA journal_mode = WAL");
await client.execute("PRAGMA foreign_keys = ON");
// Wait up to 5s when another process holds the write lock (e.g. during hot-reload)
await client.execute("PRAGMA busy_timeout = 5000");

// ── Migration system ────────────────────────────────────────────────
await client.execute(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

async function runMigrations() {
  // Unreleased feature builds used IDs now owned by main. Move only their
  // named ledger entries; preserve their tables, credentials, and sessions.
  const legacy = await client.execute(`SELECT version, name FROM schema_migrations
    WHERE version IN (63, 64, 68) AND name = 'persist dashboard access and login sessions'
       OR version = 63 AND name = 'persist live session bookmarks'`);
  if (legacy.rows.length) {
    const tx = await client.transaction("write");
    try {
      const authRows = legacy.rows.filter((row) => row.name === "persist dashboard access and login sessions");
      if (authRows.length) {
        const existing = await tx.execute("SELECT name FROM schema_migrations WHERE version = 75");
        if (existing.rows.length && existing.rows[0]!.name !== "persist dashboard access and login sessions") {
          throw new Error("Dashboard access migration conflicts with the recorded database history");
        }
        await tx.execute(`INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
          SELECT 75, name, applied_at FROM schema_migrations
          WHERE version IN (63, 64, 68) AND name = 'persist dashboard access and login sessions'
          ORDER BY version DESC LIMIT 1`);
        await tx.execute("DELETE FROM schema_migrations WHERE version IN (63, 64, 68) AND name = 'persist dashboard access and login sessions'");
      }
      await tx.execute("DELETE FROM schema_migrations WHERE version = 63 AND name = 'persist live session bookmarks'");
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
  const appliedRows = await client.execute("SELECT version, name FROM schema_migrations");
  const pending = pendingMigrations(migrations, appliedRows.rows.map((row) => ({
    version: Number(row.version), name: String(row.name),
  })));

  if (pending.length === 0) return;

  console.log(`[DB] Running ${pending.length} migration(s)...`);

  // Disable FK enforcement during migrations so schema rebuilds (e.g. dropping
  // and recreating a table to remove a column default) can proceed even when
  // other tables reference the dropped one. SQLite requires this pragma to be
  // set outside any transaction, which is why it lives at the runner level.
  await client.execute("PRAGMA foreign_keys = OFF");

  try {
    for (const migration of pending) {
      console.log(`[DB]   v${migration.version}: ${migration.name}`);
      const tx = await client.transaction("write");
      try {
        for (const sql of migration.sql) {
          try {
            await tx.execute(sql);
          } catch (stmtErr: unknown) {
            // ALTER TABLE ADD COLUMN is idempotent — ignore "duplicate column name" errors
            const msg = stmtErr instanceof Error ? stmtErr.message : String(stmtErr);
            if (!msg.includes("duplicate column name")) throw stmtErr;
          }
        }
        await tx.execute({
          sql: "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
          args: [migration.version, migration.name],
        });
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    }
  } finally {
    await client.execute("PRAGMA foreign_keys = ON");
  }

  console.log(`[DB] Migrations complete.`);
}

await runMigrations();

// Seed default profile if none exist
const profileCount = await client.execute("SELECT COUNT(*) as c FROM profiles");
if (Number(profileCount.rows[0].c) === 0) {
  await client.execute("INSERT INTO profiles (name) VALUES ('Driver 1')");
}
// Backfill any laps that have no profile assigned
await client.execute("UPDATE laps SET profile_id = (SELECT id FROM profiles ORDER BY id LIMIT 1) WHERE profile_id IS NULL");

// ── Orphaned tuning-stamp sweep ─────────────────────────────────────
// Laps carry experiment_id / experiment_version_id foreign keys, but there is
// no cascade: if a experiments / experiment_versions row disappears (a DB reset
// or swap that drops those tables while laps persist), the laps are left
// pointing at ids that no longer resolve. Those dangling ids make the review
// page (and any tuning dashboard) request a session that 404s. Null them out
// on every boot — idempotent, cheap, and catches orphans from any cause.
const orphanSession = await client.execute(
  "UPDATE laps SET experiment_id = NULL WHERE experiment_id IS NOT NULL AND experiment_id NOT IN (SELECT id FROM experiments)",
);
const orphanTest = await client.execute(
  "UPDATE laps SET experiment_version_id = NULL WHERE experiment_version_id IS NOT NULL AND experiment_version_id NOT IN (SELECT id FROM experiment_versions)",
);
const orphanCleared = Number(orphanSession.rowsAffected ?? 0) + Number(orphanTest.rowsAffected ?? 0);
if (orphanCleared > 0) {
  console.log(`[DB] Cleared ${orphanCleared} orphaned tuning stamp(s) on laps (parent session/test gone)`);
}
  })();
  return initPromise;
}
