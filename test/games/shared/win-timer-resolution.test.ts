/**
 * Timer resolution control.
 *
 * CI and most dev boxes here are Linux, so the Windows path cannot be executed.
 * What IS worth pinning on every platform: the module must be inert off Windows
 * (no FFI load attempt, no throw, no refcount movement), and the refcount must
 * not underflow on unbalanced release — an underflow would make a later
 * acquire/release pair drop the resolution while a capture is still running.
 */
import { describe, expect, test } from "bun:test";
import { acquireHighResolutionTimer, currentPeriodMs, releaseHighResolutionTimer, timerResolutionRefCount } from "../../../server/games/shared/win-timer-resolution";

const isWindows = process.platform === "win32";

describe("win-timer-resolution", () => {
  test.skipIf(isWindows)("is a no-op on non-Windows platforms", () => {
    expect(acquireHighResolutionTimer()).toBeNull();
    expect(currentPeriodMs()).toBeNull();
    expect(timerResolutionRefCount()).toBe(0);

    // Must not throw despite there being nothing to release.
    releaseHighResolutionTimer();
    expect(timerResolutionRefCount()).toBe(0);
  });

  test("release without acquire cannot drive the refcount negative", () => {
    releaseHighResolutionTimer();
    releaseHighResolutionTimer();
    releaseHighResolutionTimer();
    expect(timerResolutionRefCount()).toBeGreaterThanOrEqual(0);
  });

  test.skipIf(!isWindows)("nested acquires are refcounted and released as a pair", () => {
    const first = acquireHighResolutionTimer();
    expect(first).not.toBeNull();
    expect(timerResolutionRefCount()).toBe(1);

    // Second holder gets the same period, does not re-request it.
    const second = acquireHighResolutionTimer();
    expect(second).toBe(first);
    expect(timerResolutionRefCount()).toBe(2);

    // Resolution stays raised while any holder remains.
    releaseHighResolutionTimer();
    expect(timerResolutionRefCount()).toBe(1);
    expect(currentPeriodMs()).toBe(first);

    releaseHighResolutionTimer();
    expect(timerResolutionRefCount()).toBe(0);
    expect(currentPeriodMs()).toBeNull();
  });

  test.skipIf(!isWindows)("requested period is at or below the 15.625ms default tick", () => {
    const period = acquireHighResolutionTimer();
    try {
      expect(period).not.toBeNull();
      // The whole point: anything >= the default tick would be pointless.
      expect(period!).toBeLessThan(15.625);
      expect(period!).toBeGreaterThan(0);
    } finally {
      releaseHighResolutionTimer();
    }
  });
});
