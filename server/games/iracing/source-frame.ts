import {
  cloneSourceValue,
  decodeSourceDeltaFrame,
  decodeSourceSessionFrame,
  encodeSourceDeltaFrame,
  encodeSourceSessionFrame,
  hasValidSourcePayloadLength,
  isSourceValueCompatible,
  readSourceFrameHeader,
  SOURCE_FRAME_MAGIC,
  SOURCE_FRAME_MAX_SIZE,
  SOURCE_FRAME_SCHEMA_V2,
  SOURCE_FRAME_SCHEMA_V3,
  SOURCE_FRAME_SESSION_TYPE,
  sourceValuesEqual,
  sourceValueType,
  type SourceFrameVariableDefinition,
} from "./source-frame-codec";

export const IRACING_SOURCE_MAGIC = SOURCE_FRAME_MAGIC;
export const IRACING_SOURCE_SCHEMA_VERSION = SOURCE_FRAME_SCHEMA_V2;
export const IRACING_SOURCE_SCHEMA_VERSION_V3 = SOURCE_FRAME_SCHEMA_V3;
export const IRACING_MAX_SOURCE_FRAME_SIZE = SOURCE_FRAME_MAX_SIZE;

export type IRacingValue = number | boolean | string | Array<number | boolean>;

export interface IRacingSessionSnapshot {
  sessionId: number;
  subSessionId: number;
  sessionNum: number;
  driverCarIdx: number;
  trackId: number;
  trackName: string;
  trackLengthM: number;
  /** Native sector start fractions, including sector 1 at 0. */
  sectorStarts?: number[];
  carId: number;
  carName: string;
  carClassId: number;
  carClassName: string;
  engineIdleRpm: number;
  engineRedlineRpm: number;
  engineCylinderCount: number;
}

/**
 * Fully hydrated source frame consumed by the normalizer. On the wire, the
 * session frame carries this complete state once; following frames contain
 * only indexed values that changed since the prior tick.
 */
export interface IRacingSourceFrameV2 {
  schemaVersion: 2;
  session: IRacingSessionSnapshot;
  values: Record<string, IRacingValue>;
}

export interface IRacingSourceFrameV3 {
  schemaVersion: 3;
  session: IRacingSessionSnapshot;
  values: Record<string, IRacingValue>;
  sessionInfo: string;
  sessionInfoUpdate: number;
}

export type IRacingSourceFrame = IRacingSourceFrameV2 | IRacingSourceFrameV3;

export interface IRacingSourceDecoderState {
  session: IRacingSessionSnapshot | null;
  variables: SourceFrameVariableDefinition[];
  values: Record<string, IRacingValue>;
  schemaVersion?: 2 | 3;
  sessionInfo?: string;
  sessionInfoUpdate?: number;
}

export function createIRacingSourceDecoderState(): IRacingSourceDecoderState {
  return {
    session: null,
    variables: [],
    values: {},
  };
}

function resetDecoderState(
  state: IRacingSourceDecoderState | null | undefined,
): void {
  if (!state) return;
  state.session = null;
  state.variables = [];
  state.values = {};
  delete state.schemaVersion;
  delete state.sessionInfo;
  delete state.sessionInfoUpdate;
}

function sessionsEqual(
  left: IRacingSessionSnapshot,
  right: IRacingSessionSnapshot,
): boolean {
  const leftSectors = left.sectorStarts ?? [];
  const rightSectors = right.sectorStarts ?? [];
  return (
    left.sessionId === right.sessionId &&
    left.subSessionId === right.subSessionId &&
    left.sessionNum === right.sessionNum &&
    left.driverCarIdx === right.driverCarIdx &&
    left.trackId === right.trackId &&
    left.trackName === right.trackName &&
    left.trackLengthM === right.trackLengthM &&
    left.carId === right.carId &&
    left.carName === right.carName &&
    left.carClassId === right.carClassId &&
    left.carClassName === right.carClassName &&
    left.engineIdleRpm === right.engineIdleRpm &&
    left.engineRedlineRpm === right.engineRedlineRpm &&
    left.engineCylinderCount === right.engineCylinderCount &&
    leftSectors.length === rightSectors.length &&
    leftSectors.every((value, index) => value === rightSectors[index])
  );
}

/**
 * Stateful packed encoder. First frame and each session/schema change carries
 * complete metadata, variable dictionary, and values. Later ticks carry only
 * indexed values changed since prior tick.
 */
export class IRacingSourceFrameEncoder {
  private schemaVersion: 2 | 3 | null = null;
  private session: IRacingSessionSnapshot | null = null;
  private sessionInfo: string | null = null;
  private sessionInfoUpdate: number | null = null;
  private variables: SourceFrameVariableDefinition[] = [];
  private previousValues: Record<string, IRacingValue> = {};

