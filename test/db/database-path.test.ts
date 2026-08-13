import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DATABASE_SUFFIXES = ["", "-wal", "-shm"] as const;
const REPO_ROOT = process.cwd();
const DATABASE_MODULE_URL = pathToFileURL(join(REPO_ROOT, "server/db/index.ts")).href;
const MIGRATIONS_MODULE_URL = pathToFileURL(join(REPO_ROOT, "test/support/db/migrations.ts")).href;
const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-database-path-"));
  tempDirs.push(dir);
  return dir;
}

function databaseArtifacts(databasePath: string): string[] {
  return DATABASE_SUFFIXES.map((suffix) => `${databasePath}${suffix}`);
}

function snapshotArtifacts(databasePath: string): Array<string | null> {
  return databaseArtifacts(databasePath).map((artifactPath) =>
    existsSync(artifactPath) ? readFileSync(artifactPath).toString("base64") : null,
  );
}

function expectArtifactsAbsent(databasePath: string): void {
  for (const artifactPath of databaseArtifacts(databasePath)) {
    expect(existsSync(artifactPath), `${artifactPath} should not exist`).toBe(false);
  }
}

async function runDbStartup(dataDir: string): Promise<{ code: number; output: string }> {
  const env: Record<string, string | undefined> = { ...process.env, DATA_DIR: dataDir };
  delete env.RACEIQ_TEST_MODE;
  delete env.DB_IN_MEMORY;

  // Child import must occur after isolated env setup; parent owns preloaded test client.
  const source = `
    const database = await import(${JSON.stringify(DATABASE_MODULE_URL)});
    try {
      await database.initDb();
    } finally {
      database.client.close();
    }
  `;
  const proc = Bun.spawn(["bun", "--eval", source], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

async function createFixture(databasePath: string, profileName: string): Promise<void> {
  // Separate process guarantees native libSQL handles are gone before rename tests.
  const source = `
    import { createClient } from "@libsql/client/sqlite3";
    import { bootstrap, runMigrations } from ${JSON.stringify(MIGRATIONS_MODULE_URL)};

    const client = createClient({ url: ${JSON.stringify(`file:${databasePath}`)} });
    try {
      await bootstrap(client);
      await runMigrations(client);
      await client.execute({
        sql: "INSERT INTO profiles (name) VALUES (?)",
        args: [${JSON.stringify(profileName)}],
      });
    } finally {
      client.close();
    }
  `;
  const proc = Bun.spawn(["bun", "--eval", source], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`Failed to create database fixture:\n${stdout}\n${stderr}`);
  }
}

function profileNames(databasePath: string): string[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    const rows = database.query("SELECT name FROM profiles ORDER BY id").all() as Array<{ name: string }>;
    return rows.map(({ name }) => name);
  } finally {
    database.close();
  }
}

afterEach(async () => {
  for (const dataDir of tempDirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        break;
      } catch (error) {
        const isBusyOnWindows = process.platform === "win32"
          && error instanceof Error
          && "code" in error
          && error.code === "EBUSY";
        if (!isBusyOnWindows || attempt === 9) throw error;
        // Real delay waits for Windows to release external SQLite file handles.
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 200);
        await promise;
      }
    }
  }
});

describe("production database path", () => {
  test("fresh startup creates only app.db", async () => {
    const dataDir = makeDataDir();
    const appPath = join(dataDir, "app.db");
    const legacyPath = join(dataDir, "forza-telemetry.db");
    const testPath = join(dataDir, "test.db");

    const result = await runDbStartup(dataDir);

    expect(result.code, result.output).toBe(0);
    expect(existsSync(appPath)).toBe(true);
    expectArtifactsAbsent(legacyPath);
    expectArtifactsAbsent(testPath);
    expect(profileNames(appPath)).toEqual(["Driver 1"]);
  });

  test("legacy-only startup transfers existing data to app.db", async () => {
    const dataDir = makeDataDir();
    const appPath = join(dataDir, "app.db");
    const legacyPath = join(dataDir, "forza-telemetry.db");
    const testPath = join(dataDir, "test.db");
    const sentinel = `legacy-profile-${crypto.randomUUID()}`;
    await createFixture(legacyPath, sentinel);

    const result = await runDbStartup(dataDir);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("[DB] Migrated legacy database");
    expect(profileNames(appPath)).toEqual([sentinel]);
    expectArtifactsAbsent(legacyPath);
    expectArtifactsAbsent(testPath);
  });

  test("app-only startup retains existing data", async () => {
    const dataDir = makeDataDir();
    const appPath = join(dataDir, "app.db");
    const legacyPath = join(dataDir, "forza-telemetry.db");
    const testPath = join(dataDir, "test.db");
    const sentinel = `app-profile-${crypto.randomUUID()}`;
    await createFixture(appPath, sentinel);

    const result = await runDbStartup(dataDir);

    expect(result.code, result.output).toBe(0);
    expect(profileNames(appPath)).toEqual([sentinel]);
    expectArtifactsAbsent(legacyPath);
    expectArtifactsAbsent(testPath);
  });

  test("dual-file startup keeps app.db and continues", async () => {
    const dataDir = makeDataDir();
    const appPath = join(dataDir, "app.db");
    const legacyPath = join(dataDir, "forza-telemetry.db");
    const testPath = join(dataDir, "test.db");
    await createFixture(appPath, `app-profile-${crypto.randomUUID()}`);
    await createFixture(legacyPath, `legacy-profile-${crypto.randomUUID()}`);
    const appBefore = snapshotArtifacts(appPath);
    const legacyBefore = snapshotArtifacts(legacyPath);

    const result = await runDbStartup(dataDir);

    expect(result.code, result.output).toBe(0);
    expect(profileNames(appPath)).toEqual([expect.stringContaining("app-profile-")]);
    expect(snapshotArtifacts(legacyPath)).toEqual(legacyBefore);
    expectArtifactsAbsent(testPath);
  });
});
