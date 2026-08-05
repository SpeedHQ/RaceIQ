import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-db-seed-"));
  tempDirs.push(dir);
  return dir;
}

async function runSeed(dataDir: string, ...args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(["bun", "scripts/data/seed-db.ts", ...args], {
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

function withSeedDb<T>(dataDir: string, operation: (db: Database) => T): T {
  const db = new Database(join(dataDir, "forza-telemetry.db"));
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function counts(dataDir: string): Record<string, number> {
  return withSeedDb(dataDir, (db) => {
    const tables = ["sessions", "laps", "tunes", "experiments", "experiment_versions", "experiment_focus_events", "lap_analyses", "compare_analyses"];
    const result: Record<string, number> = {};
    for (const table of tables) {
      const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number } | null;
      result[table] = Number(row?.count ?? 0);
    }
    return result;
  });
}

function seededGames(dataDir: string): string[] {
  return withSeedDb(dataDir, (db) => {
    const rows = db.query("SELECT DISTINCT game_id FROM sessions WHERE notes LIKE '%raceiq-demo-seed-v1%' ORDER BY game_id").all() as Array<{ game_id: string }>;
    return rows.map((row) => String(row.game_id));
  });
}
function sessionCountByNotes(dataDir: string, notes: string): number {
  return withSeedDb(dataDir, (db) => {
    const row = db.query("SELECT COUNT(*) AS count FROM sessions WHERE notes = ?").get(notes) as { count: number } | null;
    return Number(row?.count ?? 0);
  });
}

function seededIRacingLaps(dataDir: string): Array<{ lapNumber: number; lapTime: number; isValid: number; invalidReason: string | null; rawFile: string | null }> {
  return withSeedDb(dataDir, (db) => {
    const rows = db.query(
      "SELECT laps.lap_number AS lapNumber, laps.lap_time AS lapTime, laps.is_valid AS isValid, laps.invalid_reason AS invalidReason, sessions.raw_file AS rawFile FROM laps INNER JOIN sessions ON sessions.id = laps.session_id WHERE sessions.game_id = 'iracing' AND sessions.notes LIKE '%raceiq-demo-seed-v1%' ORDER BY laps.lap_number",
    ).all() as Array<{ lapNumber: number; lapTime: number; isValid: number; invalidReason: string | null; rawFile: string | null }>;
    return rows.map((row) => ({
      lapNumber: Number(row.lapNumber),
      lapTime: Number(row.lapTime),
      isValid: Number(row.isValid),
      invalidReason: row.invalidReason == null ? null : String(row.invalidReason),
      rawFile: row.rawFile == null ? null : String(row.rawFile),
    }));
  });
}

function seededIRacingIdentity(dataDir: string): Array<{ kind: string; ordinal: number; name: string }> {
  return withSeedDb(dataDir, (db) => {
    const rows = db.query(
      "SELECT 'car' AS kind, ordinal, name FROM discovered_cars WHERE game_id = 'iracing' UNION ALL SELECT 'track' AS kind, ordinal, name FROM discovered_tracks WHERE game_id = 'iracing' ORDER BY kind, ordinal",
    ).all() as Array<{ kind: string; ordinal: number; name: string }>;
    return rows.map((row) => ({
      kind: String(row.kind),
      ordinal: Number(row.ordinal),
      name: String(row.name),
    }));
  });
}

function assertSeededRawFilesExist(dataDir: string): void {
  const laps = seededIRacingLaps(dataDir);
  expect(laps).toHaveLength(2);
  expect(
    laps.map(({ lapNumber, isValid, invalidReason }) => ({
      lapNumber,
      isValid,
      invalidReason,
    })),
  ).toEqual([
    { lapNumber: 1, isValid: 1, invalidReason: null },
    { lapNumber: 2, isValid: 1, invalidReason: null },
  ]);
  expect(laps.every((lap) => lap.rawFile?.startsWith(join(dataDir, "sessions", "iracing")))).toBe(true);
  expect(laps.every((lap) => lap.rawFile && readFileSync(lap.rawFile).length > 0)).toBe(true);
}

function seededRelationships(dataDir: string): {
  experimentGames: string[];
  f1ExperimentLaps: number;
  nonForzaTunedLaps: number;
  crossGameComparisons: number;
} {
  return withSeedDb(dataDir, (db) => {
    const experimentGames = db.query("SELECT DISTINCT game_id FROM experiments ORDER BY game_id").all() as Array<{ game_id: string }>;
    const f1ExperimentLaps = db.query("SELECT COUNT(*) AS count FROM laps l JOIN sessions s ON s.id = l.session_id WHERE s.game_id = 'f1-2025' AND l.experiment_version_id IS NOT NULL").get() as { count: number } | null;
    const nonForzaTunedLaps = db.query("SELECT COUNT(*) AS count FROM laps l JOIN sessions s ON s.id = l.session_id WHERE s.game_id <> 'fm-2023' AND l.tune_id IS NOT NULL").get() as { count: number } | null;
    const crossGameComparisons = db.query("SELECT COUNT(*) AS count FROM compare_analyses c JOIN laps a ON a.id = c.lap_a_id JOIN sessions sa ON sa.id = a.session_id JOIN laps b ON b.id = c.lap_b_id JOIN sessions sb ON sb.id = b.session_id WHERE sa.game_id <> sb.game_id").get() as { count: number } | null;
    return {
      experimentGames: experimentGames.map((row) => String(row.game_id)),
      f1ExperimentLaps: Number(f1ExperimentLaps?.count ?? 0),
      nonForzaTunedLaps: Number(nonForzaTunedLaps?.count ?? 0),
      crossGameComparisons: Number(crossGameComparisons?.count ?? 0),
    };
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("db:seed", () => {
  test("seeds all supported demo surfaces and is idempotent", async () => {
    const dataDir = makeDataDir();
    const first = await runSeed(dataDir);
    expect(first.code, first.output).toBe(0);
    const initial = counts(dataDir);
    expect(initial.sessions).toBeGreaterThanOrEqual(5);
    expect(initial.laps).toBeGreaterThanOrEqual(16);
    assertSeededRawFilesExist(dataDir);
    expect(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")).onboardingComplete).toBe(true);
    expect(seededGames(dataDir)).toEqual(["ac-evo", "acc", "f1-2025", "fm-2023", "iracing"]);
    expect(seededIRacingIdentity(dataDir)).toEqual([
      { kind: "car", ordinal: 42, name: "GT3 Test Car" },
      { kind: "track", ordinal: 99, name: "Road America" },
    ]);
    expect(initial.experiments).toBe(1);
    expect(initial.experiment_versions).toBe(2);
    expect(initial.experiment_focus_events).toBe(2);
    expect(initial.lap_analyses).toBe(1);
    expect(initial.compare_analyses).toBe(1);
    expect(seededRelationships(dataDir)).toEqual({
      experimentGames: ["f1-2025"],
      f1ExperimentLaps: 5,
      nonForzaTunedLaps: 0,
      crossGameComparisons: 0,
    });

    const second = await runSeed(dataDir);
    expect(second.code, second.output).toBe(0);
    expect(counts(dataDir)).toEqual(initial);
  }, 120000);

  test("reset replaces seed rows without deleting user sessions", async () => {
    const dataDir = makeDataDir();
    const games = "--games=fm-2023,f1-2025";
    const seeded = await runSeed(dataDir, games);
    expect(seeded.code, seeded.output).toBe(0);
    const seededCounts = counts(dataDir);

    withSeedDb(dataDir, (db) => {
      db.query("INSERT INTO sessions (car_ordinal, track_ordinal, game_id, notes) VALUES (?, ?, ?, ?)").run(999, 999, "fm-2023", "real user session");
    });
    const reset = await runSeed(dataDir, "--reset", games);
    expect(reset.code, reset.output).toBe(0);

    expect(counts(dataDir)).toEqual({
      ...seededCounts,
      sessions: seededCounts.sessions + 1,
    });
    expect(sessionCountByNotes(dataDir, "real user session")).toBe(1);
  }, 120000);
});
