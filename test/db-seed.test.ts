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

async function seededRelationships(dataDir: string): Promise<{
  experimentGames: string[];
  f1ExperimentLaps: number;
  nonForzaTunedLaps: number;
  crossGameComparisons: number;
}> {
  const client = createClient({ url: `file:${join(dataDir, "forza-telemetry.db")}` });
  try {
    const [experimentGames, f1ExperimentLaps, nonForzaTunedLaps, crossGameComparisons] = await Promise.all([
      client.execute("SELECT DISTINCT game_id FROM experiments ORDER BY game_id"),
      client.execute("SELECT COUNT(*) AS count FROM laps l JOIN sessions s ON s.id = l.session_id WHERE s.game_id = 'f1-2025' AND l.experiment_version_id IS NOT NULL"),
      client.execute("SELECT COUNT(*) AS count FROM laps l JOIN sessions s ON s.id = l.session_id WHERE s.game_id <> 'fm-2023' AND l.tune_id IS NOT NULL"),
      client.execute("SELECT COUNT(*) AS count FROM compare_analyses c JOIN laps a ON a.id = c.lap_a_id JOIN sessions sa ON sa.id = a.session_id JOIN laps b ON b.id = c.lap_b_id JOIN sessions sb ON sb.id = b.session_id WHERE sa.game_id <> sb.game_id"),
    ]);
    return {
      experimentGames: experimentGames.rows.map((row) => String(row.game_id)),
      f1ExperimentLaps: Number(f1ExperimentLaps.rows[0]?.count ?? 0),
      nonForzaTunedLaps: Number(nonForzaTunedLaps.rows[0]?.count ?? 0),
      crossGameComparisons: Number(crossGameComparisons.rows[0]?.count ?? 0),
    };
  } finally {
    client.close();
  }
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
    expect(initial.laps).toBeGreaterThanOrEqual(14);
    expect(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")).onboardingComplete).toBe(true);
    expect(await seededGames(dataDir)).toEqual(["ac-evo", "acc", "f1-2025", "fm-2023", "iracing"]);
    expect(initial.experiments).toBe(1);
    expect(initial.experiment_versions).toBe(2);
    expect(initial.experiment_focus_events).toBe(2);
    expect(initial.lap_analyses).toBe(1);
    expect(initial.compare_analyses).toBe(1);
    expect(await seededRelationships(dataDir)).toEqual({
      experimentGames: ["f1-2025"],
      f1ExperimentLaps: 5,
      nonForzaTunedLaps: 0,
      crossGameComparisons: 0,
    });

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
