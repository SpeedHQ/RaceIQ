/**
 * Triplet processing pipeline.
 *
 * Defines processors that handle triplets from BufferedKunosMemoryReader.
 * Can be composed and chained for different modes (recording, parsing, etc).
 */

export interface TripletProcessor {
  /** Return false to halt the pipeline for this triplet (e.g. invalid status). */
  process(triplet: {
    physics: Buffer;
    graphics: Buffer;
    staticData: Buffer;
  }): Promise<boolean | void>;
}

export interface TripletRecorder {
  writePhysics(buffer: Buffer): void;
  writeGraphics(buffer: Buffer): void;
  writeStatic(buffer: Buffer): void;
}

/**
 * DumpToBinProcessor: writes raw buffers to .bin file (recording mode).
 */
export class DumpToBinProcessor implements TripletProcessor {
  private readonly recorder: TripletRecorder;

  constructor(recorder: TripletRecorder) {
    this.recorder = recorder;
  }

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<void> {
    this.recorder.writePhysics(triplet.physics);
    this.recorder.writeGraphics(triplet.graphics);
    this.recorder.writeStatic(triplet.staticData);
  }
}

/**
 * Pipeline: orchestrates multiple triplet processors in sequence.
 */
export class TripletPipeline {
  private processors: TripletProcessor[] = [];

  register(...processors: TripletProcessor[]): void {
    this.processors.push(...processors);
  }

  async process(triplet: {
    physics: Buffer;
    graphics: Buffer;
    staticData: Buffer;
  }): Promise<void> {
    for (const processor of this.processors) {
      const result = await processor.process(triplet);
      if (result === false) break;
    }
  }
}
