import { createHash } from "node:crypto";
import { createLMUSourceFrameDecoder } from "@raceiq/capture-formats/lmu/source-frame";
import { LmuOpponentIdentityTracker, lmuYawFromOrientationMatrix } from "@raceiq/capture-formats/lmu/opponent-snapshot";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "../session-capture/source-loader";
import type { LmuCompetitor, LmuLiveContext } from "@raceiq/shared/telemetry/lmu";
import type { ResolvedValue } from "@raceiq/shared/telemetry/resolver/contracts";
import type { TelemetryTimestamp } from "@raceiq/shared/telemetry/resolver/contracts";
import { getLapReplaySource, type LapReplaySource } from "../db/telemetry-replay-storage";
import { LmuOpponentAdmissionError, readLmuOpponentRetention } from "../session-capture/lmu-companion";
import { countSourceFrameScanned } from "../session-capture/test-instrumentation";
export { LmuOpponentAdmissionError };


export class LmuOpponentSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LmuOpponentSourceError";
  }
}
export function readLmuOpponentCaptureFrames(source: SessionCaptureSource, sourceRevision: string, options: { retainSourceFrames: false }): Promise<LmuOpponentFrame[]>;
export function readLmuOpponentCaptureFrames(source: SessionCaptureSource, sourceRevision: string): Promise<LmuOpponentCaptureFrame[]>;
export async function readLmuOpponentCaptureFrames(
  source: SessionCaptureSource,
  _sourceRevision: string,
  options: { retainSourceFrames: boolean } = { retainSourceFrames: true },
): Promise<LmuOpponentFrame[]> {
  const frames: LmuOpponentFrame[] = [];
  for await (const frame of iterateLmuOpponentCaptureFrames(source, options)) frames.push(frame);
  return frames;
}

export async function* iterateLmuOpponentCaptureFrames(
  source: SessionCaptureSource,
  options: { retainSourceFrames?: boolean; onSourceFrame?: () => void; admission?: () => Promise<boolean> } = {},
): AsyncGenerator<LmuOpponentFrame | LmuOpponentCaptureFrame> {
  if (source.gameId !== "lmu") return;
  const tracker = new LmuOpponentIdentityTracker();
  const decoder = createLMUSourceFrameDecoder();
  let fallbackSessionKey = `legacy:${source.rawFile}`;
  let parserBootstrap: Buffer | null = null;
  let admissionFrames = 0;
  for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true, admission: options.admission })) {
    if (record.kind === "parser-bootstrap") {
      parserBootstrap = record.payload;
      continue;
    }
    if (record.kind !== "frame") continue;
    countSourceFrameScanned();
    admissionFrames++;
    if (admissionFrames === 256) {
      admissionFrames = 0;
      if (options.admission && !(await options.admission())) throw new LmuOpponentAdmissionError();
    }
    options.onSourceFrame?.();
    const decoded = decoder.decode(record.frame);
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
    if (!competitors.length) continue;
    yield {
      sessionKey, captureSequence, frameTime: decoded.captureTimestampMs, competitors,
      ...(options.retainSourceFrames === false ? {} : { sourceFrame: record.frame, parserBootstrap }),
      ...(context ? { lmuContext: context } : {}),
    };
  }
}

export interface LmuOpponentFrame {
  sessionKey: string;
  captureSequence: string;
  frameTime: number;
  competitors: readonly LmuCompetitor[];
  lmuContext?: LmuLiveContext;
}

export interface LmuOpponentCaptureFrame extends LmuOpponentFrame {
  sourceFrame: Buffer;
  parserBootstrap: Buffer | null;
}

export interface LmuOpponentLapInterval<Frame extends LmuOpponentFrame = LmuOpponentFrame> {
  opponentLapId: string;
  sessionKey: string;
  vehicleId: number;
  incarnation: number;
  lapNumber: number | null;
  startSequence: string;
  endSequence: string | null;
  coverage: "complete" | "partial";
  validity: "valid" | "invalid" | "unknown";
  frames: readonly Frame[];
}

