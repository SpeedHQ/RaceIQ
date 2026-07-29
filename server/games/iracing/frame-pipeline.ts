import type { IRacingRecorder } from "./recorder";

export interface IRacingFrameProcessor {
  /** Return false to stop processing this frame. */
  process(frame: Buffer): Promise<boolean | void>;
}

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

export class IRacingFramePipeline {
  private readonly processors: IRacingFrameProcessor[] = [];

  register(...processors: IRacingFrameProcessor[]): void {
    this.processors.push(...processors);
  }

  async process(frame: Buffer): Promise<void> {
    for (const processor of this.processors) {
      const result = await processor.process(frame);
      if (result === false) break;
    }
  }
}
