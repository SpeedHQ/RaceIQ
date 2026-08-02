export const IRACING_SOURCE_MAGIC = 0x51495249; // "IRIQ" in little-endian bytes
export const IRACING_SOURCE_SCHEMA_VERSION = 2;
export const IRACING_SOURCE_SCHEMA_VERSION_V3 = 3;

const HEADER_SIZE = 12;
const V2_MAX_PAYLOAD_SIZE = 256 * 1024;
const SESSION_INFO_MAX_SIZE = 4 * 1024 * 1024;
// Includes 4 MiB SessionInfo plus a full SDK row after f64 expansion,
// variable dictionary, and normalized session metadata.
export const IRACING_MAX_SOURCE_FRAME_SIZE = 16 * 1024 * 1024;
const V3_MAX_PAYLOAD_SIZE = IRACING_MAX_SOURCE_FRAME_SIZE - HEADER_SIZE;
const MAX_VARIABLE_COUNT = 4096;
const SESSION_FRAME_TYPE = 1;
const VALUES_DELTA_FRAME_TYPE = 2;

const VALUE_TYPE = {
  Boolean: 1,
  Number: 2,
  String: 3,
  BooleanArray: 4,
  NumberArray: 5,
} as const;

type ValueType = (typeof VALUE_TYPE)[keyof typeof VALUE_TYPE];

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

/**
 * Wire format:
 *   [u32 magic][u16 version][u8 frameType][u8 reserved][u32 payloadLength]
 *   session frame: packed session fields, then a name/type dictionary with
 *                  the first complete value set
 *   v3 session frame: the v2 payload followed by
 *                     [i32 revision][u32 YAML byte length][UTF-8 YAML]
 *   delta frame:   [u16 changedCount], then [u16 dictionaryIndex][value]
 *
 * Numbers are f64 so SDK integers, floats, and doubles round-trip without a
 * per-variable numeric-type table or a schema refresh when 0 becomes 0.016.
 */
interface VariableDefinition {
  name: string;
  type: ValueType;
}

export interface IRacingSourceDecoderState {
  session: IRacingSessionSnapshot | null;
  variables: VariableDefinition[];
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


function valueType(value: IRacingValue): ValueType {
  if (typeof value === "boolean") return VALUE_TYPE.Boolean;
  if (typeof value === "number") return VALUE_TYPE.Number;
  if (typeof value === "string") return VALUE_TYPE.String;
  return value.every((entry) => typeof entry === "boolean")
    ? VALUE_TYPE.BooleanArray
    : VALUE_TYPE.NumberArray;
}

function isValueCompatible(value: IRacingValue, type: ValueType): boolean {
  switch (type) {
    case VALUE_TYPE.Boolean:
      return typeof value === "boolean";
    case VALUE_TYPE.Number:
      return typeof value === "number" && Number.isFinite(value);
    case VALUE_TYPE.String:
      return typeof value === "string";
    case VALUE_TYPE.BooleanArray:
      return (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "boolean")
      );
    case VALUE_TYPE.NumberArray:
      return (
        Array.isArray(value) &&
        value.every(
          (entry) => typeof entry === "number" && Number.isFinite(entry),
        )
      );
  }
}

function cloneValue(value: IRacingValue): IRacingValue {
  return Array.isArray(value) ? [...value] : value;
}

function valuesEqual(left: IRacingValue, right: IRacingValue): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return left === right;
  }
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry === right[index]);
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

function utf8Size(value: string): number {
  const size = Buffer.byteLength(value, "utf8");
  if (size > 0xffff) {
    throw new Error(`iRacing source string is too large (${size} bytes)`);
  }
  return 2 + size;
}

