import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import Papa from "papaparse";
import { hasTrackGuide } from "../server/ai/track-guides";

function parseCsv(path: string): Record<string, string>[] {
  const { data } = Papa.parse<Record<string, string>>(readFileSync(path, "utf-8"), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    transform: (v) => v.trim(),
  });
  return data;
}

function coverage(names: string[]): { covered: string[]; missing: string[]; ratio: number } {
  const covered: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    if (hasTrackGuide(name)) covered.push(name);
    else missing.push(name);
  }
  return { covered, missing, ratio: names.length === 0 ? 1 : covered.length / names.length };
}

/**
 * Distinct track guides referenced by a game. Keyed on `commonTrackName` (the
 * per-variant guide id), NOT the display `name` — multiple layouts share a name
 * (e.g. Brands Hatch GP + Indy) and deduping on name hides missing variant guides.
 */
function guideIds(rows: Record<string, string>[]): string[] {
  return [...new Set(rows.map((r) => r.commonTrackName).filter(Boolean))];
}

const root = join(import.meta.dir, "..");

describe("track guide coverage — real-world circuits", () => {
  test("F1 2025 calendar has full guide coverage", () => {
    const rows = parseCsv(join(root, "shared/games/f1-2025/tracks.csv"));
    const names = guideIds(rows);
    const { covered, missing, ratio } = coverage(names);
    console.log(`F1 2025: ${covered.length}/${names.length} covered. Missing: ${missing.join(", ")}`);
    expect(ratio).toBe(1);
  });

  test("ACC real circuits have full guide coverage", () => {
    const rows = parseCsv(join(root, "shared/games/acc/tracks.csv"));
    const names = guideIds(rows);
    const { covered, missing, ratio } = coverage(names);
    console.log(`ACC: ${covered.length}/${names.length} covered. Missing: ${missing.join(", ")}`);
    expect(ratio).toBe(1);
  });

  test("AC Evo real circuits have full guide coverage", () => {
    const rows = parseCsv(join(root, "shared/games/ac-evo/tracks.csv"));
    const names = guideIds(rows);
    const { covered, missing, ratio } = coverage(names);
    console.log(`AC Evo: ${covered.length}/${names.length} covered. Missing: ${missing.join(", ")}`);
    expect(ratio).toBe(1);
  });
});

describe("track guide coverage — FM 2023 (real + fictional circuits)", () => {
  test("full track list has full guide coverage", () => {
    const rows = parseCsv(join(root, "shared/games/fm-2023/tracks.csv"));
    const names = guideIds(rows);
    const { covered, missing, ratio } = coverage(names);
    console.log(
      `FM 2023: ${covered.length}/${names.length} covered (${(ratio * 100).toFixed(0)}%). Missing: ${missing.join(", ")}`
    );
    expect(ratio).toBe(1);
  });
});
