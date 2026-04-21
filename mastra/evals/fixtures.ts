/**
 * Fixture loader for AI quality evals.
 *
 * A fixture is a small JSON file in `test/ai-fixtures/laps/` (solo laps) or
 * `test/ai-fixtures/compare-pairs/` (paired laps) describing a real lap
 * exported via `bun run laps:export`, plus an `expected` signal bundle that
 * scorers use as ground truth.
 *
 * Fixtures point to a zip file on disk (`packetsPath`) relative to the
 * fixture directory. The loader unzips, grabs the CSV, and hands back the
 * parsed TelemetryPacket array — but it only does that work when you ask
 * for packets via `loadLapPackets()`, so the file listing step stays fast
 * and can run without the zip present.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { unzipSync } from "fflate";
import type { TelemetryPacket, GameId } from "../../shared/types";
import { decompressTelemetry } from "../../server/db/queries";

const FIXTURES_ROOT = resolve(import.meta.dir, "../../test/ai-fixtures");

export interface LapFixture {
  id: string;
  game: GameId;
  units: "metric" | "imperial";
  lap: {
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    carOrdinal: number;
    trackOrdinal: number;
  };
  /** Relative to fixture file: zip produced via `laps:export --ids X`. */
  packetsPath: string;
  /** Which entry inside the zip is this lap (default: first `lap_*.csv.gz`). */
  packetsEntry?: string;
  expected: LapExpected;
  /** Absolute path of the fixture JSON itself — the loader sets this. */
  __file: string;
}

export interface LapExpected {
  /** Top-N slowest corners the analyst should flag. */
  slowestCorners: string[];
  /** All corner names on the track (superset of slowestCorners). */
  trackCorners: string[];
  /** Dominant issue in one phrase (e.g. "rear tire overheat"). */
  dominantIssue?: string;
  /** Direction of the recommended setup fix, for later scorers. */
  setupDirection?: { component: string; direction: "increase" | "decrease" | "adjust" };
}

export interface ComparePairFixture {
  id: string;
  game: GameId;
  units: "metric" | "imperial";
  lapA: LapFixture["lap"] & { packetsPath: string; packetsEntry?: string };
  lapB: LapFixture["lap"] & { packetsPath: string; packetsEntry?: string };
  expected: CompareExpected;
  __file: string;
}

export interface CompareExpected {
  fasterLap: "A" | "B";
  trackCorners: string[];
  /** Optional: which sector (1-based) is the faster lap gaining most in. */
  gainingSector?: number;
}

export function listLapFixtures(): LapFixture[] {
  const dir = join(FIXTURES_ROOT, "laps");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = join(dir, f);
      const raw = JSON.parse(readFileSync(full, "utf-8")) as Omit<LapFixture, "__file">;
      return { ...raw, __file: full };
    });
}

export function listComparePairFixtures(): ComparePairFixture[] {
  const dir = join(FIXTURES_ROOT, "compare-pairs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = join(dir, f);
      const raw = JSON.parse(readFileSync(full, "utf-8")) as Omit<ComparePairFixture, "__file">;
      return { ...raw, __file: full };
    });
}

/**
 * Resolve a packets path relative to the fixture file and load the lap's
 * telemetry packets. Returns null if the zip is missing so tests can skip
 * cleanly on a fresh clone.
 */
export function loadLapPackets(
  fixtureFile: string,
  packetsPath: string,
  packetsEntry?: string,
): TelemetryPacket[] | null {
  const zipPath = resolve(dirname(fixtureFile), packetsPath);
  if (!existsSync(zipPath)) return null;

  const buf = readFileSync(zipPath);
  const entries = unzipSync(new Uint8Array(buf));
  const targetName = packetsEntry
    ?? Object.keys(entries).find((k) => k.startsWith("lap_") && k.endsWith(".csv.gz"));
  if (!targetName || !entries[targetName]) return null;

  const csvGz = Buffer.from(entries[targetName]);
  return decompressTelemetry(csvGz);
}
