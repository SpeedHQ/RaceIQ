/**
 * Abstract interface for ACC shared memory reading.
 *
 * Supports both real-time reads from Windows shared memory and test replays
 * from recorded dumps with realistic async buffer timing.
 */

export interface IAccMemoryReader {
  /** Start the memory reader and attempt connection. */
  start(): void;

  /** Stop the memory reader and clean up resources. */
  stop(): Promise<void>;

  /** Get the next frame (physics, graphics, and/or staticData). */
  nextFrame(): { physics?: Buffer; graphics?: Buffer; staticData?: Buffer } | null;

  /** True if connected to ACC shared memory. */
  connected(): boolean;

  /** True if reader is running. */
  running(): boolean;
}

/**
 * Real-time reader from ACC's Windows shared memory.
 * Reads three independent memory regions at their native rates.
 */
export interface IRealtimeAccMemoryReader extends IAccMemoryReader {
  /** Get current debug buffers (for diagnostics). */
  getDebugBuffers(): { physics: Buffer; graphics: Buffer; staticData: Buffer } | null;
  /** Get latest buffered readings (called by TripletAssembler at 100Hz). */
  getLatestBuffers(): { physics: Buffer | null; graphics: Buffer | null; staticData: Buffer | null };
}

/**
 * Replay reader from a recorded dump file.
 * Reconstructs realistic async timing between physics/graphics/static updates.
 */
export interface ITestAccMemoryReader extends IAccMemoryReader {
  /** Get the total number of frames in the dump. */
  frameCount(): number;

  /** Get the current frame number being replayed. */
  currentFrame(): number;

  /** Seek to a specific frame (for testing). */
  seekTo(frameNumber: number): void;
}
