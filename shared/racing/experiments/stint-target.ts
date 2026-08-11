/**
 * Track-length-aware stint nudge (Phase 5, setup-engineer flow).
 *
 * Advisory only — this is the per-run "how many laps is a full stint here"
 * nudge shown in the live UI. It is decoupled from the confidence model
 * (which stays the soft ~3-consistent-laps ideal); on a long track the nudge
 * can be as low as 1 lap/run while confidence still accrues across runs.
 *
 * No fs access here — this stays a pure, unit-testable helper. The
 * track-length lookup (`getTrackLengthMeters`, `shared/racing/tracks/recording/outlines.ts`) is
 * fs-backed and stays server-only; callers pass in a plain number.
 */

/** Target time (minutes) worth of green running per stint. */
export const TARGET_GREEN_MIN = 6;

/** Fallback average speed (m/s) used to estimate lap time from track length. */
export const AVG_SPEED_MPS = 45;

/** Fallback lap time (seconds) when neither a best lap nor a track length is known. */
export const DEFAULT_LAP_SEC = 90;

/**
 * Suggests how many clean laps make up a full stint on this track.
 *
 * `estLapSec` precedence (decided by the caller): best known lap time ->
 * `trackLengthM / AVG_SPEED_MPS` -> a fixed default. This function just
 * turns an estimated lap time (plus an optional track length as a
 * secondary fallback) into a clamped target lap count.
 */
export function suggestLapTarget(estLapSec: number | null | undefined, trackLengthM: number | null | undefined): number {
  let lapSec = estLapSec != null && estLapSec > 0 ? estLapSec : null;

  if (lapSec == null && trackLengthM != null && trackLengthM > 0) {
    lapSec = trackLengthM / AVG_SPEED_MPS;
  }

  if (lapSec == null) {
    lapSec = DEFAULT_LAP_SEC;
  }

  const targetLaps = Math.round((TARGET_GREEN_MIN * 60) / lapSec);
  return Math.min(4, Math.max(1, targetLaps));
}
