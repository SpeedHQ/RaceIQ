import type { TelemetryPacket, GameId } from "../shared/types";
import type { DbAdapter } from "./pipeline-adapters";
import { tryGetGame } from "../shared/games/registry";
import { getTrackSectorsByOrdinal, loadSharedTrackMeta } from "../shared/track-data";

/**
 * Pure function that computes s1/s2/s3 sector times from a lap's telemetry buffer.
 *
 * @param db           DB adapter (for track outline sector boundaries)
 * @param trackOrdinal Track ordinal from the session
 * @param gameId       Game identifier
 * @param packets      All telemetry packets for the completed lap
 * @param lapTime      Authoritative lap time (seconds)
 * @param accLiveSectors Optional ACC live-tracked sector times (captured during the lap).
 *                       Pass undefined for non-ACC games or when not yet tracked.
 */
export async function computeLapSectors(
  db: Pick<DbAdapter, "getTrackOutlineSectors">,
  trackOrdinal: number,
  gameId: GameId,
  packets: TelemetryPacket[],
  lapTime: number,
  accLiveSectors?: { s1: number; s2: number },
): Promise<{ s1: number; s2: number; s3: number } | null> {
  if (packets.length < 50) return null;

  // Resolve sector boundaries
  const adapter = tryGetGame(gameId);
  const sharedName = adapter?.getSharedTrackName?.(trackOrdinal);
  const dbSectors = await db.getTrackOutlineSectors(trackOrdinal, gameId);
  const sharedMeta = sharedName ? loadSharedTrackMeta(sharedName) : null;
  const gameSectors = gameId ? (sharedMeta as any)?.games?.[gameId]?.sectors : null;
  const raw = dbSectors ?? gameSectors ?? sharedMeta?.sectors ?? getTrackSectorsByOrdinal(trackOrdinal);
  const s1End = raw?.s1End ?? 1 / 3;
  const s2End = raw?.s2End ?? 2 / 3;

  // F1: prefer game-broadcast sector times
  let s1 = 0, s2 = 0;
  for (const p of packets) {
    if ((p.f1?.sector1Time ?? 0) > 0) s1 = p.f1!.sector1Time;
    if ((p.f1?.sector2Time ?? 0) > 0) s2 = p.f1!.sector2Time;
  }

  // ACC: use native sector times tracked live during the lap
  if (s1 === 0 && s2 === 0 && gameId === "acc" && accLiveSectors && accLiveSectors.s1 > 0 && accLiveSectors.s2 > 0) {
    s1 = accLiveSectors.s1;
    s2 = accLiveSectors.s2;
  }

  // ACC: derive sector times from currentSectorIndex transitions in the packet stream.
  // Works for all laps including outlaps — sector index is track-position-based, not
  // distance-from-start-based, so it correctly fires at S1/S2/S3 boundaries regardless
  // of where the lap began (pit exit, mid-lap join, etc).
  if (s1 === 0 && s2 === 0 && gameId === "acc") {
    let prevIdx = packets[0].acc?.currentSectorIndex ?? -1;
    let sectorStart = packets[0].CurrentLap;
    for (const p of packets) {
      const idx = p.acc?.currentSectorIndex ?? prevIdx;
      if (idx !== prevIdx) {
        const elapsed = p.CurrentLap - sectorStart;
        if (prevIdx === 0) s1 = elapsed;
        else if (prevIdx === 1) s2 = elapsed;
        sectorStart = p.CurrentLap;
        prevIdx = idx;
      }
    }
  }

  // Fall back to distance-fraction computation.
  // Guard: if the first packet's CurrentLap is already well into the lap (car started
  // mid-lap, e.g. a pit lap where recording began in the pit lane), the measured
  // lapDist is only the remaining distance to the line — sector fractions are meaningless.
  const lapStartTime = packets[0].CurrentLap;
  if (s1 === 0 || s2 === 0) {
    if (lapStartTime > 10) {
      // Started too far into the lap to derive reliable sector splits — bail out.
      return null;
    }

    const startDist = packets[0].DistanceTraveled;
    const lapDist = packets[packets.length - 1].DistanceTraveled - startDist;
    if (lapDist < 100) return null;

    let sector = 0;
    let sectorStart = packets[0].CurrentLap;
    s1 = 0;
    s2 = 0;
    for (const p of packets) {
      const frac = (p.DistanceTraveled - startDist) / lapDist;
      const expected = frac < s1End ? 0 : frac < s2End ? 1 : 2;
      if (expected > sector) {
        const t = p.CurrentLap - sectorStart;
        if (sector === 0) s1 = t;
        else if (sector === 1) s2 = t;
        sectorStart = p.CurrentLap;
        sector = expected;
      }
    }
  }

  if (s1 > 0 && s2 > 0) {
    const s3 = lapTime - s1 - s2;
    if (s3 <= 0) {
      // Native sectors invalid — fall through to distance-fraction fallback
      s1 = 0;
      s2 = 0;
    } else {
      return { s1, s2, s3 };
    }
  }

  // If we get here, native sectors didn't work, try distance-fraction one more time
  if (s1 === 0 || s2 === 0) {
    const startDist = packets[0].DistanceTraveled;
    const lapDist = packets[packets.length - 1].DistanceTraveled - startDist;
    if (lapDist >= 100) {
      let sector = 0;
      let sectorStart = packets[0].CurrentLap;
      let s1Retry = 0, s2Retry = 0;
      for (const p of packets) {
        const frac = (p.DistanceTraveled - startDist) / lapDist;
        const expected = frac < s1End ? 0 : frac < s2End ? 1 : 2;
        if (expected > sector) {
          const t = p.CurrentLap - sectorStart;
          if (sector === 0) s1Retry = t;
          else if (sector === 1) s2Retry = t;
          sectorStart = p.CurrentLap;
          sector = expected;
        }
      }

      if (s1Retry > 0 && s2Retry > 0) {
        const s3 = lapTime - s1Retry - s2Retry;
        if (s3 > 0) {
          return { s1: s1Retry, s2: s2Retry, s3 };
        }
      }
    }
  }

  return null;
}
