import { expect } from "bun:test";
import type { CapturedLap } from "../../../server/telemetry/pipeline-ports"

export function assertBrandHatchSectorBounds(lap: CapturedLap): void {
  if (!lap.sectors) return;
  const lapTime = lap.lapTime;
  for (const [index, t] of lap.sectors.entries()) {
    const name = `s${index + 1}`;
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
  const ss = s ? s.map((time, index) => `s${index + 1}=${time.toFixed(3)}`).join(" ") : "sectors=null";
  return `  Lap ${l.lapNumber}: ${mins}:${secs.padStart(6, "0")} ${valid} | ${ss}`;
}

export const RECORDINGS_DIR = "test/artifacts/sessions";
