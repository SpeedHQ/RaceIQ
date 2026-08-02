/**
 * Abstract interface for Kunos shared memory reading.
 *
 * Supports real-time reads from Windows shared memory.
 */

export interface IKunosMemoryReader {
  /** Start the memory reader and attempt connection. */
  start(): void;

  /** Stop the memory reader and clean up resources. */
  stop(): Promise<void>;

  /** Get the next frame (physics, graphics, and/or staticData). */
  nextFrame(): { physics?: Buffer; graphics?: Buffer; staticData?: Buffer } | null;

  /** True if connected to game shared memory. */
  connected(): boolean;

  /** True if reader is running. */
  running(): boolean;
}

/**
 * Real-time reader from Kunos games' Windows shared memory.
 * Reads three independent memory regions at their native rates.
 */
export interface IRealtimeKunosMemoryReader extends IKunosMemoryReader {
  /** Get current debug buffers (for diagnostics). */
  getDebugBuffers(): { physics: Buffer; graphics: Buffer; staticData: Buffer } | null;
  /** Get latest buffered readings (called by TripletAssembler at 100Hz). */
  getLatestBuffers(): { physics: Buffer | null; graphics: Buffer | null; staticData: Buffer | null };
}

