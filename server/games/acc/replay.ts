import { readAccFrames } from "./frame-reader";
import { STATIC } from "./structs";
import { parseAccBuffers } from "./parser";
import { readWString } from "./utils";
import { processPacket } from "../../pipeline";
import { getAccCarByModel } from "../../../shared/acc-car-data";
import { getAccTrackByName } from "../../../shared/acc-track-data";

/**
 * Replay a recorded ACC telemetry file.
 *
 * Reads V2 frames and feeds them through the parser → pipeline.
 * Uses packet TimestampMS for real-time pacing.
 *
 * @param filePath Path to the .bin or .bin.gz recording file
 * @param options.speed Playback speed multiplier (default 1.0 = real-time)
 * @param options.loop Whether to loop the recording (default false)
 * @returns A stop function to cancel playback
 */
export async function replayRecording(
  filePath: string,
  options: { speed?: number; loop?: boolean } = {}
): Promise<{ stop: () => void; frameCount: number }> {
  const speed = options.speed ?? 1.0;
  const loop = options.loop ?? false;

  const frames = readAccFrames(filePath);
  if (frames.length === 0) throw new Error(`Recording file has no frames: ${filePath}`);

  // Resolve car/track ordinals from first frame's static data
  const firstStatic = frames[0].staticData;
  const carModel = readWString(firstStatic, STATIC.carModel.offset, STATIC.carModel.size);
  const trackName = readWString(firstStatic, STATIC.track.offset, STATIC.track.size);
  const carOrdinal = getAccCarByModel(carModel)?.id ?? 0;
  const trackOrdinal = getAccTrackByName(trackName)?.id ?? 0;
  const overrides = { carOrdinal, trackOrdinal };
  console.log(`[ACC Replay] Playing ${filePath} — ${frames.length} frames at ${speed}x (car: ${carModel} → #${carOrdinal}, track: ${trackName} → #${trackOrdinal})`);

  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  async function playFrames(): Promise<void> {
    do {
      let firstTimestamp: number | null = null;
      let playbackStart = Date.now();

      for (const frame of frames) {
        if (cancelled) return;

        const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, overrides);
        if (!packet) continue;

        if (firstTimestamp === null) {
          firstTimestamp = packet.TimestampMS;
          playbackStart = Date.now();
        }

        const recordedElapsed = packet.TimestampMS - firstTimestamp;
        const targetElapsed = recordedElapsed / speed;
        const actualElapsed = Date.now() - playbackStart;
        const delay = targetElapsed - actualElapsed;

        if (delay > 1) {
          await new Promise<void>((resolve) => {
            timeoutId = setTimeout(resolve, delay);
          });
          if (cancelled) return;
        }

        await processPacket(packet);
      }
    } while (loop && !cancelled);

    console.log("[ACC Replay] Playback complete");
  }

  playFrames();

  return {
    stop: () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      console.log("[ACC Replay] Stopped");
    },
    frameCount: frames.length,
  };
}
