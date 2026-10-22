import { createHash, timingSafeEqual } from "node:crypto";
import type { LMUSourceFrame } from "./source-frame";
import { decodeLmuContext } from "@raceiq/shared/telemetry/lmu-context";
import {
  LMU_MAX_VEHICLES, LMU_SHARED_MEMORY_SIZE, LMU_SCORING_INFO_OFFSET,
  LMU_SCORING_INFO_SIZE, LMU_SCORING_INFO, LMU_SCORING_VEHICLES_OFFSET,
  LMU_SCORING_VEHICLE_SIZE, LMU_SCORING_VEHICLE, LMU_TELEMETRY_HEADER_OFFSET,
  LMU_TELEMETRY_INFO_OFFSET, LMU_TELEMETRY_INFO_SIZE, LMU_TELEMETRY,
} from "./layout";

const SOURCE_MAGIC = Buffer.from("RQLMUSF\0", "ascii");
export const LMU_COMPANION_MAGIC = Buffer.from("RQLMUCP\0", "ascii");
export const LMU_PARTITION_SCHEMA_VERSION = 5;
const HEADER = 28;
const PRIMARY_HEADER = 56;
const COMPANION_HEADER = 80;
const NATIVE_END = HEADER + LMU_SHARED_MEMORY_SIZE;
const MAX_FRAME = 16 * 1024 * 1024;
const ABSENT = 0xffffffff;
type Range = { start: number; end: number };
type StoredRange = Range & { bytes: Buffer };
interface Primary {
  originalLength: number;
  originalVersion: 2 | 3;
  telemetryOffset: number;
  scoringOffset: number;
  contextOffset: number;
  contextLength: number;
  projectedLength: number;
  ranges: StoredRange[];
}

function fail(): never { throw new Error("Invalid LMU source partition"); }
function space(byte: number): boolean { return byte === 32 || byte === 9 || byte === 10 || byte === 13; }

/** Return the raw property and separator span; preserve all other original JSON bytes. */
function competitorProperty(json: Buffer): Range | null {
  let cursor = 0;
  const whitespace = () => { while (cursor < json.length && space(json[cursor]!)) cursor++; };
  const stringEnd = () => {
    if (json[cursor++] !== 34) fail();
    while (cursor < json.length) {
      const byte = json[cursor++]!;
      if (byte === 92) cursor++;
      else if (byte === 34) return;
    }
    fail();
  };
  const valueEnd = () => {
    if (json[cursor] === 34) { stringEnd(); return; }
    if (json[cursor] === 123 || json[cursor] === 91) {
      const closers: number[] = [];
      do {
        const byte = json[cursor]!;
        if (byte === 34) { stringEnd(); continue; }
        cursor++;
        if (byte === 123) closers.push(125);
        else if (byte === 91) closers.push(93);
        else if (byte === 125 || byte === 93) { if (closers.pop() !== byte) fail(); }
        if (cursor > json.length) fail();
      } while (closers.length && cursor < json.length);
      if (closers.length) fail();
      return;
    }
    const start = cursor;
    while (cursor < json.length && json[cursor] !== 44 && json[cursor] !== 125 && !space(json[cursor]!)) cursor++;
    if (cursor === start) fail();
  };
  whitespace();
  if (json[cursor++] !== 123) fail();
  let precedingComma = -1;
  let result: Range | null = null;
  const names = new Set<string>();
  while (true) {
    whitespace();
    if (json[cursor] === 125) { cursor++; break; }
    const start = cursor;
    stringEnd();
    const name: unknown = JSON.parse(json.subarray(start, cursor).toString("utf8"));
    if (typeof name !== "string" || names.has(name)) fail();
    names.add(name);
    whitespace();
    if (json[cursor++] !== 58) fail();
    whitespace(); valueEnd();
    const end = cursor;
    whitespace();
    const comma = json[cursor] === 44 ? cursor : -1;
    if (name === "competitors") result = comma >= 0
      ? { start, end: comma + 1 }
      : { start: precedingComma >= 0 ? precedingComma : start, end };
    if (comma < 0) { if (json[cursor++] !== 125) fail(); break; }
    precedingComma = comma;
    cursor++;
  }
  whitespace();
  if (cursor !== json.length) fail();
  return result;
}

