type ProcessorResult = boolean | void;

export interface AsyncProcessor<TInput> {
  process(input: TInput): Promise<ProcessorResult>;
}

/**
 * Generic async processor pipeline used by per-domain frame/triplet dispatchers.
 */
export class AsyncProcessorPipeline<
  TInput,
  TProcessor extends AsyncProcessor<TInput> = AsyncProcessor<TInput>,
> {
  private readonly processors: TProcessor[] = [];

  register(...processors: TProcessor[]): void {
    this.processors.push(...processors);
  }

  async process(input: TInput): Promise<void> {
    for (const processor of this.processors) {
      const result = await processor.process(input);
      if (result === false) break;
    }
  }
}
