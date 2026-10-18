import type { RecordingFrequencyHz } from "@raceiq/shared/platform/runtime/recording-frequency";

/** Allocation-free phase admission; missed periods never queue duplicate frames. */
export class NativeCaptureRateLimiter {
  private frequencyHz = 0;
  private deadlineMs = 0;
  private lastNowMs = -Infinity;

  shouldCapture(nowMs: number, frequencyHz: RecordingFrequencyHz): boolean {
    const periodMs = 1000 / frequencyHz;
    if (frequencyHz !== this.frequencyHz || nowMs < this.lastNowMs) {
      this.frequencyHz = frequencyHz;
      this.lastNowMs = nowMs;
      this.deadlineMs = nowMs + periodMs;
      return true;
    }
    this.lastNowMs = nowMs;
    // Sub-microsecond tolerance prevents accumulated floating-point boundary loss.
    const toleranceMs = 1e-7;
    if (nowMs + toleranceMs < this.deadlineMs) return false;
    this.deadlineMs += (Math.floor((nowMs - this.deadlineMs + toleranceMs) / periodMs) + 1) * periodMs;
    return true;
  }

  reset(): void {
    this.frequencyHz = 0;
    this.deadlineMs = 0;
    this.lastNowMs = -Infinity;
  }
}
