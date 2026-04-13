import { expect } from "bun:test";
import type { CapturedLap } from "../../../server/pipeline-adapters";

export function assertBrandHatchSectorBounds(lap: CapturedLap): void {
  if (!lap.sectors) return;
  const { s1, s2, s3 } = lap.sectors;
  const lapTime = lap.lapTime;
  for (const [name, t] of [["s1", s1], ["s2", s2], ["s3", s3]] as [string, number][]) {
    const frac = t / lapTime;
    expect(frac, `${name}=${t.toFixed(3)}s is ${(frac * 100).toFixed(1)}% of lap — outside 20-50% band for Brand Hatch`).toBeGreaterThan(0.20);
    expect(frac, `${name}=${t.toFixed(3)}s is ${(frac * 100).toFixed(1)}% of lap — outside 20-50% band for Brand Hatch`).toBeLessThan(0.50);
  }
}

export function lapSummary(l: CapturedLap): string {
  const mins = Math.floor(l.lapTime / 60);
  const secs = (l.lapTime % 60).toFixed(3);
  const valid = l.isValid ? "valid" : `invalid (${l.invalidReason ?? "unknown"})`;
  const s = l.sectors;
  const ss = s ? `s1=${s.s1.toFixed(3)} s2=${s.s2.toFixed(3)} s3=${s.s3.toFixed(3)}` : "sectors=null";
  return `  Lap ${l.lapNumber}: ${mins}:${secs.padStart(6, "0")} ${valid} | ${ss}`;
}

export const RECORDINGS_DIR = "test/artifacts/laps";
