import { encodeF1CaptureFrame, encodeLosslessF1CaptureFrame } from "../f1-2025/f1-wire";
import { LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { ACC_PACKED_MAGIC, ACEVO_PACKED_MAGIC } from "../kunos/pack-triplet";
import type { GameId } from "@raceiq/shared/games/ids";
import { encodeKunosSparseFrame } from "./kunos-sparse";
import { encodeLmuSparseFrame } from "./lmu-sparse";
import { encodeGenericSparseFrame, genericFrameIdentity } from "./generic-sparse";
import { SessionRecorder } from "./recorder";
import { compactF1CaptureRecords, encodeSparseCaptureFormatFrame } from "./framing";

const CHECKPOINT_INTERVAL = 128;

/** Encodes source frames using the same checkpoint groups as live capture. */
export class SparseCaptureEncoder {
  private readonly gameId: GameId;
  private readonly omitF1MotionChannels: boolean;
  private previous: Buffer | null = null;
  private checkpointOffset = 0;
  private framesSinceCheckpoint = 0;
  private forceCheckpoint = false;

  constructor(gameId: GameId, omitF1MotionChannels = false) {
    this.gameId = gameId;
    this.omitF1MotionChannels = omitF1MotionChannels;
  }

  reset(): void {
    this.previous = null;
    this.framesSinceCheckpoint = 0;
    this.forceCheckpoint = false;
  }
  requestCheckpoint(): void {
    this.forceCheckpoint = true;
  }

  encode(frame: Buffer, recordOffset: number): Buffer {
    const forceCheckpoint = this.forceCheckpoint;
    this.forceCheckpoint = false;
    const isF1 = this.gameId === "f1-2025";
    const captureFrame = isF1
      ? this.omitF1MotionChannels ? encodeF1CaptureFrame(frame) : encodeLosslessF1CaptureFrame(frame)
      : frame;
    const isCompactF1 = captureFrame !== frame;
    // Imported compact v1 frames and unrelated source formats stay legacy raw.
    const isLmuV2 = this.gameId === "lmu" && frame.length === LMU_SOURCE_FRAME_V2_SIZE &&
      frame.subarray(0, LMU_SOURCE_FRAME_MAGIC.length).equals(LMU_SOURCE_FRAME_MAGIC);
    const kunosMagic = this.gameId === "acc" ? ACC_PACKED_MAGIC : ACEVO_PACKED_MAGIC;
    const isKunos = (this.gameId === "acc" || this.gameId === "ac-evo") &&
      frame.length >= 20 && frame.readUInt32LE(0) === kunosMagic;
    const generic = isF1 ? genericFrameIdentity(frame) : this.gameId === "fm-2023" || this.gameId === "iracing"
      ? genericFrameIdentity(frame) : null;
    const validGeneric = generic !== null && generic.startsWith(`${this.gameId === "fm-2023" ? "fm" : isF1 ? "f1" : "iracing"}:`);
    if (!isLmuV2 && !isKunos && !validGeneric) {
      this.reset();
      return frame;
    }
    const storage = isCompactF1 ? captureFrame : frame;
    const adjacent = this.previous && this.previous.length === storage.length &&
      (!validGeneric || genericFrameIdentity(this.previous) === generic);
    if (forceCheckpoint || !adjacent || this.framesSinceCheckpoint >= CHECKPOINT_INTERVAL) {
      this.checkpointOffset = recordOffset;
      this.framesSinceCheckpoint = 0;
      this.previous = storage;
      this.framesSinceCheckpoint++;
      return storage;
    }
    const distance = recordOffset - this.checkpointOffset;
    const delta = isLmuV2
      ? encodeLmuSparseFrame(frame, this.previous!, distance)
      : isKunos ? encodeKunosSparseFrame(frame, this.previous!, distance)
        : encodeGenericSparseFrame(storage, this.previous!, distance);
    if (delta.length >= storage.length) {
      this.checkpointOffset = recordOffset;
      this.framesSinceCheckpoint = 0;
      this.previous = storage;
      this.framesSinceCheckpoint++;
      return storage;
    }
    this.previous = storage;
    this.framesSinceCheckpoint++;
    return delta;
  }
}

/** All supported source frames use bounded, independently seekable checkpoint groups. */
export class SparseSessionRecorder extends SessionRecorder {
  private readonly encoder: SparseCaptureEncoder;
  private readonly gameId: GameId;
  constructor(gameId: GameId = "lmu") {
    super();
    this.gameId = gameId;
    this.encoder = new SparseCaptureEncoder(gameId, true);
  }
  private sparseFormatMarkerWritten = false;

  override start(path: string): string {
    this.encoder.reset();
    this.sparseFormatMarkerWritten = false;
    return super.start(path);
  }
  override requestFullCheckpoint(): void {
    this.encoder.requestCheckpoint();
  }

  override writeRecord(frame: Buffer, frameTimeMs?: number): void {
    if (!this.recording) return;
    super.writeRecord(this.encoder.encode(frame, this.getCurrentByteOffset()), frameTimeMs);
    if (!this.sparseFormatMarkerWritten) {
      super.writeRawCaptureBytes(encodeSparseCaptureFormatFrame());
      this.sparseFormatMarkerWritten = true;
    }
  }

  override writeRawCaptureBytes(bytes: Buffer): void {
    this.encoder.reset();
    super.writeRawCaptureBytes(this.gameId === "f1-2025" ? compactF1CaptureRecords(bytes) : bytes);
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
