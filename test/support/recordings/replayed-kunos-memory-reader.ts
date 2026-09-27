import type { IRealtimeKunosMemoryReader } from "../../../server/games/kunos/memory-reader";
import type { Triplet } from "../../../server/games/kunos/triplet-pipeline";

/** Reconstructs changing Kunos shared-memory pages from recorded triplets. */
export class ReplayedKunosMemoryReader implements IRealtimeKunosMemoryReader {
  private readonly frames: readonly Triplet[];
  private frameIndex = 0;
  private latest: Triplet | null = null;
  private started = false;
  private resolveExhausted!: () => void;
  readonly exhausted: Promise<void>;

  constructor(frames: readonly Triplet[]) {
    this.frames = frames;
    this.exhausted = new Promise<void>((resolve) => {
      this.resolveExhausted = resolve;
    });
  }

  start(): void {
    this.started = true;
    if (this.frames.length === 0) this.resolveExhausted();
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  getDebugBuffers(): Triplet | null {
    return this.latest;
  }

  getLatestBuffers(): {
    physics: Buffer | null;
    graphics: Buffer | null;
    staticData: Buffer | null;
  } {
    if (!this.started) {
      return { physics: null, graphics: null, staticData: null };
    }

    const source = this.frames[this.frameIndex];
    if (source) {
      this.latest = {
        physics: Buffer.from(source.physics),
        graphics: Buffer.from(source.graphics),
        staticData: Buffer.from(source.staticData),
      };
      this.frameIndex++;
      if (this.frameIndex === this.frames.length) this.resolveExhausted();
    }

    return this.latest ?? { physics: null, graphics: null, staticData: null };
  }
}
