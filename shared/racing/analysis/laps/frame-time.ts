interface TimestampedFrame {
  readonly observedAtMs: number;
}

/**
 * Per-frame timestep in seconds, derived from packet timestamps rather than an
 * assumed 60 Hz — F1 and ACC do not always deliver a steady 60 Hz stream, and a
 * hardcoded rate silently scales every estimate by the sample-rate error.
 *
 * The value at index i is the interval between frame i and frame i + 1; the
 * final entry repeats the previous interval. Implausible deltas (clock wrap,
 * dropped packets, duplicate timestamps) fall back to 1/60 s.
 */
export function frameDt(telemetry: readonly TimestampedFrame[]): number[] {
  const n = telemetry.length;
  const dt = new Array<number>(n).fill(1 / 60);
  if (n < 2) return dt;
  for (let i = 0; i < n - 1; i++) {
    const ms = telemetry[i + 1].observedAtMs - telemetry[i].observedAtMs;
    // 1–100 ms covers 10–1000 Hz; anything outside is a clock artefact.
    if (ms >= 1 && ms <= 100) dt[i] = ms / 1000;
  }
  dt[n - 1] = dt[n - 2];
  return dt;
}
