import type {
  IRacingSessionSnapshot,
  IRacingSourceFrame,
  IRacingValue,
} from "./source-frame";

export const SOURCE_FRAME_MAGIC = 0x51495249; // "IRIQ" in little-endian bytes
export const SOURCE_FRAME_SCHEMA_V2 = 2;
export const SOURCE_FRAME_SCHEMA_V3 = 3;
export const SOURCE_FRAME_HEADER_SIZE = 12;
export const SOURCE_FRAME_MAX_SIZE = 16 * 1024 * 1024;
export const SOURCE_FRAME_SESSION_TYPE = 1;
export const SOURCE_FRAME_DELTA_TYPE = 2;

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

const V2_MAX_PAYLOAD_SIZE = 256 * 1024;
const SESSION_INFO_MAX_SIZE = 4 * 1024 * 1024;
const V3_MAX_PAYLOAD_SIZE = SOURCE_FRAME_MAX_SIZE - SOURCE_FRAME_HEADER_SIZE;
const MAX_VARIABLE_COUNT = 4096;
const VALUE_TYPE = {
  Boolean: 1,
  Number: 2,
  String: 3,
  BooleanArray: 4,
  NumberArray: 5,
} as const;

type ValueType = (typeof VALUE_TYPE)[keyof typeof VALUE_TYPE];

export interface SourceFrameVariableDefinition {
  name: string;
  type: ValueType;
}

export interface SourceFrameHeader {
  schemaVersion: 2 | 3;
  frameType: 1 | 2;
  payloadLength: number;
}

export interface DecodedSourceSession {
  session: IRacingSessionSnapshot;
  variables: SourceFrameVariableDefinition[];
  values: Record<string, IRacingValue>;
  sessionInfo?: string;
  sessionInfoUpdate?: number;
}

export interface DecodedSourceDelta {
  updates: Array<{ name: string; value: IRacingValue }>;
}

export function sourceValueType(value: IRacingValue): ValueType {
  if (typeof value === "boolean") return VALUE_TYPE.Boolean;
  if (typeof value === "number") return VALUE_TYPE.Number;
  if (typeof value === "string") return VALUE_TYPE.String;
  return value.every((entry) => typeof entry === "boolean")
    ? VALUE_TYPE.BooleanArray
    : VALUE_TYPE.NumberArray;
}

export function isSourceValueCompatible(
  value: IRacingValue,
  type: ValueType,
): boolean {
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

export function cloneSourceValue(value: IRacingValue): IRacingValue {
  return Array.isArray(value) ? [...value] : value;
}

export function sourceValuesEqual(
  left: IRacingValue,
  right: IRacingValue,
): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return left === right;
  }
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry === right[index]);
}

export function readSourceFrameHeader(buf: Buffer): SourceFrameHeader | null {
  if (
    buf.length < SOURCE_FRAME_HEADER_SIZE ||
    buf.readUInt32LE(0) !== SOURCE_FRAME_MAGIC
  ) {
    return null;
  }
  const schemaVersion = buf.readUInt16LE(4);
  if (
    schemaVersion !== SOURCE_FRAME_SCHEMA_V2 &&
    schemaVersion !== SOURCE_FRAME_SCHEMA_V3
  ) {
    return null;
  }
  const frameType = buf.readUInt8(6);
  if (
    frameType !== SOURCE_FRAME_SESSION_TYPE &&
    frameType !== SOURCE_FRAME_DELTA_TYPE
  ) {
    return null;
  }
  return {
    schemaVersion,
    frameType,
    payloadLength: buf.readUInt32LE(8),
  };
}