function encodedValueSize(value: IRacingValue, type: ValueType): number {
  if (!isValueCompatible(value, type)) {
    throw new Error("iRacing source value does not match its variable type");
  }
  switch (type) {
    case VALUE_TYPE.Boolean:
      return 1;
    case VALUE_TYPE.Number:
      return 8;
    case VALUE_TYPE.String:
      return utf8Size(value as string);
    case VALUE_TYPE.BooleanArray: {
      const length = (value as boolean[]).length;
      if (length > 0xffff) {
        throw new Error(`iRacing source array is too large (${length} values)`);
      }
      return 2 + length;
    }
    case VALUE_TYPE.NumberArray: {
      const length = (value as number[]).length;
      if (length > 0xffff) {
        throw new Error(`iRacing source array is too large (${length} values)`);
      }
      return 2 + length * 8;
    }
  }
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class BufferWriter {
  offset: number;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer, offset = 0) {
    this.buffer = buffer;
    this.offset = offset;
  }

  u8(value: number): void {
    this.buffer.writeUInt8(value, this.offset);
    this.offset += 1;
  }

  u16(value: number): void {
    this.buffer.writeUInt16LE(value, this.offset);
    this.offset += 2;
  }

  u32(value: number): void {
    this.buffer.writeUInt32LE(value, this.offset);
    this.offset += 4;
  }

  i32(value: number): void {
    this.buffer.writeInt32LE(value, this.offset);
    this.offset += 4;
  }

  f64(value: number): void {
    this.buffer.writeDoubleLE(value, this.offset);
    this.offset += 8;
  }

  string(value: string): void {
    const size = Buffer.byteLength(value, "utf8");
    this.u16(size);
    this.buffer.write(value, this.offset, size, "utf8");
    this.offset += size;
  }

  utf8(value: string): void {
    const size = Buffer.byteLength(value, "utf8");
    this.buffer.write(value, this.offset, size, "utf8");
    this.offset += size;
  }
}

