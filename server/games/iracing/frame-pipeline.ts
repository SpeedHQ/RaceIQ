import { AsyncProcessorPipeline, type AsyncProcessor } from "../shared/pipeline";
import type { IRacingRecorder } from "./recorder";

type CapturedFrame = Buffer | { rawFrame: Buffer; frameTimeMs: number };
/** Processor that may halt downstream handling by returning false. */
export interface IRacingFrameProcessor extends AsyncProcessor<CapturedFrame> {}

/**
 * Writes canonical iRacing source frames to the game-specific recorder.
 */
export class DumpToBinProcessor implements IRacingFrameProcessor {
  private readonly recorder: Pick<IRacingRecorder, "writeFrame">;

  constructor(recorder: Pick<IRacingRecorder, "writeFrame">) {
    this.recorder = recorder;
  }

  async process(input: CapturedFrame): Promise<undefined> {
    this.recorder.writeFrame(Buffer.isBuffer(input) ? input : input.rawFrame);
    return undefined;
  }
}

/**
 * Dispatches canonical source frames through the registered parser path.
 */
export class ParsingProcessor implements IRacingFrameProcessor {
  private readonly dispatchRawFrame: (frame: Buffer, frameTimeMs?: number) => Promise<void>;

  constructor(dispatchRawFrame: (frame: Buffer, frameTimeMs?: number) => Promise<void>) {
    this.dispatchRawFrame = dispatchRawFrame;
  }

  async process(input: CapturedFrame): Promise<undefined> {
    await this.dispatchRawFrame(Buffer.isBuffer(input) ? input : input.rawFrame, Buffer.isBuffer(input) ? undefined : input.frameTimeMs);
    return undefined;
  }
}

export class IRacingFramePipeline extends AsyncProcessorPipeline<
  CapturedFrame,
  IRacingFrameProcessor
> {}
