import type { TelemetryPacket } from "../../shared/types";
import { mkdirSync } from "fs";
import { join } from "path";
import { generateLapSvg, generateRawSvg } from "./lap-svg";

const OUTPUT_DIR = "test/e2e/output";

/** Minimal lap shape needed for visualization output. */
export interface VisualizableLap {
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  invalidReason: string | null;
  packets: TelemetryPacket[];
}

/**
 * Generate raw + per-lap SVG and GIF visualizations for a recording, in one call.
 *
 * Output goes to `test/e2e/output/<recording-basename>/`. Directory is created
 * if missing. Lap GIFs/SVGs include lapTime and valid-status labels.
 */
export function generateRecordingVisualizations(
  recordingFile: string,
  laps: VisualizableLap[],
  rawPackets: TelemetryPacket[]
): void {
  const outputDir = join(OUTPUT_DIR, recordingFile.replace(/\.bin(\.gz)?$/, ""));
  mkdirSync(outputDir, { recursive: true });

  generateRawSvg(rawPackets, outputDir);

  for (const lap of laps) {
    const meta = {
      lapTime: lap.lapTime,
      isValid: lap.isValid,
      invalidReason: lap.invalidReason,
    };
    generateLapSvg(lap.packets, lap.lapNumber, outputDir, undefined, meta);
  }
}
