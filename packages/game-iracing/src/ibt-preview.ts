import { basename } from "node:path";
import { IRacingIbtReader } from "./ibt-reader";
import { parseIRacingSessionInfo } from "@raceiq/capture-formats/iracing/session-info";
import {
  IRacingSourceFrameEncoder,
  type IRacingSessionSnapshot,
  type IRacingValue,
} from "@raceiq/capture-formats/iracing/source-frame";
const DRIVING_SPEED_MPS = 1;
const TIMING_ROLLOVER_SECONDS = 5;
const REQUIRED_IMPORT_VARIABLES = [
  "SessionTime", "SessionNum", "IsOnTrack", "Speed", "Lap",
  "LapLastLapTime", "LapCurrentLapTime",
] as const;

interface SessionScanState {
  lastLap: number | null;
  transitions: number;
  candidateLaps: number;
  skipFirstCompletion: boolean;
}
export interface IbtImportPreview {
  gameId: "iracing";
  fileName: string;
  fileSize: number;
  tickRate: number;
  recordCount: number;
  durationSeconds: number;
  sessionStartDate: string;
  trackId: number;
  trackName: string;
  carId: number;
  carName: string;
  carClassName: string;
  missingRaceIQVariables: string[];
  missingRequiredVariables: string[];
  drivingFrames: number;
  pitRoadFrames: number;
  lapTransitions: number;
  candidateLapCount: number;
  maxSpeedMph: number;
  firstDrivingRecord: number | null;
  lastDrivingRecord: number | null;
  canImport: boolean;
  reason: string | null;
}


export class IbtImportError extends Error {
  readonly status: 400 | 404 | 410 | 413;

  constructor(
    message: string,
    status: 400 | 404 | 410 | 413 = 400,
  ) {
    super(message);
    this.name = "IbtImportError";
    this.status = status;
  }
}

function numeric(
  values: Record<string, IRacingValue>,
  name: string,
  fallback = 0,
): number {
  const value = values[name];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function truthy(
  values: Record<string, IRacingValue>,
  name: string,
): boolean {
  const value = values[name];
  return value === true ||
    (typeof value === "number" && Number.isFinite(value) && value !== 0);
}

function safeUploadName(name: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  })();
  const leaf = basename(decoded.replaceAll("\\", "/"));
  return leaf?.toLowerCase().endsWith(".ibt")
    ? leaf
    : "session.ibt";
}