function complement(ranges: readonly Range[], end: number): Range[] {
  let cursor = HEADER;
  const result: Range[] = [];
  for (const range of ranges) {
    if (range.start < cursor || range.end <= range.start || range.end > end) fail();
    if (range.start > cursor) result.push({ start: cursor, end: range.start });
    cursor = range.end;
  }
  if (cursor < end) result.push({ start: cursor, end });
  return result;
}

function encodeRanges(header: Buffer, ranges: readonly Range[], original: Buffer): Buffer {
  const size = header.length + ranges.length * 8 + ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  if (size > MAX_FRAME || ranges.length > 0xffff) fail();
  const output = Buffer.allocUnsafe(size);
  header.copy(output);
  let descriptor = header.length;
  let cursor = header.length + ranges.length * 8;
  for (const range of ranges) {
    output.writeUInt32LE(range.start, descriptor);
    output.writeUInt32LE(range.end - range.start, descriptor + 4);
    descriptor += 8;
    original.copy(output, cursor, range.start, range.end);
    cursor += range.end - range.start;
  }
  return output;
}

function readRanges(frame: Buffer, header: number, count: number, originalLength: number): StoredRange[] {
  if (count > 32 || header + count * 8 > frame.length) fail();
  let cursor = header + count * 8;
  let previousEnd = HEADER;
  const result: StoredRange[] = [];
  for (let index = 0; index < count; index++) {
    const descriptor = header + index * 8;
    const start = frame.readUInt32LE(descriptor);
    const length = frame.readUInt32LE(descriptor + 4);
    const end = start + length;
    if (!length || start < previousEnd || end > originalLength || cursor + length > frame.length) fail();
    result.push({ start, end, bytes: frame.subarray(cursor, cursor + length) });
    previousEnd = end;
    cursor += length;
  }
  if (cursor !== frame.length) fail();
  return result;
}

function sourceSlice(ranges: readonly StoredRange[], start: number, length: number): Buffer {
  const range = ranges.find((item) => item.start <= start && item.end >= start + length);
  if (!range) fail();
  return range.bytes.subarray(start - range.start, start - range.start + length);
}

