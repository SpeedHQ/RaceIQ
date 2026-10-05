import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { GameId } from "@raceiq/shared/games/ids";
import { extractCurbSegments, recordCurbData } from "@raceiq/shared/racing/tracks/recording/curbs";
import { recordLapTrace } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { getIRacingSharedTrackName } from "@raceiq/game-iracing-metadata/racing/tracks/catalogs/iracing";
import { lapPath } from "@raceiq/shared/racing/tracks/path";
import { computeLapSectors } from "./sectors";
import { persistLapMetrics } from "./metrics-store";
import { updateLapCarSetup } from "../db/lap-mutation-queries";
import { reconcileAutoExclusionsForLap } from "../experiments/auto-exclude";
import type { DbAdapter } from "../telemetry/pipeline-ports";

/** Derived Bun-owned analysis for a lap whose boundary/timing are Rust-authoritative. */
export async function deriveRecordedLap(input: {
  db: DbAdapter;
  lapId?: number;
  gameId: GameId;
  trackOrdinal: number;
  packets: TelemetryPacket[];
  lapTime: number;
  isValid: boolean;
  sectors?: number[] | null;
}): Promise<{ sectors: number[] | null }> {
  const { db, lapId, gameId, trackOrdinal, packets, lapTime, isValid } = input;
  const sectors = input.sectors === undefined ? await computeLapSectors(trackOrdinal, gameId, packets, lapTime) : input.sectors;
  if (isValid && gameId === "iracing" && trackOrdinal > 0 && !getIRacingSharedTrackName(trackOrdinal) && packets.length > 0) {
    const path = lapPath(packets);
    const trace = path.x.map((x, index) => ({ x, z: path.z[index] }));
    recordLapTrace(trackOrdinal, trace, trace[0] ?? null, packets[0]?.Yaw ?? null, "iracing");
  }
  if (isValid && trackOrdinal > 0 && packets.length > 50) {
    const segments = extractCurbSegments(packets);
    if (segments.length > 0) recordCurbData(trackOrdinal, segments, gameId);
  }
  if (lapId !== undefined) await persistRecordedLapFollowups(db, lapId, packets);
  return { sectors };
}

export async function persistRecordedLapFollowups(db: DbAdapter, lapId: number, packets: TelemetryPacket[]): Promise<void> {
  const setup = packets.find((packet) => packet.f1?.setup)?.f1?.setup;
  if (setup) await updateLapCarSetup(lapId, setup);
  await persistLapMetrics(db, lapId, packets);
  await reconcileAutoExclusionsForLap(db, lapId);
}
