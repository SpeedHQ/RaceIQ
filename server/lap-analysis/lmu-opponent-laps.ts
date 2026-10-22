import { createHash } from "node:crypto";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { LmuOpponentIdentityTracker, lmuYawFromOrientationMatrix } from "@raceiq/capture-formats/lmu/opponent-snapshot";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "../session-capture/source-loader";
import type { LmuCompetitor, LmuLiveContext } from "@raceiq/shared/telemetry/lmu";
import type { ResolvedValue } from "@raceiq/shared/telemetry/resolver/contracts";
import type { TelemetryTimestamp } from "@raceiq/shared/telemetry/resolver/contracts";
import { getLapReplaySource } from "../db/telemetry-replay-storage";
import { readLmuOpponentRetention } from "../session-capture/lmu-companion";

export class LmuOpponentSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LmuOpponentSourceError";
  }
}
export async function readLmuOpponentCaptureFrames(source: SessionCaptureSource, _sourceRevision: string): Promise<LmuOpponentCaptureFrame[]> {
  if (source.gameId !== "lmu") return [];
  const tracker = new LmuOpponentIdentityTracker();
  const frames: LmuOpponentCaptureFrame[] = [];
  let fallbackSessionKey = `legacy:${source.rawFile}`;
  let parserBootstrap: Buffer | null = null;
  for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
    if (record.kind === "parser-bootstrap") {
      parserBootstrap = record.payload;
      continue;
    }
    if (record.kind !== "frame") continue;
    const decoded = decodeLMUSourceFrame(record.frame);
    if (!decoded) throw new LmuOpponentSourceError("Session contains an unreadable LMU source frame");
    const context = decoded.lmuContext;
    const captureSequence = context?.key.captureSequence ?? String(record.offset);
    const sessionKey = context?.key.sessionKey ?? fallbackSessionKey;
    fallbackSessionKey = sessionKey;
    const competitors: readonly LmuCompetitor[] = context?.competitors?.length
      ? context.competitors
      : decoded.rawSharedMemory
        ? tracker.snapshot(decoded.rawSharedMemory, sessionKey, BigInt(captureSequence), context?.playerVehicleId ?? null) ?? []
        : [];
    if (competitors.length) frames.push({
      sessionKey, captureSequence, frameTime: decoded.captureTimestampMs, competitors,
      sourceFrame: record.frame, parserBootstrap,
      ...(context ? { lmuContext: context } : {}),
    });
  }
  return frames;
}

export interface LmuOpponentCaptureFrame {
  sessionKey: string;
  captureSequence: string;
  frameTime: number;
  competitors: readonly LmuCompetitor[];
  sourceFrame: Buffer;
  parserBootstrap: Buffer | null;
  lmuContext?: LmuLiveContext;
}

export interface LmuOpponentLapInterval {
  opponentLapId: string;
  sessionKey: string;
  vehicleId: number;
  incarnation: number;
  lapNumber: number | null;
  startSequence: string;
  endSequence: string | null;
  coverage: "complete" | "partial";
  validity: "valid" | "invalid" | "unknown";
  frames: readonly LmuOpponentCaptureFrame[];
}

const channel = (competitor: LmuCompetitor, id: string) => competitor.channels[id];
const numberValue = (value: ResolvedValue<unknown> | undefined): number | null => {
  if (value?.state !== "ok" || typeof value.value !== "number" || !Number.isFinite(value.value)) return null;
  return value.value;
};