function readPrimary(frame: Buffer): Primary {
  if (frame.length < PRIMARY_HEADER || frame.length > MAX_FRAME || !frame.subarray(0, 8).equals(SOURCE_MAGIC) || frame.readUInt16LE(8) !== LMU_PARTITION_SCHEMA_VERSION) fail();
  const originalLength = frame.readUInt32LE(28);
  const originalVersion = frame.readUInt16LE(32);
  const telemetryOffset = frame.readUInt32LE(36);
  const scoringOffset = frame.readUInt32LE(40);
  const contextOffset = frame.readUInt32LE(44);
  const contextLength = frame.readUInt32LE(48);
  const projectedLength = frame.readUInt32LE(52);
  if ((originalVersion !== 2 && originalVersion !== 3) || originalLength < NATIVE_END || originalLength > MAX_FRAME) fail();
  if (originalVersion === 2 ? originalLength !== NATIVE_END || contextOffset || contextLength || projectedLength : contextOffset !== NATIVE_END + 4 || contextLength !== originalLength - contextOffset || projectedLength > contextLength) fail();
  const telemetryStart = HEADER + LMU_TELEMETRY_INFO_OFFSET;
  const scoringStart = HEADER + LMU_SCORING_VEHICLES_OFFSET;
  if (telemetryOffset !== ABSENT && (telemetryOffset < telemetryStart || telemetryOffset + LMU_TELEMETRY_INFO_SIZE > NATIVE_END || (telemetryOffset - telemetryStart) % LMU_TELEMETRY_INFO_SIZE)) fail();
  if (scoringOffset !== ABSENT && (scoringOffset < scoringStart || scoringOffset + LMU_SCORING_VEHICLE_SIZE > scoringStart + LMU_MAX_VEHICLES * LMU_SCORING_VEHICLE_SIZE || (scoringOffset - scoringStart) % LMU_SCORING_VEHICLE_SIZE)) fail();
  const ranges = readRanges(frame, PRIMARY_HEADER, frame.readUInt16LE(34), originalLength);
  const allowed: Range[] = [
    { start: HEADER, end: scoringStart },
    { start: HEADER + LMU_TELEMETRY_HEADER_OFFSET, end: telemetryStart },
  ];
  if (telemetryOffset !== ABSENT) allowed.push({ start: telemetryOffset, end: telemetryOffset + LMU_TELEMETRY_INFO_SIZE });
  if (scoringOffset !== ABSENT) allowed.push({ start: scoringOffset, end: scoringOffset + LMU_SCORING_VEHICLE_SIZE });
  if (contextOffset) allowed.push({ start: NATIVE_END, end: originalLength });
  for (const range of ranges) if (!allowed.some((item) => item.start <= range.start && item.end >= range.end)) fail();
  sourceSlice(ranges, HEADER, LMU_SCORING_VEHICLES_OFFSET);
  sourceSlice(ranges, HEADER + LMU_TELEMETRY_HEADER_OFFSET, 4);
  if (telemetryOffset !== ABSENT) sourceSlice(ranges, telemetryOffset, LMU_TELEMETRY_INFO_SIZE);
  if (scoringOffset !== ABSENT) sourceSlice(ranges, scoringOffset, LMU_SCORING_VEHICLE_SIZE);
  return { originalLength, originalVersion, telemetryOffset, scoringOffset, contextOffset, contextLength, projectedLength, ranges };
}

export function isLMUPartitionPrimary(frame: Buffer): boolean {
  try { readPrimary(frame); return true; } catch { return false; }
}
export function isLMUPartitionCompanion(frame: Buffer): boolean {
  try {
    if (frame.length < COMPANION_HEADER || frame.length > MAX_FRAME || !frame.subarray(0, 8).equals(LMU_COMPANION_MAGIC) || frame.readUInt16LE(8) !== 1) return false;
    const length = frame.readUInt32LE(12);
    if (length < NATIVE_END || length > MAX_FRAME) return false;
    readRanges(frame, COMPANION_HEADER, frame.readUInt16LE(10), length);
    return true;
  } catch { return false; }
}
export function getLMUPartitionSourceLength(frame: Buffer): number | null {
  try { return readPrimary(frame).originalLength; } catch { return null; }
}

/** Pair identity is content-bound, never a nearest-timestamp association. */
export function getLMUPartitionKey(frame: Buffer): string | null {
  if (isLMUPartitionCompanion(frame)) return frame.subarray(16, 48).toString("hex");
  return isLMUPartitionPrimary(frame) ? createHash("sha256").update(frame).digest("hex") : null;
}

