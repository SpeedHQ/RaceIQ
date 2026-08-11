/**
 * Contract for Kunos readers that poll three shared-memory regions at their
 * native rates and expose the latest complete buffers to TripletAssembler.
 */
export interface IRealtimeKunosMemoryReader {
  /** Start the memory reader and attempt connection. */
  start(): void;

  /** Stop the memory reader and clean up resources. */
  stop(): Promise<void>;

  /** Get current debug buffers (for diagnostics). */
  getDebugBuffers(): { physics: Buffer; graphics: Buffer; staticData: Buffer } | null;

  /** Get latest buffered readings (called by TripletAssembler at 100Hz). */
  getLatestBuffers(): { physics: Buffer | null; graphics: Buffer | null; staticData: Buffer | null };
}