function lapId(sessionKey: string, vehicleId: number, incarnation: number, start: string): string {
  return createHash("sha256").update(`${sessionKey}\0${vehicleId}\0${incarnation}\0${start}`).digest("hex");
}
/** Indexes only observed lap-distance wraps; scalar best/last reports never create intervals. */
export function indexLmuOpponentLaps(frames: readonly LmuOpponentCaptureFrame[]): LmuOpponentLapInterval[] {
  const intervals: LmuOpponentLapInterval[] = [];
  type ActiveInterval = {
    lapNumber: number | null;
    startSequence: string;
    frames: LmuOpponentCaptureFrame[];
    previousDistance: number | null;
    previousLap: number | null;
    boundaryObserved: boolean;
  };
  const active = new Map<string, ActiveInterval>();
  const present = new Set<string>();
  const finish = (
    identity: string,
    current: ActiveInterval,
    endSequence: string | null,
    complete: boolean,
  ) => {
    const [sessionKey, vehicleId, incarnation] = identity.split("\0");
    intervals.push({
      opponentLapId: lapId(sessionKey!, Number(vehicleId), Number(incarnation), current.startSequence),
      sessionKey: sessionKey!, vehicleId: Number(vehicleId), incarnation: Number(incarnation),
      lapNumber: current.lapNumber, startSequence: current.startSequence, endSequence,
      coverage: complete ? "complete" : "partial", validity: "unknown", frames: current.frames,
    });
  };
  for (const frame of frames) {
    const inFrame = new Set<string>();
    for (const competitor of frame.competitors) {
      if (competitor.isPlayer) continue;
      const identity = `${frame.sessionKey}\0${competitor.vehicleId}\0${competitor.incarnation}`;
      inFrame.add(identity);
      const distance = numberValue(channel(competitor, "race.competitor.lap-distance"));
      const lap = numberValue(channel(competitor, "race.competitor.current-lap-number"));
      let current = active.get(identity);
      if (!current) {
        current = {
          lapNumber: lap, startSequence: frame.captureSequence, frames: [], previousDistance: null,
          previousLap: null, boundaryObserved: false,
        };
        active.set(identity, current);
      }
      const counterChanged = current.previousLap !== null && lap !== null && lap !== current.previousLap;
      if (counterChanged && lap !== current.previousLap! + 1) {
        if (current.frames.length) finish(identity, current, null, false);
        current = {
          lapNumber: lap, startSequence: frame.captureSequence, frames: [], previousDistance: null,
          previousLap: lap, boundaryObserved: false,
        };
        active.set(identity, current);
      }
      const wrap = current.previousDistance !== null && distance !== null &&
        distance < current.previousDistance && current.previousLap !== null && lap === current.previousLap + 1;
      if (wrap) {
        current.frames.push(frame);
        if (current.frames.length) finish(identity, current, frame.captureSequence, current.boundaryObserved &&
          current.frames.every((sample, index) => index === 0 ||
            (sample.lmuContext !== undefined && current!.frames[index - 1]?.lmuContext !== undefined &&
              BigInt(sample.captureSequence) === BigInt(current!.frames[index - 1]!.captureSequence) + 1n)));
        current = {
          lapNumber: lap, startSequence: frame.captureSequence, frames: [], previousDistance: null,
          previousLap: lap, boundaryObserved: true,
        };
        active.set(identity, current);
      }
      current.frames.push(frame);
      current.previousDistance = distance;
      current.previousLap = lap;
    }
    for (const identity of present) {
      if (inFrame.has(identity)) continue;
      const current = active.get(identity);
      if (current?.frames.length) finish(identity, current, null, false);
      active.delete(identity);
    }
    present.clear();
    for (const identity of inFrame) present.add(identity);
  }
  for (const [identity, current] of active) {
    if (current.frames.length > 1) finish(identity, current, null, false);
  }
  return intervals;
}

export type LmuOpponentLapReadErrorCode =
  | "LAP_NOT_FOUND"
  | "INVALID_OPPONENT_COMPARISON"
  | "SOURCE_CHANGED"
  | "OPPONENT_DATA_REMOVED"
  | "OPPONENT_DATA_UNAVAILABLE"
  | "OPPONENT_LAP_NOT_FOUND";

export class LmuOpponentLapReadError extends Error {
  readonly code: LmuOpponentLapReadErrorCode;
  constructor(code: LmuOpponentLapReadErrorCode, message: string) {
    super(message);
    this.name = "LmuOpponentLapReadError";
    this.code = code;
  }
}