const channel = (competitor: LmuCompetitor, id: string) => competitor.channels[id];
const numberValue = (value: ResolvedValue<unknown> | undefined): number | null => {
  if (value?.state !== "ok" || typeof value.value !== "number" || !Number.isFinite(value.value)) return null;
  return value.value;
};

export interface LmuOpponentFrameLocator {
  blockIndex: number;
  frameIndex: number;
}

export interface LmuOpponentIntervalLocator {
  blockIndex: number;
  firstFrameIndex: number;
  lastFrameIndex: number;
  repeatedFrames: readonly { frameIndex: number; extraCount: number }[];
}

export interface LmuOpponentLapIndexRecord extends Omit<LmuOpponentLapInterval, "frames"> {
  locators: readonly LmuOpponentIntervalLocator[];
  lastCompetitor: LmuCompetitor | null;
  opponentNumericChannelIds: readonly string[];
}

type MutableLocator = {
  blockIndex: number;
  firstFrameIndex: number;
  lastFrameIndex: number;
  repeatedFrames: Map<number, number>;
};

type ActiveInterval = {
  lapNumber: number | null;
  startSequence: string;
  previousDistance: number | null;
  previousLap: number | null;
  boundaryObserved: boolean;
  sampleCount: number;
  completeCoverage: boolean;
  sequenceCheckError: unknown;
  previousSampleSequence: string | null;
  previousSampleHasContext: boolean;
  locators: MutableLocator[];
  lastCompetitor: LmuCompetitor | null;
  opponentNumericChannelIds: Set<string>;
};

function identityKey(sessionKey: string, vehicleId: number, incarnation: number): string {
  return JSON.stringify([sessionKey, vehicleId, incarnation]);
}

function identityParts(identity: string): [string, number, number] {
  return JSON.parse(identity) as [string, number, number];
}

export class LmuOpponentIndexLimitError extends Error {
  constructor() {
    super("Opponent index locator segment limit exceeded");
    this.name = "LmuOpponentIndexLimitError";
  }
}
function lapId(sessionKey: string, vehicleId: number, incarnation: number, start: string): string {
  return createHash("sha256").update(`${sessionKey}\0${vehicleId}\0${incarnation}\0${start}`).digest("hex");
}

function appendLocator(current: ActiveInterval, locator: LmuOpponentFrameLocator, onNewSegment: () => void): void {
  const last = current.locators.at(-1);
  if (last && last.blockIndex === locator.blockIndex && locator.frameIndex === last.lastFrameIndex) {
    last.repeatedFrames.set(locator.frameIndex, (last.repeatedFrames.get(locator.frameIndex) ?? 0) + 1);
  } else if (last && last.blockIndex === locator.blockIndex && locator.frameIndex === last.lastFrameIndex + 1) {
    last.lastFrameIndex = locator.frameIndex;
  } else {
    onNewSegment();
    current.locators.push({
      blockIndex: locator.blockIndex, firstFrameIndex: locator.frameIndex, lastFrameIndex: locator.frameIndex,
      repeatedFrames: new Map(),
    });
  }
}

function appendSample(
  current: ActiveInterval,
  frame: LmuOpponentFrame,
  locator: LmuOpponentFrameLocator,
  competitor: LmuCompetitor,
  onNewLocatorSegment: () => void,
): void {
  if (current.boundaryObserved && current.completeCoverage && current.sampleCount > 0) {
    if (!frame.lmuContext || !current.previousSampleHasContext) {
      current.completeCoverage = false;
    } else {
      try {
        if (BigInt(frame.captureSequence) !== BigInt(current.previousSampleSequence!) + 1n) {
          current.completeCoverage = false;
        }
      } catch (error) {
        current.sequenceCheckError = error;
        current.completeCoverage = false;
      }
    }
  }
  appendLocator(current, locator, onNewLocatorSegment);
  current.sampleCount++;
  current.lastCompetitor = competitor;
  for (const [semanticId, value] of Object.entries(competitor.channels)) {
    if (value.state === "ok" && value.freshness === "fresh" &&
        typeof value.value === "number" && Number.isFinite(value.value)) {
      current.opponentNumericChannelIds.add(semanticId);
    }
  }
  current.previousSampleSequence = frame.captureSequence;
  current.previousSampleHasContext = frame.lmuContext !== undefined;
}