export function hasValidSourcePayloadLength(
  buf: Buffer,
  header: SourceFrameHeader,
): boolean {
  const maxPayloadSize =
    header.schemaVersion === SOURCE_FRAME_SCHEMA_V2
      ? V2_MAX_PAYLOAD_SIZE
      : V3_MAX_PAYLOAD_SIZE;
  return (
    header.payloadLength > 0 &&
    header.payloadLength <= maxPayloadSize &&
    buf.length === SOURCE_FRAME_HEADER_SIZE + header.payloadLength
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
  if (!isSourceValueCompatible(value, type)) {
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
  private readonly buffer: Buffer;
  offset: number;

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
  private readonly buffer: Buffer;
  offset: number;

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

function allocateFrame(
  schemaVersion: 2 | 3,
  frameType: 1 | 2,
  payloadSize: number,
): Buffer {
  const maxPayloadSize =
    schemaVersion === SOURCE_FRAME_SCHEMA_V2
      ? V2_MAX_PAYLOAD_SIZE
      : V3_MAX_PAYLOAD_SIZE;
  if (payloadSize <= 0 || payloadSize > maxPayloadSize) {
    throw new Error(`iRacing source frame is too large (${payloadSize} bytes)`);
  }
  const output = Buffer.allocUnsafe(SOURCE_FRAME_HEADER_SIZE + payloadSize);
  output.writeUInt32LE(SOURCE_FRAME_MAGIC, 0);
  output.writeUInt16LE(schemaVersion, 4);
  output.writeUInt8(frameType, 6);
  output.writeUInt8(0, 7);
  output.writeUInt32LE(payloadSize, 8);
  return output;
}

function sessionPayloadSize(
  frame: IRacingSourceFrame,
  variables: SourceFrameVariableDefinition[],
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
  if (frame.schemaVersion === SOURCE_FRAME_SCHEMA_V3) {
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

export function encodeSourceSessionFrame(
  frame: IRacingSourceFrame,
  variables: SourceFrameVariableDefinition[],
): Buffer {
  if (variables.length === 0 || variables.length > MAX_VARIABLE_COUNT) {
    throw new Error(
      `Invalid iRacing source variable count (${variables.length})`,
    );
  }
  const output = allocateFrame(
    frame.schemaVersion,
    SOURCE_FRAME_SESSION_TYPE,
    sessionPayloadSize(frame, variables),
  );
  const writer = new BufferWriter(output, SOURCE_FRAME_HEADER_SIZE);
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
  if (frame.schemaVersion === SOURCE_FRAME_SCHEMA_V3) {
    const sessionInfoSize = Buffer.byteLength(frame.sessionInfo, "utf8");
    writer.i32(frame.sessionInfoUpdate);
    writer.u32(sessionInfoSize);
    writer.utf8(frame.sessionInfo);
  }
  return output;
}

export function encodeSourceDeltaFrame(
  schemaVersion: 2 | 3,
  variables: readonly SourceFrameVariableDefinition[],
  values: Readonly<Record<string, IRacingValue>>,
  previousValues: Readonly<Record<string, IRacingValue>>,
): Buffer {
  let changedCount = 0;
  let payloadSize = 2;
  for (const variable of variables) {
    const value = values[variable.name]!;
    if (!sourceValuesEqual(value, previousValues[variable.name]!)) {
      changedCount++;
      payloadSize += 2 + encodedValueSize(value, variable.type);
    }
  }

  const output = allocateFrame(
    schemaVersion,
    SOURCE_FRAME_DELTA_TYPE,
    payloadSize,
  );
  const writer = new BufferWriter(output, SOURCE_FRAME_HEADER_SIZE);
  writer.u16(changedCount);
  for (let index = 0; index < variables.length; index++) {
    const variable = variables[index]!;
    const value = values[variable.name]!;
    if (sourceValuesEqual(value, previousValues[variable.name]!)) continue;
    writer.u16(index);
    writeValue(writer, value, variable.type);
  }
  return output;
}

export function decodeSourceSessionFrame(
  buf: Buffer,
  schemaVersion: 2 | 3,
): DecodedSourceSession {
  const reader = new BufferReader(buf, SOURCE_FRAME_HEADER_SIZE);
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
  const variables: SourceFrameVariableDefinition[] = [];
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

  const decoded: DecodedSourceSession = {
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
  if (schemaVersion === SOURCE_FRAME_SCHEMA_V3) {
    const sessionInfoUpdate = reader.i32();
    const sessionInfoSize = reader.u32();
    if (sessionInfoSize > SESSION_INFO_MAX_SIZE) {
      throw new Error("iRacing SessionInfo is too large");
    }
    decoded.sessionInfo = reader.utf8(sessionInfoSize);
    decoded.sessionInfoUpdate = sessionInfoUpdate;
  }
  if (reader.offset !== buf.length) {
    throw new Error("Trailing bytes in iRacing source frame");
  }
  return decoded;
}

export function decodeSourceDeltaFrame(
  buf: Buffer,
  variables: readonly SourceFrameVariableDefinition[],
): DecodedSourceDelta {
  const reader = new BufferReader(buf, SOURCE_FRAME_HEADER_SIZE);
  const changedCount = reader.u16();
  if (changedCount > variables.length) {
    throw new Error("Invalid iRacing source delta count");
  }
  const updates: Array<{ name: string; value: IRacingValue }> = [];
  const seen = new Set<number>();
  for (let index = 0; index < changedCount; index++) {
    const variableIndex = reader.u16();
    const variable = variables[variableIndex];
    if (!variable || seen.has(variableIndex)) {
      throw new Error("Invalid iRacing source delta index");
    }
    seen.add(variableIndex);
    updates.push({
      name: variable.name,
      value: readValue(reader, variable.type),
    });
  }
  if (reader.offset !== buf.length) {
    throw new Error("Trailing bytes in iRacing source frame");
  }
  return { updates };
}
