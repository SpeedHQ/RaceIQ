import { AMS2_MEMORY_SIZE } from "./layout";
import { AMS2_MAX_MEMORY_BYTES } from "@raceiq/capture-formats/ams2/dump";
export const AMS2_FRAME_MAGIC = Buffer.from("RQAMS201", "ascii");
export const AMS2_FRAME_HEADER_SIZE = 24;
export function encodeAMS2Frame(memory: Buffer, timestampMs: number, epoch: number): Buffer {
  if (memory.length < AMS2_MEMORY_SIZE || memory.length > AMS2_MAX_MEMORY_BYTES || !Number.isSafeInteger(timestampMs) || timestampMs < 0) throw new Error("Invalid AMS2 snapshot");
  const frame = Buffer.alloc(AMS2_FRAME_HEADER_SIZE + memory.length);
  AMS2_FRAME_MAGIC.copy(frame);
  frame.writeDoubleLE(timestampMs, 8);
  frame.writeUInt32LE(epoch, 16);
  frame.writeUInt32LE(memory.length, 20);
  memory.copy(frame, AMS2_FRAME_HEADER_SIZE);
  return frame;
}
export function decodeAMS2Frame(frame: Buffer): { memory: Buffer; timestampMs: number; epoch: number } | null {
  if (
    frame.length < AMS2_FRAME_HEADER_SIZE + AMS2_MEMORY_SIZE ||
    frame.length > AMS2_FRAME_HEADER_SIZE + AMS2_MAX_MEMORY_BYTES ||
    !frame.subarray(0, 8).equals(AMS2_FRAME_MAGIC) ||
    frame.readUInt32LE(20) !== frame.length - AMS2_FRAME_HEADER_SIZE
  )
    return null;
  const timestampMs = frame.readDoubleLE(8);
  if (!Number.isFinite(timestampMs) || timestampMs < 0) return null;
  return { memory: frame.subarray(AMS2_FRAME_HEADER_SIZE), timestampMs, epoch: frame.readUInt32LE(16) };
}

/** Menus/exit are source lifecycle events even when participant data is empty. */
export function isAMS2SessionEndFrame(raw: Buffer): boolean {
  const frame = decodeAMS2Frame(raw);
  if (!frame) return false;
  const version = frame.memory.readUInt32LE(0);
  const state = frame.memory.readUInt32LE(8);
  return version >= 8 && version <= 14 && (state === 0 || state === 1);
}
