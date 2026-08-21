import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { generateLapSvg, generateRawSvg } from "./svg";

const OUTPUT_DIR = "test/e2e/output";
export const RECORDING_VISUALIZATIONS_ENV = "RACEIQ_GENERATE_RECORDING_VISUALIZATIONS";

/** Minimal lap shape needed for visualization output. */
export interface VisualizableLap {
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  invalidReason: string | null;
  packets: TelemetryPacket[];
}

/**
 * Generate raw + per-lap SVG and GIF visualizations for a recording when
 * `RACEIQ_GENERATE_RECORDING_VISUALIZATIONS=1` is set.
 *
 * Output goes to `test/e2e/output/<recording-basename>/`. Lap GIFs/SVGs include
 * lapTime and valid-status labels. The opt-in keeps routine replay tests free of
 * visualization filesystem work while retaining manual diagnostics.
 * `rawPacketStride` down-samples only the raw overview after opt-in is confirmed.
 */
export function generateRecordingVisualizations(
  recordingFile: string,
  laps: VisualizableLap[],
  rawPackets: TelemetryPacket[],
  rawPacketStride = 1,
): void {
  if (process.env[RECORDING_VISUALIZATIONS_ENV] !== "1") {
    console.log(
      `[Visualizations] Skipped for ${recordingFile}; set ${RECORDING_VISUALIZATIONS_ENV}=1 to generate diagnostics`
    );
    return;
  }
  if (!Number.isSafeInteger(rawPacketStride) || rawPacketStride < 1) {
    throw new RangeError("rawPacketStride must be a positive integer");
  }
  const visualizedRawPackets =
    rawPacketStride === 1
      ? rawPackets
      : rawPackets.filter((_, index) => index % rawPacketStride === 0);

  const outputDir = join(OUTPUT_DIR, recordingFile.replace(/\.bin(\.gz)?$/, ""));
  // Wipe stale artifacts — prior runs may have produced more/different laps
  // (e.g. lap-5.svg from an older detector) that would linger otherwise.
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  generateRawSvg(visualizedRawPackets, outputDir);

  for (const lap of laps) {
    const meta = {
      lapTime: lap.lapTime,
      isValid: lap.isValid,
      invalidReason: lap.invalidReason,
    };
    generateLapSvg(lap.packets, lap.lapNumber, outputDir, undefined, meta);
  }

  console.log(`[Visualizations] Generated for ${laps.length} laps`);
}
