// scripts/compare-lap-detectors.ts
//
// Manual comparison tool: runs both v1 and v2 lap detectors against every
// .bin recording in test/artifacts/laps/ and prints a side-by-side summary.
//
// Usage: bun run scripts/compare-lap-detectors.ts

import { readdirSync } from "fs";
import { join } from "path";
import { parseDump } from "../test/helpers/parse-dump";
import { parseDumpV2 } from "../test/helpers/parse-dump-v2";
import type { GameId } from "../shared/types";

const DIR = "test/artifacts/laps";

function formatLap(l: {
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  invalidReason: string | null;
}): string {
  const mins = Math.floor(l.lapTime / 60);
  const secs = (l.lapTime % 60).toFixed(3).padStart(6, "0");
  const valid = l.isValid
    ? "valid"
    : `invalid (${l.invalidReason ?? "unknown"})`;
  return `L${l.lapNumber} ${mins}:${secs} ${valid}`;
}

function gameIdFromFilename(f: string): GameId | null {
  if (f.startsWith("acc-")) return "acc";
  if (f.startsWith("fm-2023-")) return "fm-2023";
  if (f.startsWith("f1-2025-")) return "f1-2025";
  return null;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".bin")).sort();

console.log(`\nComparing v1 vs v2 lap detectors on ${files.length} recordings\n`);

for (const f of files) {
  const gameId = gameIdFromFilename(f);
  if (!gameId) {
    console.log(`\n=== ${f} === SKIP (unknown game)`);
    continue;
  }
  const path = join(DIR, f);
  console.log(`\n=== ${f} (${gameId}) ===`);

  let v1: any = null;
  let v2: any = null;
  let v1Error: string | null = null;
  let v2Error: string | null = null;

  try {
    v1 = await parseDump(gameId, path);
  } catch (e) {
    v1Error = (e as Error).message;
    console.log(`v1 ERROR: ${v1Error}`);
  }
  try {
    v2 = await parseDumpV2(gameId, path);
  } catch (e) {
    v2Error = (e as Error).message;
    console.log(`v2 ERROR: ${v2Error}`);
  }

  if (v1) {
    const validCount = v1.laps.filter((l: any) => l.isValid).length;
    console.log(
      `v1: ${v1.laps.length} total laps (${validCount} valid)`
    );
    for (const l of v1.laps) {
      console.log(`  ${formatLap(l)}`);
    }
  }
  if (v2) {
    const validCount = v2.laps.filter((l: any) => l.isValid).length;
    console.log(
      `v2: ${v2.laps.length} total laps (${validCount} valid)`
    );
    for (const l of v2.laps) {
      console.log(`  ${formatLap(l)}`);
    }
  }
}

console.log("\nDone.");
