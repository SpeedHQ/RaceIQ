import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client/sqlite3";

const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-db-seed-"));
  tempDirs.push(dir);
  return dir;
}

async function runSeed(dataDir: string, ...args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(["bun", "scripts/seed-db.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir },
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

async function counts(dataDir: string): Promise<Record<string, number>> {
  const client = createClient({ url: `file:${join(dataDir, "forza-telemetry.db")}` });
  try {
    const tables = ["sessions", "laps", "tunes", "experiments", "experiment_versions", "experiment_focus_events", "lap_analyses", "compare_analyses"];
    const result: Record<string, number> = {};
    for (const table of tables) {
      const rows = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
      result[table] = Number(rows.rows[0]?.count ?? 0);
    }
    return result;
  } finally {
    client.close();
  }
}

async function seededGames(dataDir: string): Promise<string[]> {
  const client = createClient({ url: `file:${join(dataDir, "forza-telemetry.db")}` });
  try {
    const rows = await client.execute("SELECT DISTINCT game_id FROM sessions WHERE notes LIKE '%raceiq-demo-seed-v1%' ORDER BY game_id");
    return rows.rows.map((row) => String(row.game_id));
  } finally {
    client.close();
  }
}
async function seededIRacingLaps(dataDir: string): Promise<Array<{ lapTime: number; isValid: number; rawFile: string | null }>> {
  const client = createClient({ url: `file:${join(dataDir, "forza-telemetry.db")}` });
  try {
    const rows = await client.execute(
      "SELECT laps.lap_time AS lapTime, laps.is_valid AS isValid, sessions.raw_file AS rawFile FROM laps INNER JOIN sessions ON sessions.id = laps.session_id WHERE sessions.game_id = 'iracing' AND sessions.notes LIKE '%raceiq-demo-seed-v1%' ORDER BY laps.lap_number",
    );
    return rows.rows.map((row) => ({
      lapTime: Number(row.lapTime),
      isValid: Number(row.isValid),
      rawFile: row.rawFile == null ? null : String(row.rawFile),
    }));
  } finally {
    client.close();
  }
}

async function assertSeededRawFilesExist(dataDir: string): Promise<void> {
  const laps = await seededIRacingLaps(dataDir);
  expect(laps).toHaveLength(2);
  expect(laps.every((lap) => lap.isValid === 1)).toBe(true);
  expect(laps.every((lap) => lap.rawFile?.startsWith(join(dataDir, "sessions", "iracing")))).toBe(true);
  expect(laps.every((lap) => lap.rawFile && readFileSync(lap.rawFile).length > 0)).toBe(true);
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 9) throw err;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
});

describe("db:seed", () => {
  test("seeds all supported demo surfaces and is idempotent", async () => {
    const dataDir = makeDataDir();
    const first = await runSeed(dataDir);
    expect(first.code, first.output).toBe(0);
    const initial = await counts(dataDir);
    expect(initial.sessions).toBeGreaterThanOrEqual(5);
    expect(initial.laps).toBeGreaterThanOrEqual(16);
    await assertSeededRawFilesExist(dataDir);
    expect(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")).onboardingComplete).toBe(true);
    expect(await seededGames(dataDir)).toEqual(["ac-evo", "acc", "f1-2025", "fm-2023", "iracing"]);
    expect(initial.experiments).toBe(1);
    expect(initial.experiment_versions).toBe(2);
    expect(initial.experiment_focus_events).toBe(2);
    expect(initial.lap_analyses).toBe(1);
    expect(initial.compare_analyses).toBe(1);

    const second = await runSeed(dataDir);
    expect(second.code, second.output).toBe(0);
    expect(await counts(dataDir)).toEqual(initial);
  }, 120000);

  test("reset replaces seed rows without deleting user sessions", async () => {
    const dataDir = makeDataDir();
    const seeded = await runSeed(dataDir);
    expect(seeded.code, seeded.output).toBe(0);

    const client = createClient({ url: `file:${join(dataDir, "forza-telemetry.db")}` });
    try {
      await client.execute({
        sql: "INSERT INTO sessions (car_ordinal, track_ordinal, game_id, notes) VALUES (?, ?, ?, ?)",
        args: [999, 999, "fm-2023", "real user session"],
      });
    } finally {
      client.close();
    }
    const reset = await runSeed(dataDir, "--reset");
    expect(reset.code, reset.output).toBe(0);

    const final = await counts(dataDir);
    expect(final.sessions).toBeGreaterThanOrEqual(4);
    expect(final.tunes).toBe(2);
    expect(final.experiments).toBe(1);
  }, 120000);
});