export async function getLmuOpponentLapForExport(
  playerLapId: number,
  opponentLapId: string,
  sourceRevision: string,
): Promise<{ source: NonNullable<Awaited<ReturnType<typeof getLapReplaySource>>>; interval: LmuOpponentLapInterval }> {
  const source = await getLapReplaySource(playerLapId);
  if (!source) throw new LmuOpponentLapReadError("LAP_NOT_FOUND", "Lap not found");
  if (source.gameId !== "lmu") {
    throw new LmuOpponentLapReadError("INVALID_OPPONENT_COMPARISON", "Opponent laps require an LMU lap");
  }
  const sourcePath = source.captureManifestFile ?? source.rawFile;
  if (!sourcePath) throw new LmuOpponentLapReadError("OPPONENT_DATA_UNAVAILABLE", "Session source is unavailable");
  const before = await readLmuOpponentRetention(sourcePath);
  if (before.sourceRevision !== sourceRevision) {
    throw new LmuOpponentLapReadError("SOURCE_CHANGED", "Opponent source revision changed");
  }
  if (before.opponentRetention === "removed") {
    throw new LmuOpponentLapReadError("OPPONENT_DATA_REMOVED", "Opponent data was removed");
  }
  if (before.opponentRetention !== "retained" ||
      before.opponentAvailability === "missing" || before.opponentAvailability === "corrupt") {
    throw new LmuOpponentLapReadError("OPPONENT_DATA_UNAVAILABLE", "Opponent data is unavailable");
  }
  const frames = await readLmuOpponentCaptureFrames({
    rawFile: sourcePath,
    source: source.source,
    gameId: source.gameId,
    carId: source.carId,
    trackId: source.trackId,
    captureFormatVersion: source.captureFormatVersion,
  }, sourceRevision);
  const after = await readLmuOpponentRetention(sourcePath);
  if (after.sourceRevision !== sourceRevision) {
    throw new LmuOpponentLapReadError("SOURCE_CHANGED", "Opponent source revision changed");
  }
  if (after.opponentRetention === "removed") {
    throw new LmuOpponentLapReadError("OPPONENT_DATA_REMOVED", "Opponent data was removed");
  }
  if (after.opponentRetention !== "retained" ||
      after.opponentAvailability === "missing" || after.opponentAvailability === "corrupt") {
    throw new LmuOpponentLapReadError("OPPONENT_DATA_UNAVAILABLE", "Opponent data is unavailable");
  }
  const interval = indexLmuOpponentLaps(frames).find((candidate) => candidate.opponentLapId === opponentLapId);
  if (!interval) throw new LmuOpponentLapReadError("OPPONENT_LAP_NOT_FOUND", "Opponent lap not found");
  const first = interval.frames[0];
  const firstIndex = first ? frames.findIndex((frame) => frame.sessionKey === first.sessionKey && frame.captureSequence === first.captureSequence) : -1;
  const prior = firstIndex > 0 ? frames[firstIndex - 1] : undefined;
  const priorCompetitor = prior?.competitors.find((competitor) =>
    competitor.vehicleId === interval.vehicleId && competitor.incarnation === interval.incarnation && !competitor.isPlayer);
  const firstCompetitor = first?.competitors.find((competitor) =>
    competitor.vehicleId === interval.vehicleId && competitor.incarnation === interval.incarnation && !competitor.isPlayer);
  const priorLap = priorCompetitor && numberValue(channel(priorCompetitor, "race.competitor.current-lap-number"));
  const firstLap = firstCompetitor && numberValue(channel(firstCompetitor, "race.competitor.current-lap-number"));
  const context = prior && priorCompetitor && priorLap !== null && firstLap !== null &&
    priorLap !== firstLap ? [prior] : [];
  return { source, interval: { ...interval, frames: [...context, ...interval.frames] } };
}

const ORIENTATION_YAW_DERIVATION = {
  id: "lmu.normalizer.orientation-yaw",
  version: "1",
  codeHash: createHash("sha256").update(lmuYawFromOrientationMatrix.toString()).digest("hex"),
};
const elapsedLapTime = (scoringTime: number, lapStartTime: number) => scoringTime - lapStartTime;
const LAP_ELAPSED_DERIVATION = {
  id: "lmu.scoring-time-minus-lap-start-time",
  version: "1",
  codeHash: createHash("sha256").update(elapsedLapTime.toString()).digest("hex"),
};

function sameTimestamp(left: TelemetryTimestamp, right: TelemetryTimestamp): boolean {
  if (left.domain !== right.domain) return false;
  return left.domain === "monotonic" && right.domain === "monotonic"
    ? left.nanoseconds === right.nanoseconds
    : left.domain !== "monotonic" && right.domain !== "monotonic" && left.milliseconds === right.milliseconds;
}

function missingOpponentValue(source: ResolvedValue<unknown>, semanticId: string, reason: string): ResolvedValue<unknown> {
  return {
    ...source,
    semanticId,
    value: null,
    mappingStatus: "unavailable",
    state: "missing",
    freshness: "unknown",
    confidence: null,
    confidenceComponents: { ...source.confidenceComponents, freshness: null, inputCompleteness: 0 },
    limitations: [...source.limitations, reason],
  };
}

