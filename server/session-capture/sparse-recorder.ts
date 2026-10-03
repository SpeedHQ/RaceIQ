import { LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_V2_SIZE } from "../games/lmu/source-frame";
import { ACC_PACKED_MAGIC, ACEVO_PACKED_MAGIC } from "../games/kunos/pack-triplet";
import type { GameId } from "@raceiq/shared/games/ids";
import { encodeKunosSparseFrame } from "./kunos-sparse";
import { encodeLmuSparseFrame } from "./lmu-sparse";
import { encodeGenericSparseFrame, genericFrameIdentity } from "./generic-sparse";
import { SessionRecorder } from "./recorder";

const CHECKPOINT_INTERVAL = 128;

/** Encodes source frames using the same checkpoint groups as live capture. */
export class SparseCaptureEncoder {
  private readonly gameId: GameId;
  private previous: Buffer | null = null;
  private checkpointOffset = 0;
  private framesSinceCheckpoint = 0;

  constructor(gameId: GameId) {
    this.gameId = gameId;
  }

  reset(): void {
    this.previous = null;
    this.framesSinceCheckpoint = 0;
  }

  encode(frame: Buffer, recordOffset: number): Buffer {
    // Imported compact v1 frames and unrelated source formats stay legacy raw.
    const isLmuV2 = this.gameId === "lmu" && frame.length === LMU_SOURCE_FRAME_V2_SIZE &&
      frame.subarray(0, LMU_SOURCE_FRAME_MAGIC.length).equals(LMU_SOURCE_FRAME_MAGIC);
    const kunosMagic = this.gameId === "acc" ? ACC_PACKED_MAGIC : ACEVO_PACKED_MAGIC;
    const isKunos = (this.gameId === "acc" || this.gameId === "ac-evo") &&
      frame.length >= 20 && frame.readUInt32LE(0) === kunosMagic;
    const generic = this.gameId === "fm-2023" || this.gameId === "f1-2025" || this.gameId === "iracing"
      ? genericFrameIdentity(frame) : null;
    const validGeneric = generic !== null && generic.startsWith(`${this.gameId === "fm-2023" ? "fm" : this.gameId === "f1-2025" ? "f1" : "iracing"}:`);
    if (!isLmuV2 && !isKunos && !validGeneric) {
      this.reset();
      return frame;
    }
    const adjacent = this.previous && this.previous.length === frame.length &&
      (!validGeneric || genericFrameIdentity(this.previous) === generic);
    if (!adjacent || this.framesSinceCheckpoint >= CHECKPOINT_INTERVAL) {
      this.checkpointOffset = recordOffset;
      this.framesSinceCheckpoint = 0;
      this.previous = frame;
      this.framesSinceCheckpoint++;
      return frame;
    }
    const distance = recordOffset - this.checkpointOffset;
    const delta = isLmuV2
      ? encodeLmuSparseFrame(frame, this.previous!, distance)
      : isKunos ? encodeKunosSparseFrame(frame, this.previous!, distance)
        : encodeGenericSparseFrame(frame, this.previous!, distance);
    if (delta.length >= frame.length) {
      this.checkpointOffset = recordOffset;
      this.framesSinceCheckpoint = 0;
      this.previous = frame;
      this.framesSinceCheckpoint++;
      return frame;
    }
    // Live source adapters provide immutable buffers; retaining avoids a frame copy.
    this.previous = frame;
    this.framesSinceCheckpoint++;
    return delta;
  }
}

/** All supported source frames use bounded, independently seekable checkpoint groups. */
export class SparseSessionRecorder extends SessionRecorder {
  private readonly encoder: SparseCaptureEncoder;
  constructor(gameId: GameId = "lmu") {
    super();
    this.encoder = new SparseCaptureEncoder(gameId);
  }

  override start(path: string): string {
    this.encoder.reset();
    return super.start(path);
  }

  override writeRecord(frame: Buffer, frameTimeMs?: number): void {
    if (!this.recording) return;
    super.writeRecord(this.encoder.encode(frame, this.getCurrentByteOffset()), frameTimeMs);
  }

  override writeRawCaptureBytes(bytes: Buffer): void {
    this.encoder.reset();
    super.writeRawCaptureBytes(bytes);
  }

  override writeSegmentBoundary(): void {
    this.encoder.reset();
    super.writeSegmentBoundary();
  }

  override async stop(): Promise<void> {
    this.encoder.reset();
    await super.stop();
  }
}
