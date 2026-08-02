import type { TelemetryPacket, GameId } from "../../shared/types";
import { getGame } from "../../shared/games/registry";
import { resolveTrack } from "../tracks/info";

export interface NativeSectorTimeline {
  sectorCount: number;
  times: number[];
  boundaryIndices: number[];
  sectorStarts: number[];
}

type IRacingSectorTimeline = NativeSectorTimeline;

export function computeNativeSectorTimeline(
  packets: TelemetryPacket[],
  lapTime: number,
  getLayout: (packet: TelemetryPacket) => {
    starts: number[];
    lapFraction?: number;
  } | undefined,
): NativeSectorTimeline | null {
  const starts = packets
    .map(getLayout)
    .find((layout) => layout?.starts.length)?.starts;
  if (
    !starts ||
    starts.length < 2 ||
    !Number.isFinite(starts[0]) ||
    starts[0] < 0 ||
    starts[0] >= 1e-6 ||
    starts.some(
      (value, index) =>
        !Number.isFinite(value) ||
        value < 0 ||
        value >= 1 ||
        (index > 0 && value <= starts[index - 1]),
    )
  ) {
    return null;
  }

  const boundaryIndices = starts.slice(1).map((boundary) =>
    packets.findIndex(
      (packet) => (getLayout(packet)?.lapFraction ?? -1) >= boundary,
    ),
  );
  if (boundaryIndices.some((index) => index <= 0)) return null;

  const startTime = packets[0].CurrentLap;
  const boundaryTimes = boundaryIndices.map(
    (index) => packets[index].CurrentLap - startTime,
  );
  const times = boundaryTimes.map((time, index) =>
    time - (index === 0 ? 0 : boundaryTimes[index - 1]),
  );
  times.push(lapTime - (boundaryTimes.at(-1) ?? 0));
  if (times.some((time) => time <= 0)) return null;

  return {
    sectorCount: starts.length,
    times,
    boundaryIndices,
    sectorStarts: [...starts],
  };
}

/**
 * Resolve iRacing sectors exclusively from SplitTimeInfo carried in the native
 * source frames. A missing or malformed SDK layout deliberately returns null.
 */
export function computeIRacingSectorTimeline(
  packets: TelemetryPacket[],
  lapTime: number,
): IRacingSectorTimeline | null {
  return computeNativeSectorTimeline(packets, lapTime, (packet) => {
    const starts = packet.iracing?.sectorStarts;
    if (!starts?.length) return undefined;
    return { starts, lapFraction: packet.iracing?.lapDistancePct };
  });
}

/**
 * Pure function that computes the source-defined sector times from a lap's telemetry buffer.
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
  trackOrdinal: number,
  gameId: GameId,
  packets: TelemetryPacket[],
  lapTime: number,
  accLiveSectors?: { s1: number; s2: number },
): Promise<number[] | null> {
  if (packets.length < 50) return null;

  const game = getGame(gameId);
  if (game.nativeSectors) {
    if (!game.getNativeSectorLayout) return null;
    const timeline = computeNativeSectorTimeline(
      packets,
      lapTime,
      game.getNativeSectorLayout,
    );
    if (!timeline) return null;
    return timeline.times;
  }

  // Sector boundaries: this game's curated pair, else bundled, else thirds.
  const { s1End, s2End } = resolveTrack(gameId, trackOrdinal).sectors;

  // F1: sector times must come from the game's own packets (SessionHistory or
  // LapData). We never fall back to distance-fraction for F1 — the game is
  // the authority on its own split points and sync, and guessing from
  // position can produce wildly wrong sectors, especially on tracks where the
  // three sectors aren't 1/3 : 1/3 : 1/3 of the lap distance.
  let s1 = 0, s2 = 0;
  if (gameId === "f1-2025") {
    // The F1 2025 LapData packet exposes LapNumber for every packet in the
    // lap buffer. Every packet also carries a snapshot of the
    // SessionHistory → lapSectors map (completed-lap sector times indexed by
    // lap number). Look up the entry for THIS lap by scanning the buffer for
    // the largest LapNumber we saw (the lap we're about to emit) and
    // reading its SessionHistory entry from the final packet.
    const completedLapNum = Math.max(...packets.map((p) => p.LapNumber ?? 0));
    if (completedLapNum > 0) {
      // Walk packets from the end — later packets have more up-to-date
      // SessionHistory because the game finalises the lap entry on the
      // first history broadcast after finish.
      for (let i = packets.length - 1; i >= 0; i--) {
        const entry = packets[i].f1?.lapSectors?.[completedLapNum];
        if (entry && entry.s1 > 0 && entry.s2 > 0 && entry.s3 > 0) {
          s1 = entry.s1;
          s2 = entry.s2;
          break;
        }
      }
    }
    // Fall back to live LapData packet 2 sector1Time/sector2Time — still from
    // the game, just less definitive. Pick the final non-zero value that was
    // recorded while we were still in this lap (last packets may have moved
    // into the NEXT lap, resetting these to 0).
    if (s1 === 0 || s2 === 0) {
      for (const p of packets) {
        if (p.LapNumber !== completedLapNum) continue;
        if ((p.f1?.sector1Time ?? 0) > 0) s1 = p.f1!.sector1Time;
        if ((p.f1?.sector2Time ?? 0) > 0) s2 = p.f1!.sector2Time;
      }
    }
    // If F1 packets didn't supply both splits, give up rather than guessing.
    if (s1 === 0 || s2 === 0) return null;
    const s3 = lapTime - s1 - s2;
    if (s3 <= 0) return null;
    return [s1, s2, s3];
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
      return [s1, s2, s3];
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
          return [s1Retry, s2Retry, s3];
        }
      }
    }
  }

  return null;
}