export function decodeLMUPartitionPrimary(frame: Buffer): LMUSourceFrame | null {
  try {
    const primary = readPrimary(frame);
    let lmuContext: LMUSourceFrame["lmuContext"];
    if (primary.contextOffset) {
      const parts = primary.ranges.flatMap((range) => {
        const start = Math.max(range.start, primary.contextOffset);
        return range.end > start ? [range.bytes.subarray(start - range.start)] : [];
      });
      const bytes = Buffer.concat(parts);
      if (bytes.length !== primary.projectedLength) return null;
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (Object.prototype.hasOwnProperty.call(parsed, "competitors")) return null;
      lmuContext = decodeLmuContext(primary.telemetryOffset === ABSENT ? { ...parsed, status: "unavailable" } : parsed) ?? undefined;
      if (!lmuContext) return null;
    }
    const telemetry = primary.telemetryOffset === ABSENT ? Buffer.alloc(0) : sourceSlice(primary.ranges, primary.telemetryOffset, LMU_TELEMETRY_INFO_SIZE);
    const playerScoring = primary.scoringOffset === ABSENT ? null : sourceSlice(primary.ranges, primary.scoringOffset, LMU_SCORING_VEHICLE_SIZE);
    if (!Number.isFinite(frame.readDoubleLE(20)) || frame.readDoubleLE(20) < 0) return null;
    if (lmuContext && telemetry.length && lmuContext.playerVehicleId !== telemetry.readInt32LE(LMU_TELEMETRY.id)) return null;
    return {
      schemaVersion: 5, gameVersion: frame.readInt32LE(12), sessionEvent: frame.readUInt32LE(16),
      captureTimestampMs: frame.readDoubleLE(20), telemetry,
      scoringInfo: sourceSlice(primary.ranges, HEADER + LMU_SCORING_INFO_OFFSET, LMU_SCORING_INFO_SIZE),
      playerScoring, ...(lmuContext ? { lmuContext } : {}),
    };
  } catch { return null; }
}