function createActiveInterval(lapNumber: number | null, startSequence: string, boundaryObserved: boolean): ActiveInterval {
  return {
    lapNumber, startSequence, previousDistance: null, previousLap: boundaryObserved ? lapNumber : null,
    boundaryObserved, sampleCount: 0, completeCoverage: true, sequenceCheckError: null,
    previousSampleSequence: null, previousSampleHasContext: false, locators: [], lastCompetitor: null,
    opponentNumericChannelIds: new Set(),
  };
}

/** Incremental wrap detector. Retains bounded active state plus compressed block locators. */
export class LmuOpponentLapIndexer {
  private readonly active = new Map<string, ActiveInterval>();
  private readonly present = new Set<string>();
  locatorSegmentCount = 0;
  private readonly maxLocatorSegments: number;

  constructor(maxLocatorSegments = Number.MAX_SAFE_INTEGER) {
    this.maxLocatorSegments = maxLocatorSegments;
  }

  push(
    frame: LmuOpponentFrame,
    locator: LmuOpponentFrameLocator | ((competitor: LmuCompetitor) => LmuOpponentFrameLocator),
  ): LmuOpponentLapIndexRecord[] {
    const locatorFor = (competitor: LmuCompetitor) => typeof locator === "function" ? locator(competitor) : locator;
    const completed: LmuOpponentLapIndexRecord[] = [];
    const noteLocatorSegment = () => {
      if (this.locatorSegmentCount >= this.maxLocatorSegments) throw new LmuOpponentIndexLimitError();
      this.locatorSegmentCount++;
    };
    const finish = (identity: string, current: ActiveInterval, endSequence: string | null, complete: boolean) => {
      const [sessionKey, vehicleId, incarnation] = identityParts(identity);
      completed.push({
        opponentLapId: lapId(sessionKey, vehicleId, incarnation, current.startSequence),
        sessionKey, vehicleId, incarnation,
        lapNumber: current.lapNumber, startSequence: current.startSequence, endSequence,
        coverage: complete ? "complete" : "partial", validity: "unknown",
        locators: current.locators.map((segment) => ({
          blockIndex: segment.blockIndex,
          firstFrameIndex: segment.firstFrameIndex,
          lastFrameIndex: segment.lastFrameIndex,
          repeatedFrames: [...segment.repeatedFrames].map(([frameIndex, extraCount]) => ({ frameIndex, extraCount })),
        })),
        lastCompetitor: current.lastCompetitor,
        opponentNumericChannelIds: [...current.opponentNumericChannelIds],
      });
    };
    const inFrame = new Set<string>();
    for (const competitor of frame.competitors) {
      if (competitor.isPlayer) continue;
      const identity = identityKey(frame.sessionKey, competitor.vehicleId, competitor.incarnation);
      inFrame.add(identity);
      const distance = numberValue(channel(competitor, "race.competitor.lap-distance"));
      const lap = numberValue(channel(competitor, "race.competitor.current-lap-number"));
      let current = this.active.get(identity);
      if (!current) {
        current = createActiveInterval(lap, frame.captureSequence, false);
        this.active.set(identity, current);
      }
      const counterChanged = current.previousLap !== null && lap !== null && lap !== current.previousLap;
      if (counterChanged && lap !== current.previousLap! + 1) {
        if (current.sampleCount) finish(identity, current, null, false);
        current = createActiveInterval(lap, frame.captureSequence, false);
        this.active.set(identity, current);
      }
      const wrap = current.previousDistance !== null && distance !== null &&
        current.previousLap !== null && lap === current.previousLap + 1 &&
        distance < current.previousDistance;
      if (wrap) {
        const lastCompetitor = frame.competitors.find((entry) =>
          entry.vehicleId === competitor.vehicleId && entry.incarnation === competitor.incarnation)!;
        appendSample(current, frame, locatorFor(competitor), lastCompetitor, noteLocatorSegment);
        if (current.sampleCount) {
          if (current.boundaryObserved && current.sequenceCheckError !== null) throw current.sequenceCheckError;
          finish(identity, current, frame.captureSequence, current.boundaryObserved && current.completeCoverage);
        }
        current = createActiveInterval(lap, frame.captureSequence, true);
        this.active.set(identity, current);
      }
      const lastCompetitor = frame.competitors.find((entry) =>
        entry.vehicleId === competitor.vehicleId && entry.incarnation === competitor.incarnation)!;
      appendSample(current, frame, locatorFor(competitor), lastCompetitor, noteLocatorSegment);
      current.previousDistance = distance;
      current.previousLap = lap;
    }
    for (const identity of this.present) {
      if (inFrame.has(identity)) continue;
      const current = this.active.get(identity);
      if (current?.sampleCount) finish(identity, current, null, false);
      this.active.delete(identity);
    }
    this.present.clear();
    for (const identity of inFrame) this.present.add(identity);
    return completed;
  }