export async function previewIbtFile(
  path: string,
  fileName = basename(path),
): Promise<IbtImportPreview> {
  const reader = new IRacingIbtReader(path);
  reader.start();
  try {
    const metadata = reader.metadata;
    if (!metadata) throw new IbtImportError("Unable to read IBT metadata");

    const missingRequiredVariables = REQUIRED_IMPORT_VARIABLES.filter(
      (name) => metadata.missingRaceIQVariables.includes(name),
    );
    const sessions = new Map<number, SessionScanState>();
    let identity: IRacingSessionSnapshot | null = null;
    let drivingFrames = 0;
    let pitRoadFrames = 0;
    let maxSpeedMps = 0;
    let firstDrivingRecord: number | null = null;
    let lastDrivingRecord: number | null = null;

    for (;;) {
      const snapshot = reader.readLatest();
      if (!snapshot) break;
      const recordIndex = reader.recordsRead - 1;
      const values = snapshot.values;
      const speed = Math.max(0, numeric(values, "Speed"));
      maxSpeedMps = Math.max(maxSpeedMps, speed);
      if (truthy(values, "OnPitRoad")) pitRoadFrames++;

      const sessionNum = Math.trunc(numeric(values, "SessionNum"));
      identity ??= parseIRacingSessionInfo(
        snapshot.sessionInfo,
        sessionNum,
      );

      const isDriving =
        truthy(values, "IsOnTrack") &&
        !truthy(values, "OnPitRoad") &&
        speed >= DRIVING_SPEED_MPS;
      if (!isDriving) continue;

      drivingFrames++;
      firstDrivingRecord ??= recordIndex;
      lastDrivingRecord = recordIndex;

      const lap = Math.max(0, Math.trunc(numeric(values, "Lap")));
      const state = sessions.get(sessionNum) ?? {
        lastLap: null,
        transitions: 0,
        candidateLaps: 0,
        skipFirstCompletion: true,
      };
      if (state.lastLap !== null && lap === state.lastLap + 1) {
        state.transitions++;
        if (state.skipFirstCompletion) {
          state.skipFirstCompletion = false;
        } else {
          state.candidateLaps++;
        }
      } else if (state.lastLap !== null && lap !== state.lastLap) {
        state.skipFirstCompletion = true;
      }
      if (state.lastLap === null || lap !== state.lastLap) {
        state.lastLap = lap;
      }
      sessions.set(sessionNum, state);
    }

    const lapTransitions = [...sessions.values()].reduce(
      (sum, state) => sum + state.transitions,
      0,
    );
    const candidateLapCount = [...sessions.values()].reduce(
      (sum, state) => sum + state.candidateLaps,
      0,
    );
    const durationSeconds =
      metadata.recordCount > 1
        ? (metadata.recordCount - 1) / metadata.tickRate
        : 0;

    let reason: string | null = null;
    if (missingRequiredVariables.length > 0) {
      reason =
        "This recording is missing channels required for RaceIQ lap import: " +
        missingRequiredVariables.join(", ");
    } else if (drivingFrames === 0) {
      reason =
        "No on-track driving above 2.2 mph was found in this recording";
    } else if (candidateLapCount === 0) {
      reason =
        "No complete laps were found; RaceIQ discards the partial lap at the start of an IBT recording";
    }

    return {
      gameId: "iracing",
      fileName: safeUploadName(fileName),
      fileSize: metadata.fileSize,
      tickRate: metadata.tickRate,
      recordCount: metadata.recordCount,
      durationSeconds,
      sessionStartDate: metadata.sessionStartDate.toISOString(),
      trackId: identity?.trackId ?? -1,
      trackName: identity?.trackName ?? "Unknown iRacing track",
      carId: identity?.carId ?? -1,
      carName: identity?.carName ?? "Unknown iRacing car",
      carClassName: identity?.carClassName ?? "Unknown class",
      missingRaceIQVariables: [...metadata.missingRaceIQVariables],
      missingRequiredVariables,
      drivingFrames,
      pitRoadFrames,
      lapTransitions,
      candidateLapCount,
      maxSpeedMph: maxSpeedMps * 2.2369362921,
      firstDrivingRecord,
      lastDrivingRecord,
      canImport: reason === null,
      reason,
    };
  } finally {
    await reader.stop();
  }
}

export async function* ibtFrames(
  path: string,
  preview: IbtImportPreview,
): AsyncGenerator<Buffer> {
  const reader = new IRacingIbtReader(path);
  const frameEncoder = new IRacingSourceFrameEncoder();
  const sessionCache = new Map<number, IRacingSessionSnapshot>();
  const lastRecord = Math.min(
    preview.recordCount - 1,
    (preview.lastDrivingRecord ?? 0) +
      Math.ceil(preview.tickRate * TIMING_ROLLOVER_SECONDS),
  );
  reader.start();
  try {
    for (;;) {
      const snapshot = reader.readLatest();
      if (!snapshot) break;
      const recordIndex = reader.recordsRead - 1;
      if (
        preview.firstDrivingRecord === null ||
        recordIndex < preview.firstDrivingRecord
      ) {
        continue;
      }
      if (recordIndex > lastRecord) break;

      const sessionNum = Math.trunc(
        numeric(snapshot.values, "SessionNum"),
      );
      let session = sessionCache.get(sessionNum);
      if (!session) {
        session = parseIRacingSessionInfo(
          snapshot.sessionInfo,
          sessionNum,
        );
        sessionCache.set(sessionNum, session);
      }
      yield frameEncoder.encode({
        schemaVersion: 3,
        session,
        values: snapshot.values,
        sessionInfo: snapshot.sessionInfo,
        sessionInfoUpdate: snapshot.sessionInfoUpdate,
      });
    }
  } finally {
    await reader.stop();
  }
}

