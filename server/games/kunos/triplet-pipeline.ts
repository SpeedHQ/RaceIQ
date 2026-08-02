/**
 * Triplet processing pipeline.
 *
 * Defines processors that handle triplets from BufferedKunosMemoryReader.
 * Can be composed and chained for different modes (recording, parsing, etc).
 */
import { AsyncProcessorPipeline, type AsyncProcessor } from "../shared/pipeline";

export interface Triplet {
  physics: Buffer;
  graphics: Buffer;
  staticData: Buffer;
}

/** Processor that may halt downstream handling by returning false. */
export interface TripletProcessor extends AsyncProcessor<Triplet> {}

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

  async process(triplet: Triplet): Promise<void> {
    this.recorder.writePhysics(triplet.physics);
    this.recorder.writeGraphics(triplet.graphics);
    this.recorder.writeStatic(triplet.staticData);
  }
}

/** Pipeline that preserves the Kunos-specific public contract. */
export class TripletPipeline extends AsyncProcessorPipeline<
  Triplet,
  TripletProcessor
> {}