class BufferReader {
  offset: number;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer, offset = 0) {
    this.buffer = buffer;
    this.offset = offset;
  }

  private require(size: number): void {
    if (size < 0 || this.offset + size > this.buffer.length) {
      throw new Error("Truncated iRacing source frame");
    }
  }

  u8(): number {
    this.require(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    this.require(2);
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.require(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.require(4);
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.require(8);
    const value = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    if (!Number.isFinite(value)) {
      throw new Error("Non-finite number in iRacing source frame");
    }
    return value;
  }

  utf8(size: number): string {
    this.require(size);
    const value = UTF8_DECODER.decode(
      this.buffer.subarray(this.offset, this.offset + size),
    );
    this.offset += size;
    return value;
  }

  string(): string {
    return this.utf8(this.u16());
  }
}

function writeValue(
  writer: BufferWriter,
  value: IRacingValue,
  type: ValueType,
): void {
  switch (type) {
    case VALUE_TYPE.Boolean:
      writer.u8(value ? 1 : 0);
      return;
    case VALUE_TYPE.Number:
      writer.f64(value as number);
      return;
    case VALUE_TYPE.String:
      writer.string(value as string);
      return;
    case VALUE_TYPE.BooleanArray: {
      const values = value as boolean[];
      writer.u16(values.length);
      for (const entry of values) writer.u8(entry ? 1 : 0);
      return;
    }
    case VALUE_TYPE.NumberArray: {
      const values = value as number[];
      writer.u16(values.length);
      for (const entry of values) writer.f64(entry);
      return;
    }
  }
}

function readValue(reader: BufferReader, type: ValueType): IRacingValue {
  switch (type) {
    case VALUE_TYPE.Boolean: {
      const value = reader.u8();
      if (value > 1) throw new Error("Invalid boolean in iRacing source frame");
      return value === 1;
    }
    case VALUE_TYPE.Number:
      return reader.f64();
    case VALUE_TYPE.String:
      return reader.string();
    case VALUE_TYPE.BooleanArray: {
      const count = reader.u16();
      const values: boolean[] = [];
      for (let index = 0; index < count; index++) {
        const value = reader.u8();
        if (value > 1) {
          throw new Error("Invalid boolean array in iRacing source frame");
        }
        values.push(value === 1);
      }
      return values;
    }
    case VALUE_TYPE.NumberArray: {
      const count = reader.u16();
      const values: number[] = [];
      for (let index = 0; index < count; index++) {
        values.push(reader.f64());
      }
      return values;
    }
    default:
      throw new Error(`Unknown iRacing source value type ${type}`);
  }
}

function sessionPayloadSize(
  frame: IRacingSourceFrame,
  variables: VariableDefinition[],
): number {
  const sectors = frame.session.sectorStarts ?? [];
  if (sectors.length > 0xfffe) {
    throw new Error(
      `iRacing source sector list is too large (${sectors.length} values)`,
    );
  }
  let size =
    11 * 8 +
    utf8Size(frame.session.trackName) +
    utf8Size(frame.session.carName) +
    utf8Size(frame.session.carClassName) +
    2 +
    sectors.length * 8 +
    2;
  for (const variable of variables) {
    size +=
      utf8Size(variable.name) +
      1 +
      encodedValueSize(frame.values[variable.name]!, variable.type);
  }
  if (frame.schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3) {
    if (
      !Number.isInteger(frame.sessionInfoUpdate) ||
      frame.sessionInfoUpdate < -0x80000000 ||
      frame.sessionInfoUpdate > 0x7fffffff
    ) {
      throw new Error("Invalid iRacing SessionInfo revision");
    }
    const sessionInfoSize = Buffer.byteLength(frame.sessionInfo, "utf8");
    if (sessionInfoSize > SESSION_INFO_MAX_SIZE) {
      throw new Error(
        `iRacing SessionInfo is too large (${sessionInfoSize} bytes)`,
      );
    }
    size += 8 + sessionInfoSize;
  }
  return size;
}

function allocateFrame(
  schemaVersion: 2 | 3,
  frameType: number,
  payloadSize: number,
): Buffer {
  const maxPayloadSize =
    schemaVersion === IRACING_SOURCE_SCHEMA_VERSION
      ? V2_MAX_PAYLOAD_SIZE
      : V3_MAX_PAYLOAD_SIZE;
  if (payloadSize <= 0 || payloadSize > maxPayloadSize) {
    throw new Error(`iRacing source frame is too large (${payloadSize} bytes)`);
  }
  const output = Buffer.allocUnsafe(HEADER_SIZE + payloadSize);
  output.writeUInt32LE(IRACING_SOURCE_MAGIC, 0);
  output.writeUInt16LE(schemaVersion, 4);
  output.writeUInt8(frameType, 6);
  output.writeUInt8(0, 7);
  output.writeUInt32LE(payloadSize, 8);
  return output;
}

function encodeSessionFrame(
  frame: IRacingSourceFrame,
  variables: VariableDefinition[],
): Buffer {
  if (variables.length === 0 || variables.length > MAX_VARIABLE_COUNT) {
    throw new Error(
      `Invalid iRacing source variable count (${variables.length})`,
    );
  }
  const output = allocateFrame(
    frame.schemaVersion,
    SESSION_FRAME_TYPE,
    sessionPayloadSize(frame, variables),
  );
  const writer = new BufferWriter(output, HEADER_SIZE);
  const session = frame.session;

  writer.f64(session.sessionId);
  writer.f64(session.subSessionId);
  writer.f64(session.sessionNum);
  writer.f64(session.driverCarIdx);
  writer.f64(session.trackId);
  writer.string(session.trackName);
  writer.f64(session.trackLengthM);
  const sectors = session.sectorStarts;
  writer.u16(sectors === undefined ? 0xffff : sectors.length);
  for (const sector of sectors ?? []) writer.f64(sector);
  writer.f64(session.carId);
  writer.string(session.carName);
  writer.f64(session.carClassId);
  writer.string(session.carClassName);
  writer.f64(session.engineIdleRpm);
  writer.f64(session.engineRedlineRpm);
  writer.f64(session.engineCylinderCount);

  writer.u16(variables.length);
  for (const variable of variables) {
    writer.string(variable.name);
    writer.u8(variable.type);
    writeValue(writer, frame.values[variable.name]!, variable.type);
  }
  if (frame.schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3) {
    const sessionInfoSize = Buffer.byteLength(frame.sessionInfo, "utf8");
    writer.i32(frame.sessionInfoUpdate);
    writer.u32(sessionInfoSize);
    writer.utf8(frame.sessionInfo);
  }
  return output;
}

/**
 * Stateful packed encoder. The first frame, and every session/schema change,
 * carries session metadata plus a variable dictionary and full values. Normal
 * ticks contain only [variable index, changed value] pairs.
 */
export class IRacingSourceFrameEncoder {
  private schemaVersion: 2 | 3 | null = null;
  private session: IRacingSessionSnapshot | null = null;
  private sessionInfo: string | null = null;
  private sessionInfoUpdate: number | null = null;
  private variables: VariableDefinition[] = [];
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
          !isValueCompatible(value, variable.type)
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
        type: valueType(frame.values[name]!),
      }));
      const encoded = encodeSessionFrame(frame, this.variables);
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
        this.previousValues[variable.name] = cloneValue(
          frame.values[variable.name]!,
        );
      }
      return encoded;
    }

    let changedCount = 0;
    let payloadSize = 2;
    for (const variable of this.variables) {
      const value = frame.values[variable.name]!;
      if (!valuesEqual(value, this.previousValues[variable.name]!)) {
        changedCount++;
        payloadSize += 2 + encodedValueSize(value, variable.type);
      }
    }

    const output = allocateFrame(
      frame.schemaVersion,
      VALUES_DELTA_FRAME_TYPE,
      payloadSize,
    );
    const writer = new BufferWriter(output, HEADER_SIZE);
    writer.u16(changedCount);
    for (let index = 0; index < this.variables.length; index++) {
      const variable = this.variables[index]!;
      const value = frame.values[variable.name]!;
      if (valuesEqual(value, this.previousValues[variable.name]!)) continue;
      writer.u16(index);
      writeValue(writer, value, variable.type);
      this.previousValues[variable.name] = cloneValue(value);
    }
    return output;
  }
}

