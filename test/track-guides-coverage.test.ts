import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { buildTrackGuideContext } from "../server/ai/track-guides";

/** Minimal CSV row parser (no embedded commas/quotes in these files) */
function parseCsv(path: string): Record<string, string>[] {
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function coverage(names: string[]): { covered: string[]; missing: string[]; ratio: number } {
  const covered: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    if (buildTrackGuideContext(name)) covered.push(name);
    else missing.push(name);
  }
  return { covered, missing, ratio: names.length === 0 ? 1 : covered.length / names.length };
}

const root = join(import.meta.dir, "..");

describe("track guide coverage — real-world circuits", () => {
  test("F1 2025 calendar has full guide coverage", () => {
    const rows = parseCsv(join(root, "shared/games/f1-2025/tracks.csv"));
    const names = [...new Set(rows.map((r) => r.name))];
    const { covered, missing, ratio } = coverage(names);
    console.log(`F1 2025: ${covered.length}/${names.length} covered. Missing: ${missing.join(", ")}`);
    expect(ratio).toBe(1);
  });

  test("ACC real circuits have full guide coverage", () => {
    const rows = parseCsv(join(root, "shared/games/acc/tracks.csv"));
    const names = [...new Set(rows.map((r) => r.name))];
    const { covered, missing, ratio } = coverage(names);
    console.log(`ACC: ${covered.length}/${names.length} covered. Missing: ${missing.join(", ")}`);
    expect(ratio).toBe(1);
  });

  test("AC Evo real circuits have full guide coverage", () => {
    const rows = parseCsv(join(root, "shared/games/ac-evo/tracks.csv"));
    const names = [...new Set(rows.map((r) => r.name))];
    const { covered, missing, ratio } = coverage(names);
    console.log(`AC Evo: ${covered.length}/${names.length} covered. Missing: ${missing.join(", ")}`);
    expect(ratio).toBe(1);
  });
});

describe("track guide coverage — FM 2023 (real + fictional circuits)", () => {
  test("full track list has full guide coverage", () => {
    const rows = parseCsv(join(root, "shared/games/fm-2023/tracks.csv"));
    const names = [...new Set(rows.map((r) => r.name))];
    const { covered, missing, ratio } = coverage(names);
    console.log(
      `FM 2023: ${covered.length}/${names.length} covered (${(ratio * 100).toFixed(0)}%). Missing: ${missing.join(", ")}`
    );
    expect(ratio).toBe(1);
  });
});
