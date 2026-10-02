/**
 * Windows timer resolution control.
 *
 * Why this exists: Windows' default system timer tick is 15.625ms (64Hz). Any
 * `setInterval` shorter than a tick is rounded up to it, because libuv hands the
 * loop's computed timeout to `GetQueuedCompletionStatus` and that blocking wait
 * is quantised to the tick. Neither Node nor Bun raises the resolution, and
 * since Windows 10 2004 a process no longer inherits a raised resolution from
 * another process on the machine — it must ask for its own.
 *
 * The observable damage: our AC Evo / ACC capture chain asks for 300Hz (reader
 * physics), 60Hz (reader graphics) and 100Hz (triplet assembler), and every one
 * of them collapses to ~63.5Hz. Measured on a real session artifact, poll
 * spacing was 15.8ms against a sim publishing physics at 336Hz — we were
 * discarding 81% of available physics frames to a platform default.
 * See docs/research/telemetry-fidelity.md section 1.
 *
 * Note this is NOT fixable with a drift-compensated scheduler. Recomputing the
 * next deadline from an absolute origin removes accumulated *drift*; it cannot
 * make the OS wake the process before the next tick.
 *
 * Cost: a raised resolution increases timer interrupt frequency, which costs
 * power. So this is refcounted and scoped to the lifetime of an active capture,
 * not requested for the whole process lifetime.
 *
 * Caveat that cannot be verified from a non-Windows dev box: on Windows 11, a
 * window-owning process that becomes fully occluded or minimised may have its
 * requested resolution ignored. `currentPeriodMs()` reports what we asked for,
 * not what the OS granted — trust the assembler's `pollIntervalMs` metrics for
 * that.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";

/** MMRESULT success code (`TIMERR_NOERROR`). */
const TIMERR_NOERROR = 0;

/** What we ask for. 1ms is the conventional floor and what game/audio software uses. */
const DESIRED_PERIOD_MS = 1;

interface WinmmSymbols {
  timeBeginPeriod: (period: number) => number;
  timeEndPeriod: (period: number) => number;
  timeGetDevCaps: (caps: unknown, size: number) => number;
}

let winmm: { symbols: WinmmSymbols; close: () => void } | null = null;
let loadFailed = false;
let refCount = 0;
let activePeriodMs: number | null = null;

const isWindows = (): boolean => process.platform === "win32";

function loadWinmm(): { symbols: WinmmSymbols } | null {
  if (winmm) return winmm;
  if (loadFailed) return null;
  try {
    winmm = dlopen("winmm.dll", {
      timeBeginPeriod: { args: [FFIType.u32], returns: FFIType.u32 },
      timeEndPeriod: { args: [FFIType.u32], returns: FFIType.u32 },
      timeGetDevCaps: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    }) as unknown as { symbols: WinmmSymbols; close: () => void };
    return winmm;
  } catch (err) {
    // Not fatal — we simply keep the 15.625ms tick and the coarser capture rate.
    loadFailed = true;
    console.warn("[TimerResolution] Could not load winmm.dll, staying at default tick:", err);
    return null;
  }
}

/**
 * Smallest period the platform will honour, per `timeGetDevCaps`. Returns the
 * desired period unchanged if the query fails — `timeBeginPeriod` validates its
 * own argument anyway and we handle its error return.
 */
function minSupportedPeriodMs(lib: { symbols: WinmmSymbols }): number {
  try {
    // TIMECAPS { UINT wPeriodMin; UINT wPeriodMax; } — 8 bytes.
    const caps = Buffer.alloc(8);
    if (lib.symbols.timeGetDevCaps(ptr(caps), caps.length) !== TIMERR_NOERROR) {
      return DESIRED_PERIOD_MS;
    }
    const min = caps.readUInt32LE(0);
    const max = caps.readUInt32LE(4);
    if (min === 0 || min > max) return DESIRED_PERIOD_MS;
    return Math.max(min, DESIRED_PERIOD_MS);
  } catch {
    return DESIRED_PERIOD_MS;
  }
}

/**
 * Raise this process's timer resolution so sub-tick intervals are honoured.
 *
 * Refcounted and idempotent per caller: nested acquires are cheap, and the
 * resolution is only released once every holder has called {@link release}.
 * No-ops on every platform but Windows, and on Windows if `winmm.dll` will not
 * load — in both cases capture still works, just at the coarser tick.
 *
 * @returns the period actually requested in ms, or `null` if unchanged.
 */
export function acquireHighResolutionTimer(): number | null {
  if (!isWindows()) return null;

  // Already held — just take a reference.
  if (activePeriodMs !== null) {
    refCount++;
    return activePeriodMs;
  }

  const lib = loadWinmm();
  if (!lib) return null;

  const period = minSupportedPeriodMs(lib);
  const result = lib.symbols.timeBeginPeriod(period);
  if (result !== TIMERR_NOERROR) {
    console.warn(`[TimerResolution] timeBeginPeriod(${period}) failed with ${result}`);
    return null;
  }

  activePeriodMs = period;
  refCount = 1;
  console.log(`[TimerResolution] Raised to ${period}ms (default tick is 15.625ms) — sub-tick intervals now honoured`);
  return period;
}

/**
 * Drop one reference taken by {@link acquireHighResolutionTimer}. The
 * resolution is restored once the last holder releases.
 *
 * Every `timeBeginPeriod` must be matched by a `timeEndPeriod` with the *same*
 * value, which is why the granted period is stored rather than re-derived.
 */
export function releaseHighResolutionTimer(): void {
  if (!isWindows()) return;
  if (activePeriodMs === null) return;

  refCount--;
  if (refCount > 0) return;

  const period = activePeriodMs;
  activePeriodMs = null;
  refCount = 0;

  try {
    const result = winmm?.symbols.timeEndPeriod(period);
    if (result !== undefined && result !== TIMERR_NOERROR) {
      console.warn(`[TimerResolution] timeEndPeriod(${period}) failed with ${result}`);
    } else {
      console.log(`[TimerResolution] Restored default timer resolution`);
    }
  } catch (err) {
    console.warn("[TimerResolution] Error restoring timer resolution:", err);
  }
}

/** Period currently requested in ms, or `null` if we hold no request. */
export function currentPeriodMs(): number | null {
  return activePeriodMs;
}

/** Outstanding references. Exposed for tests and diagnostics. */
export function timerResolutionRefCount(): number {
  return refCount;
}
