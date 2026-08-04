import { IRacingIbtReader } from "../../server/games/iracing/ibt-reader";
import {
  createIRacingParserState,
  normalizeIRacingFrame,
} from "../../server/games/iracing/normalizer";
import { parseIRacingSessionInfo } from "../../server/games/iracing/session-info";
import type { IRacingSessionSnapshot } from "../../server/games/iracing/source-frame";

const path = process.argv[2];
if (!path) {
  console.error("Usage: bun scripts/iracing/probe-ibt.ts <recording.ibt>");
  process.exit(1);
}
const reader = new IRacingIbtReader(path);
const parserState = createIRacingParserState();
const sessionNumbers = new Set<number>();
const sessions = new Map<number, IRacingSessionSnapshot>();
let identity: IRacingSessionSnapshot | null = null;
let frameCount = 0;
let onTrackFrames = 0;
let pitRoadFrames = 0;
let firstSessionTime: number | null = null;
let lastSessionTime: number | null = null;
let minLap = Number.POSITIVE_INFINITY;
let maxLap = Number.NEGATIVE_INFINITY;
let previousLap: number | null = null;
let lapTransitions = 0;
let maxSpeedMps = 0;

try {
  reader.start();
  let snapshot = reader.readLatest();
  while (snapshot) {
    const sessionNumValue = snapshot.values.SessionNum;
    const sessionNum =
      typeof sessionNumValue === "number" &&
      Number.isFinite(sessionNumValue)
        ? Math.trunc(sessionNumValue)
        : 0;
    sessionNumbers.add(sessionNum);
    let session = sessions.get(sessionNum);
    if (!session) {
      session = parseIRacingSessionInfo(
        snapshot.sessionInfo,
        sessionNum,
      );
      sessions.set(sessionNum, session);
    }
    identity ??= session;
    const packet = normalizeIRacingFrame(
      {
        schemaVersion: 2,
        session,
        values: snapshot.values,
      },
      parserState,
    );

    frameCount++;
    if (packet.IsRaceOn) onTrackFrames++;
    if (packet.iracing?.onPitRoad) pitRoadFrames++;
    firstSessionTime ??= packet.CurrentRaceTime;
    lastSessionTime = packet.CurrentRaceTime;
    minLap = Math.min(minLap, packet.LapNumber);
    maxLap = Math.max(maxLap, packet.LapNumber);
    maxSpeedMps = Math.max(maxSpeedMps, packet.Speed);
    if (
      previousLap !== null &&
      packet.LapNumber !== previousLap
    ) {
      lapTransitions++;
    }
    previousLap = packet.LapNumber;

    snapshot = reader.readLatest();
  }

  const metadata = reader.metadata;
  console.log(JSON.stringify({
    file: reader.path,
    metadata,
    compatibility: {
      missingRaceIQVariables:
        metadata?.missingRaceIQVariables ?? [],
    },
    identity: identity
      ? {
          trackId: identity.trackId,
          trackName: identity.trackName,
          trackLengthM: identity.trackLengthM,
          sectorStarts: identity.sectorStarts,
          carId: identity.carId,
          carName: identity.carName,
          carClassId: identity.carClassId,
          carClassName: identity.carClassName,
        }
      : null,
    stream: {
      frameCount,
      sessionNumbers: [...sessionNumbers].sort(
        (left, right) => left - right,
      ),
      durationSeconds:
        firstSessionTime !== null && lastSessionTime !== null
          ? lastSessionTime - firstSessionTime
          : null,
      onTrackFrames,
      pitRoadFrames,
      lapRange:
        Number.isFinite(minLap) && Number.isFinite(maxLap)
          ? [minLap, maxLap]
          : null,
      lapTransitions,
      maxSpeedMps,
      maxSpeedMph: maxSpeedMps * 2.2369362921,
    },
  }, null, 2));
} finally {
  await reader.stop();
}