export function partitionLMUSourceFrame(frame: Buffer): { primary: Buffer; companion: Buffer | null } | null {
  if (frame.length >= 10 && frame.readUInt16LE(8) === 5) return decodeLMUPartitionPrimary(frame) ? { primary: frame, companion: null } : null;
  if (frame.length < NATIVE_END || frame.length > MAX_FRAME || !frame.subarray(0, 8).equals(SOURCE_MAGIC)) return null;
  const version = frame.readUInt16LE(8);
  if (version !== 2 && version !== 3) return null;
  try {
    const memory = frame.subarray(HEADER, NATIVE_END);
    const count = memory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET);
    const slot = memory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET + 1);
    const hasPlayer = memory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET + 2) !== 0;
    const scoringCount = memory.readInt32LE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
    if (count > LMU_MAX_VEHICLES || scoringCount < 0 || scoringCount > LMU_MAX_VEHICLES || (hasPlayer && slot >= count)) fail();
    const telemetryOffset = hasPlayer ? HEADER + LMU_TELEMETRY_INFO_OFFSET + slot * LMU_TELEMETRY_INFO_SIZE : ABSENT;
    let scoringOffset = ABSENT;
    if (hasPlayer) {
      const id = frame.readInt32LE(telemetryOffset + LMU_TELEMETRY.id);
      let telemetryMatches = 0, scoringMatches = 0, players = 0;
      for (let index = 0; index < count; index++) if (memory.readInt32LE(LMU_TELEMETRY_INFO_OFFSET + index * LMU_TELEMETRY_INFO_SIZE) === id) telemetryMatches++;
      for (let index = 0; index < scoringCount; index++) {
        const offset = HEADER + LMU_SCORING_VEHICLES_OFFSET + index * LMU_SCORING_VEHICLE_SIZE;
        if (frame.readInt32LE(offset) === id) scoringMatches++;
        if (frame.readUInt8(offset + LMU_SCORING_VEHICLE.isPlayer)) {
          players++;
          if (frame.readInt32LE(offset) === id) scoringOffset = offset;
        }
      }
      if (id < 0 || telemetryMatches !== 1 || scoringMatches > 1 || players > 1 || (version === 3 && (players !== 1 || scoringOffset === ABSENT))) fail();
    }
    let contextOffset = 0, contextLength = 0, projectedLength = 0;
    let removed: Range | null = null;
    if (version === 3) {
      if (frame.length < NATIVE_END + 4) fail();
      contextOffset = NATIVE_END + 4;
      contextLength = frame.readUInt32LE(NATIVE_END);
      if (contextLength !== frame.length - contextOffset) fail();
      const json = frame.subarray(contextOffset);
      if (!decodeLmuContext(JSON.parse(json.toString("utf8")))) fail();
      removed = competitorProperty(json);
      projectedLength = contextLength - (removed ? removed.end - removed.start : 0);
    } else if (frame.length !== NATIVE_END) fail();
    const ranges: Range[] = [
      { start: HEADER, end: HEADER + LMU_SCORING_VEHICLES_OFFSET },
      ...(scoringOffset === ABSENT ? [] : [{ start: scoringOffset, end: scoringOffset + LMU_SCORING_VEHICLE_SIZE }]),
      { start: HEADER + LMU_TELEMETRY_HEADER_OFFSET, end: HEADER + LMU_TELEMETRY_INFO_OFFSET },
      ...(telemetryOffset === ABSENT ? [] : [{ start: telemetryOffset, end: telemetryOffset + LMU_TELEMETRY_INFO_SIZE }]),
    ];
    if (version === 3) {
      if (removed) {
        ranges.push({ start: NATIVE_END, end: contextOffset + removed.start });
        if (contextOffset + removed.end < frame.length) ranges.push({ start: contextOffset + removed.end, end: frame.length });
      } else ranges.push({ start: NATIVE_END, end: frame.length });
    }
    const excluded = complement(ranges, frame.length);
    const header = Buffer.alloc(PRIMARY_HEADER);
    frame.copy(header, 0, 0, HEADER);
    header.writeUInt16LE(5, 8);
    header.writeUInt32LE(frame.length, 28);
    header.writeUInt16LE(version, 32);
    header.writeUInt16LE(ranges.length, 34);
    header.writeUInt32LE(telemetryOffset, 36);
    header.writeUInt32LE(scoringOffset, 40);
    header.writeUInt32LE(contextOffset, 44);
    header.writeUInt32LE(contextLength, 48);
    header.writeUInt32LE(projectedLength, 52);
    const primary = encodeRanges(header, ranges, frame);
    if (!decodeLMUPartitionPrimary(primary)) fail();
    const companionHeader = Buffer.alloc(COMPANION_HEADER);
    LMU_COMPANION_MAGIC.copy(companionHeader);
    companionHeader.writeUInt16LE(1, 8);
    companionHeader.writeUInt16LE(excluded.length, 10);
    companionHeader.writeUInt32LE(frame.length, 12);
    createHash("sha256").update(primary).digest().copy(companionHeader, 16);
    createHash("sha256").update(frame).digest().copy(companionHeader, 48);
    return { primary, companion: encodeRanges(companionHeader, excluded, frame) };
  } catch { return null; }
}

export function restoreLMUSourceFrame(primary: Buffer, companion: Buffer): Buffer {
  const metadata = readPrimary(primary);
  if (!isLMUPartitionCompanion(companion) || companion.readUInt32LE(12) !== metadata.originalLength || !timingSafeEqual(createHash("sha256").update(primary).digest(), companion.subarray(16, 48))) fail();
  const other = readRanges(companion, COMPANION_HEADER, companion.readUInt16LE(10), metadata.originalLength);
  const ranges = [...metadata.ranges, ...other].sort((a, b) => a.start - b.start);
  let cursor = HEADER;
  for (const range of ranges) { if (range.start !== cursor) fail(); cursor = range.end; }
  if (cursor !== metadata.originalLength || !decodeLMUPartitionPrimary(primary)) fail();
  const original = Buffer.allocUnsafe(metadata.originalLength);
  primary.copy(original, 0, 0, HEADER);
  original.writeUInt16LE(metadata.originalVersion, 8);
  for (const range of ranges) range.bytes.copy(original, range.start);
  if (!timingSafeEqual(createHash("sha256").update(original).digest(), companion.subarray(48, 80))) fail();
  return original;
}
