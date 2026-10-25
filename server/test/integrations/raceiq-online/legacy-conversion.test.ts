import { afterEach, describe, expect, test } from "bun:test";
import Database from "libsql";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-online-legacy-conversion-"));
  tempDirs.push(dir);
  return dir;
}

async function runConversion(dataDir: string): Promise<void> {
  const dbModule = pathToFileURL(join(REPO_ROOT, "server/db/index.ts")).href;
  const conversionModule = pathToFileURL(join(REPO_ROOT, "server/db/online-upload-legacy-conversion.ts")).href;
  const source = `
    import { sql } from "drizzle-orm";
    import { initDb, client, readDb } from ${JSON.stringify(dbModule)};
    import { convertLegacyOnlineLapRequests } from ${JSON.stringify(conversionModule)};
    await initDb();
    await convertLegacyOnlineLapRequests();
    const state = await readDb.all(sql\`SELECT complete FROM online_legacy_upload_conversion_state WHERE id=1\`);
    if (Number(state[0]?.complete) !== 1) throw new Error("Conversion did not persist completion state");
    await convertLegacyOnlineLapRequests();
    const repeated = await readDb.all(sql\`SELECT COUNT(*) AS count FROM online_legacy_upload_conversion_state WHERE id=1\`);
    if (Number(repeated[0]?.count) !== 1) throw new Error("Repeated conversion changed conversion state");
    await client.close();
  `;
  const proc = Bun.spawn(["bun", "--eval", source], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 55_000);
  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`Conversion fixture failed:\n${stdout}\n${stderr}`);
  } finally {
    clearTimeout(timeout);
    if (proc.exitCode === null) {
      proc.kill();
      await proc.exited;
    }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("legacy online upload conversion driver", () => {
  test("keeps existing legacy DB intact and safely repeats conversion", async () => {
    const dataDir = makeDataDir();
    const legacyPath = join(dataDir, "raceiq-online-outbox.db");
    const legacy = new Database(legacyPath);
    legacy.exec("CREATE TABLE raceiq_online_outbox (row_id INTEGER PRIMARY KEY, lap_id INTEGER NOT NULL, account_id TEXT NOT NULL, status TEXT NOT NULL, upload_key TEXT, identity_json TEXT, payload_fingerprint TEXT, reservation_token TEXT, remote_job_id TEXT, transmitted_at INTEGER, updated_at INTEGER, last_error_code TEXT)");
    legacy.close();
    const before = readFileSync(legacyPath);

    await runConversion(dataDir);

    expect(readFileSync(legacyPath)).toEqual(before);
  }, 60_000);
  test("does not create missing legacy DB", async () => {
    const dataDir = makeDataDir();
    const legacyPath = join(dataDir, "raceiq-online-outbox.db");

    await runConversion(dataDir);

    expect(existsSync(legacyPath)).toBe(false);
  }, 60_000);
});