export function canHandleIRacingSourceFrame(buf: Buffer): boolean {
  if (
    buf.length < HEADER_SIZE ||
    buf.readUInt32LE(0) !== IRACING_SOURCE_MAGIC
  ) {
    return false;
  }
  const schemaVersion = buf.readUInt16LE(4);
  if (
    schemaVersion !== IRACING_SOURCE_SCHEMA_VERSION &&
    schemaVersion !== IRACING_SOURCE_SCHEMA_VERSION_V3
  ) {
    return false;
  }
  const frameType = buf.readUInt8(6);
  return (
    frameType === SESSION_FRAME_TYPE ||
    frameType === VALUES_DELTA_FRAME_TYPE
  );
}

export function isIRacingSessionFrame(buf: Buffer): boolean {
  return (
    canHandleIRacingSourceFrame(buf) &&
    buf.readUInt8(6) === SESSION_FRAME_TYPE
  );
}

function readSessionFrame(
  reader: BufferReader,
  schemaVersion: 2 | 3,
): {
  session: IRacingSessionSnapshot;
  variables: VariableDefinition[];
  values: Record<string, IRacingValue>;
  sessionInfo?: string;
  sessionInfoUpdate?: number;
} {
  const sessionId = reader.f64();
  const subSessionId = reader.f64();
  const sessionNum = reader.f64();
  const driverCarIdx = reader.f64();
  const trackId = reader.f64();
  const trackName = reader.string();
  const trackLengthM = reader.f64();
  const encodedSectorCount = reader.u16();
  const sectorStarts =
    encodedSectorCount === 0xffff ? undefined : ([] as number[]);
  const sectorCount = encodedSectorCount === 0xffff ? 0 : encodedSectorCount;
  for (let index = 0; index < sectorCount; index++) {
    sectorStarts!.push(reader.f64());
  }
  const carId = reader.f64();
  const carName = reader.string();
  const carClassId = reader.f64();
  const carClassName = reader.string();
  const engineIdleRpm = reader.f64();
  const engineRedlineRpm = reader.f64();
  const engineCylinderCount = reader.f64();

  const variableCount = reader.u16();
  if (variableCount === 0 || variableCount > MAX_VARIABLE_COUNT) {
    throw new Error("Invalid iRacing source variable count");
  }
  const variables: VariableDefinition[] = [];
  const values: Record<string, IRacingValue> = {};
  const variableNames = new Set<string>();
  for (let index = 0; index < variableCount; index++) {
    const name = reader.string();
    const type = reader.u8() as ValueType;
    if (!name || variableNames.has(name)) {
      throw new Error("Invalid iRacing source variable name");
    }
    variableNames.add(name);
    const value = readValue(reader, type);
    variables.push({ name, type });
    Object.defineProperty(values, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }

  const decoded = {
    session: {
      sessionId,
      subSessionId,
      sessionNum,
      driverCarIdx,
      trackId,
      trackName,
      trackLengthM,
      sectorStarts,
      carId,
      carName,
      carClassId,
      carClassName,
      engineIdleRpm,
      engineRedlineRpm,
      engineCylinderCount,
    },
    variables,
    values,
  };
  if (schemaVersion === IRACING_SOURCE_SCHEMA_VERSION) return decoded;

  const sessionInfoUpdate = reader.i32();
  const sessionInfoSize = reader.u32();
  if (sessionInfoSize > SESSION_INFO_MAX_SIZE) {
    throw new Error("iRacing SessionInfo is too large");
  }
  return {
    ...decoded,
    sessionInfo: reader.utf8(sessionInfoSize),
    sessionInfoUpdate,
  };
}

export function decodeIRacingSourceFrame(
  buf: Buffer,
  state?: IRacingSourceDecoderState | null,
): IRacingSourceFrame | null {
  if (!canHandleIRacingSourceFrame(buf)) return null;

  const schemaVersion = buf.readUInt16LE(4) as 2 | 3;
  const frameType = buf.readUInt8(6);
  const payloadLength = buf.readUInt32LE(8);
  const maxPayloadSize =
    schemaVersion === IRACING_SOURCE_SCHEMA_VERSION
      ? V2_MAX_PAYLOAD_SIZE
      : V3_MAX_PAYLOAD_SIZE;
  if (
    payloadLength === 0 ||
    payloadLength > maxPayloadSize ||
    buf.length !== HEADER_SIZE + payloadLength
  ) {
    if (frameType === SESSION_FRAME_TYPE) resetDecoderState(state);
    return null;
  }

  try {
    const reader = new BufferReader(buf, HEADER_SIZE);
    if (frameType === SESSION_FRAME_TYPE) {
      const decoded = readSessionFrame(reader, schemaVersion);
      if (reader.offset !== buf.length) {
        resetDecoderState(state);
        return null;
      }
      if (state) {
        state.session = decoded.session;
        state.variables = decoded.variables;
        state.values = decoded.values;
        state.schemaVersion = schemaVersion;
        if (schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3) {
          state.sessionInfo = decoded.sessionInfo!;
          state.sessionInfoUpdate = decoded.sessionInfoUpdate!;
        } else {
          delete state.sessionInfo;
          delete state.sessionInfoUpdate;
        }
      }
      if (schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3) {
        return {
          schemaVersion,
          session: decoded.session,
          values: decoded.values,
          sessionInfo: decoded.sessionInfo!,
          sessionInfoUpdate: decoded.sessionInfoUpdate!,
        };
      }
      return {
        schemaVersion,
        session: decoded.session,
        values: decoded.values,
      };
    }

    if (
      !state?.session ||
      state.variables.length === 0 ||
      state.schemaVersion !== schemaVersion
    ) {
      return null;
    }
    if (
      schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3 &&
      (state.sessionInfo === undefined ||
        state.sessionInfoUpdate === undefined)
    ) {
      return null;
    }
    const changedCount = reader.u16();
    if (changedCount > state.variables.length) return null;
    const updates: Array<{ name: string; value: IRacingValue }> = [];
    const seen = new Set<number>();
    for (let index = 0; index < changedCount; index++) {
      const variableIndex = reader.u16();
      const variable = state.variables[variableIndex];
      if (!variable || seen.has(variableIndex)) return null;
      seen.add(variableIndex);
      updates.push({
        name: variable.name,
        value: readValue(reader, variable.type),
      });
    }
    if (reader.offset !== buf.length) return null;
    for (const update of updates) {
      state.values[update.name] = update.value;
    }
    if (schemaVersion === IRACING_SOURCE_SCHEMA_VERSION_V3) {
      return {
        schemaVersion,
        session: state.session,
        values: state.values,
        sessionInfo: state.sessionInfo!,
        sessionInfoUpdate: state.sessionInfoUpdate!,
      };
    }
    return {
      schemaVersion,
      session: state.session,
      values: state.values,
    };
  } catch {
    if (frameType === SESSION_FRAME_TYPE) resetDecoderState(state);
    return null;
  }
}
