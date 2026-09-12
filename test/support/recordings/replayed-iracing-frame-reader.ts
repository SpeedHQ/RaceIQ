import { readIRacingFrames } from "../../../server/games/iracing/recorder";
import type { IRacingFrameReader } from "../../../server/games/iracing/source";
import {
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
  type IRacingSessionSnapshot,
} from "../../../server/games/iracing/source-frame";
import type { IRacingSdkSnapshot } from "../../../server/games/iracing/sdk-reader";

function reconstructSessionInfo(session: IRacingSessionSnapshot): string {
  const sectors = (session.sectorStarts ?? [0])
    .map(
      (start, index) =>
        `  - SectorNum: ${index}\n    SectorStartPct: ${start}`,
    )
    .join("\n");
  return `WeekendInfo:
  TrackID: ${session.trackId}
  TrackLength: ${session.trackLengthM / 1000} km
  TrackDisplayName: ${JSON.stringify(session.trackName)}
  SessionID: ${session.sessionId}
  SubSessionID: ${session.subSessionId}
SplitTimeInfo:
  Sectors:
${sectors}
DriverInfo:
  DriverCarIdx: ${session.driverCarIdx}
  DriverCarIdleRPM: ${session.engineIdleRpm}
  DriverCarRedLine: ${session.engineRedlineRpm}
  DriverCarEngCylinderCount: ${session.engineCylinderCount}
  Drivers:
  - CarIdx: ${session.driverCarIdx}
    CarID: ${session.carId}
    CarScreenName: ${JSON.stringify(session.carName)}
    CarClassID: ${session.carClassId}
    CarClassShortName: ${JSON.stringify(session.carClassName)}
`;
}

/** Reconstructs SDK snapshots from a healthy iRacing source-frame recording. */
export class ReplayedIRacingFrameReader implements IRacingFrameReader {
  private readonly snapshots: readonly IRacingSdkSnapshot[];
  private frameIndex = 0;
  private started = false;

  constructor(path: string, limit?: number) {
    const decoder = createIRacingSourceDecoderState();
    this.snapshots = readIRacingFrames(path, limit).map((raw, index) => {
      const frame = decodeIRacingSourceFrame(raw, decoder);
      if (!frame) {
        throw new Error(`iRacing fixture frame ${index} is not decodable`);
      }
      return {
        tick: Number(frame.values.SessionTick ?? index),
        sessionInfoUpdate:
          frame.schemaVersion === 3 ? frame.sessionInfoUpdate : 0,
        sessionInfo:
          frame.schemaVersion === 3
            ? frame.sessionInfo
            : reconstructSessionInfo(frame.session),
        values: { ...frame.values },
      };
    });
  }

  get frameCount(): number {
    return this.snapshots.length;
  }

  start(): void {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  readLatest(): IRacingSdkSnapshot | null {
    if (!this.started) return null;
    return this.snapshots[this.frameIndex++] ?? null;
  }
}