  reset(): void {
    this.schemaVersion = null;
    this.session = null;
    this.sessionInfo = null;
    this.sessionInfoUpdate = null;
    this.variables = [];
    this.previousValues = {};
  }

  encode(frame: IRacingSourceFrame): Buffer {
    const keys = Object.keys(frame.values);
    const schemaChanged =
      keys.length !== this.variables.length ||
      keys.some((name, index) => {
        const variable = this.variables[index];
        const value = frame.values[name];
        return (
          !variable ||
          variable.name !== name ||
          value === undefined ||
          !isSourceValueCompatible(value, variable.type)
        );
      });
    const sessionInfoChanged =
      frame.schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3 &&
      (frame.sessionInfo !== this.sessionInfo ||
        frame.sessionInfoUpdate !== this.sessionInfoUpdate);

    if (
      this.schemaVersion !== frame.schemaVersion ||
      !this.session ||
      !sessionsEqual(this.session, frame.session) ||
      schemaChanged ||
      sessionInfoChanged
    ) {
      this.variables = keys.map((name) => ({
        name,
        type: sourceValueType(frame.values[name]!),
      }));
      const encoded = encodeSourceSessionFrame(frame, this.variables);
      this.schemaVersion = frame.schemaVersion;
      this.session = {
        ...frame.session,
        sectorStarts: frame.session.sectorStarts
          ? [...frame.session.sectorStarts]
          : undefined,
      };
      this.sessionInfo =
        frame.schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3
          ? frame.sessionInfo
          : null;
      this.sessionInfoUpdate =
        frame.schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3
          ? frame.sessionInfoUpdate
          : null;
      this.previousValues = {};
      for (const variable of this.variables) {
        this.previousValues[variable.name] = cloneSourceValue(
          frame.values[variable.name]!,
        );
      }
      return encoded;
    }

    const encoded = encodeSourceDeltaFrame(
      frame.schemaVersion,
      this.variables,
      frame.values,
      this.previousValues,
    );
    for (const variable of this.variables) {
      const value = frame.values[variable.name]!;
      if (sourceValuesEqual(value, this.previousValues[variable.name]!)) {
        continue;
      }
      this.previousValues[variable.name] = cloneSourceValue(value);
    }
    return encoded;
  }
}

export function canHandleIRacingSourceFrame(buf: Buffer): boolean {
  return readSourceFrameHeader(buf) !== null;
}

export function isIRacingSessionFrame(buf: Buffer): boolean {
  return readSourceFrameHeader(buf)?.frameType === SOURCE_FRAME_SESSION_TYPE;
}

export function decodeIRacingSourceFrame(
  buf: Buffer,
  state?: IRacingSourceDecoderState | null,
): IRacingSourceFrame | null {
  const header = readSourceFrameHeader(buf);
  if (!header) return null;
  if (!hasValidSourcePayloadLength(buf, header)) {
    if (header.frameType === SOURCE_FRAME_SESSION_TYPE) resetDecoderState(state);
    return null;
  }

  try {
    if (header.frameType === SOURCE_FRAME_SESSION_TYPE) {
      const decoded = decodeSourceSessionFrame(buf, header.schemaVersion);
      if (state) {
        state.session = decoded.session;
        state.variables = decoded.variables;
        state.values = decoded.values;
        state.schemaVersion = header.schemaVersion;
        if (header.schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3) {
          state.sessionInfo = decoded.sessionInfo!;
          state.sessionInfoUpdate = decoded.sessionInfoUpdate!;
        } else {
          delete state.sessionInfo;
          delete state.sessionInfoUpdate;
        }
      }
      if (header.schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3) {
        return {
          schemaVersion: header.schemaVersion,
          session: decoded.session,
          values: decoded.values,
          sessionInfo: decoded.sessionInfo!,
          sessionInfoUpdate: decoded.sessionInfoUpdate!,
        };
      }
      return {
        schemaVersion: header.schemaVersion,
        session: decoded.session,
        values: decoded.values,
      };
    }

    if (
      !state?.session ||
      state.variables.length === 0 ||
      state.schemaVersion !== header.schemaVersion
    ) {
      return null;
    }
    if (
      header.schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3 &&
      (state.sessionInfo === undefined ||
        state.sessionInfoUpdate === undefined)
    ) {
      return null;
    }

    const decoded = decodeSourceDeltaFrame(buf, state.variables);
    for (const update of decoded.updates) {
      state.values[update.name] = update.value;
    }
    if (header.schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3) {
      return {
        schemaVersion: header.schemaVersion,
        session: state.session,
        values: state.values,
        sessionInfo: state.sessionInfo!,
        sessionInfoUpdate: state.sessionInfoUpdate!,
      };
    }
    return {
      schemaVersion: header.schemaVersion,
      session: state.session,
      values: state.values,
    };
  } catch {
    if (header.frameType === SOURCE_FRAME_SESSION_TYPE) resetDecoderState(state);
    return null;
  }
}
