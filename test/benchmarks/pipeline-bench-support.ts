export interface BenchmarkPipeline {
  processPacket(packet: unknown): Promise<void>;
  flushIncompleteLap(): Promise<void>;
}

export function createBoundedPipelineRunner(
  pipeline: BenchmarkPipeline,
  flushEvery: number,
): { run(packet: unknown): Promise<void> } {
  if (!Number.isInteger(flushEvery) || flushEvery < 1) {
    throw new Error(`flushEvery must be a positive integer, got ${flushEvery}`);
  }

  let pendingPackets = 0;
  return {
    async run(packet: unknown): Promise<void> {
      await pipeline.processPacket(packet);
      pendingPackets += 1;
      if (pendingPackets >= flushEvery) {
        pendingPackets = 0;
        await pipeline.flushIncompleteLap();
      }
    },
  };
}
