import { AsyncProcessorPipeline, type AsyncProcessor } from "../shared/pipeline";
import type { IRacingRecorder } from "./recorder";

/** Processor that may halt downstream handling by returning false. */
export interface IRacingFrameProcessor extends AsyncProcessor<Buffer> {}

/**
 * Writes canonical iRacing source frames to the game-specific recorder.
 */
export class DumpToBinProcessor implements IRacingFrameProcessor {
  private readonly recorder: Pick<IRacingRecorder, "writeFrame">;

  constructor(recorder: Pick<IRacingRecorder, "writeFrame">) {
    this.recorder = recorder;
  }

  async process(frame: Buffer): Promise<void> {
    this.recorder.writeFrame(frame);
  }
}

/**
 * Dispatches canonical source frames through the registered parser path.
 */
export class ParsingProcessor implements IRacingFrameProcessor {
  private readonly dispatchRawFrame: (frame: Buffer) => Promise<void>;

  constructor(dispatchRawFrame: (frame: Buffer) => Promise<void>) {
    this.dispatchRawFrame = dispatchRawFrame;
  }

  async process(frame: Buffer): Promise<void> {
    await this.dispatchRawFrame(frame);
  }
}

export class IRacingFramePipeline extends AsyncProcessorPipeline<
  Buffer,
  IRacingFrameProcessor
> {}