function sourceNumber(channel: ResolvedValue<unknown> | undefined): channel is ResolvedValue<number> & { value: number } {
  return channel?.state === "ok" && channel.freshness === "fresh" &&
    typeof channel.value === "number" && Number.isFinite(channel.value);
}

export function projectLmuOpponentTelemetry(competitor: LmuCompetitor): ResolvedValue<unknown>[] {
  const channels = competitor.channels;
  const values: ResolvedValue<unknown>[] = [];
  for (const [sourceId, semanticId] of [
    ["motion.competitor.position.x", "motion.position-x"],
    ["motion.competitor.position.y", "motion.position-y"],
    ["motion.competitor.position.z", "motion.position-z"],
    ["motion.competitor.speed", "motion.speed"],
    ["race.competitor.lap-distance", "timing.distance-traveled"],
  ] as const) {
    const source = channels[sourceId];
    if (source) values.push({ ...source, semanticId });
  }
  const orientation = channels["motion.competitor.orientation"];
  if (orientation) {
    const matrix = orientation.state === "ok" && orientation.freshness === "fresh" &&
      Array.isArray(orientation.value) && orientation.value.every((value): value is number => typeof value === "number")
      ? orientation.value
      : null;
    const yaw = matrix ? lmuYawFromOrientationMatrix(matrix) : null;
    values.push(yaw === null
      ? missingOpponentValue(orientation, "motion.yaw", "Native orientation matrix is invalid or unavailable.")
      : {
          ...orientation,
          semanticId: "motion.yaw",
          value: yaw,
          unit: "rad",
          mappingStatus: "derived",
          confidence: orientation.confidence === null ? null : orientation.confidence * 0.9,
          confidenceComponents: {
            ...orientation.confidenceComponents,
            semanticFidelity: Math.min(orientation.confidenceComponents.semanticFidelity, 0.9),
            derivationReliability: 0.9,
          },
          provenance: { ...orientation.provenance, derivation: ORIENTATION_YAW_DERIVATION },
          limitations: [...orientation.limitations, "Yaw derived using the audited LMU orientation-matrix convention."],
        });
  }
  const scoringTime = channels["race.competitor.scoring-time"];
  const lapStartTime = channels["race.competitor.lap-start-time"];
  if (scoringTime || lapStartTime) {
    const source = scoringTime ?? lapStartTime!;
    if (sourceNumber(scoringTime) && sourceNumber(lapStartTime)) {
      const scoringObservation = scoringTime.provenance.sourceObservation;
      const lapStartObservation = lapStartTime.provenance.sourceObservation;
      const compatible = scoringTime.value >= lapStartTime.value &&
        scoringObservation !== undefined && lapStartObservation !== undefined &&
        scoringObservation.updateSequence === lapStartObservation.updateSequence &&
        sameTimestamp(scoringTime.provenance.observedAt, lapStartTime.provenance.observedAt) &&
        sameTimestamp(scoringObservation.timestamp, lapStartObservation.timestamp);
      values.push(compatible
        ? {
            ...scoringTime,
            semanticId: "timing.current-lap",
            value: elapsedLapTime(scoringTime.value, lapStartTime.value),
            unit: "s",
            mappingStatus: "derived",
            confidence: scoringTime.confidence === null || lapStartTime.confidence === null
              ? null : Math.min(scoringTime.confidence, lapStartTime.confidence) * 0.9,
            confidenceComponents: {
              ...scoringTime.confidenceComponents,
              semanticFidelity: Math.min(scoringTime.confidenceComponents.semanticFidelity, 0.9),
              inputCompleteness: Math.min(scoringTime.confidenceComponents.inputCompleteness, lapStartTime.confidenceComponents.inputCompleteness),
              derivationReliability: 0.9,
            },
            provenance: { ...scoringTime.provenance, derivation: LAP_ELAPSED_DERIVATION },
            limitations: [...scoringTime.limitations, "Elapsed time derived from same-update native scoring-time and lap-start-time."],
          }
        : missingOpponentValue(source, "timing.current-lap", "Native scoring-time and lap-start-time are not compatible source observations."));
    } else {
      values.push(missingOpponentValue(source, "timing.current-lap", "Native scoring-time and lap-start-time are not compatible source observations."));
    }
  }
  return values;
}
