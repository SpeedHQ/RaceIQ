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

  async process(triplet: Triplet): Promise<undefined> {
    this.recorder.writePhysics(triplet.physics);
    this.recorder.writeGraphics(triplet.graphics);
    this.recorder.writeStatic(triplet.staticData);
    return undefined;
  }
}

/** Pipeline that preserves the Kunos-specific public contract. */
export class TripletPipeline extends AsyncProcessorPipeline<
  Triplet,
  TripletProcessor
> {}

export interface KunosTripletPipelineOptions {
  recordingEnabled: boolean;
  recorder: TripletRecorder;
  parser: TripletProcessor;
  gate?: TripletProcessor;
}

/**
 * Builds mutually exclusive raw-recording and semantic-processing paths.
 * Recording mode must never invoke parser or persistence work.
 */
export function createKunosTripletPipeline({
  recordingEnabled,
  recorder,
  parser,
  gate,
}: KunosTripletPipelineOptions): TripletPipeline {
  const pipeline = new TripletPipeline();
  if (gate) pipeline.register(gate);
  pipeline.register(
    recordingEnabled ? new DumpToBinProcessor(recorder) : parser,
  );
  return pipeline;
}