  finish(): LmuOpponentLapIndexRecord[] {
    const completed: LmuOpponentLapIndexRecord[] = [];
    for (const [identity, current] of this.active) {
      if (current.sampleCount > 1) {
        const [sessionKey, vehicleId, incarnation] = identityParts(identity);
        completed.push({
          opponentLapId: lapId(sessionKey, vehicleId, incarnation, current.startSequence),
          sessionKey, vehicleId, incarnation,
          lapNumber: current.lapNumber, startSequence: current.startSequence, endSequence: null,
          coverage: "partial", validity: "unknown",
          locators: current.locators.map((segment) => ({
            blockIndex: segment.blockIndex,
            firstFrameIndex: segment.firstFrameIndex,
            lastFrameIndex: segment.lastFrameIndex,
            repeatedFrames: [...segment.repeatedFrames].map(([frameIndex, extraCount]) => ({ frameIndex, extraCount })),
          })),
          lastCompetitor: current.lastCompetitor,
          opponentNumericChannelIds: [...current.opponentNumericChannelIds],
        });
      }
    }
    this.active.clear();
    this.present.clear();
    return completed;
  }
}

/** Indexes only observed lap-distance wraps; scalar best/last reports never create intervals. */
export function indexLmuOpponentLaps<Frame extends LmuOpponentFrame>(frames: readonly Frame[]): LmuOpponentLapInterval<Frame>[] {
  const indexer = new LmuOpponentLapIndexer();
  const records: LmuOpponentLapIndexRecord[] = [];
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    records.push(...indexer.push(frames[frameIndex]!, { blockIndex: 0, frameIndex }));
  }
  records.push(...indexer.finish());
  return records.map((record) => {
    const { locators, lastCompetitor: _lastCompetitor, opponentNumericChannelIds: _opponentNumericChannelIds, ...interval } = record;
    const materialized: Frame[] = [];
    for (const locator of locators) {
      const repeated = new Map(locator.repeatedFrames.map((entry) => [entry.frameIndex, entry.extraCount]));
      for (let index = locator.firstFrameIndex; index <= locator.lastFrameIndex; index++) {
        const frame = frames[index]!;
        materialized.push(frame);
        for (let extra = repeated.get(index) ?? 0; extra > 0; extra--) materialized.push(frame);
      }
    }
    return { ...interval, frames: materialized };
  });
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
): Promise<{ source: LapReplaySource; interval: LmuOpponentLapInterval<LmuOpponentCaptureFrame> }> {
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
