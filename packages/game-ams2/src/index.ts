import { ams2Adapter } from "@raceiq/game-ams2-metadata/index";
import { LapDetector } from "@raceiq/backend-core/lap-detection/detector";
import type { ServerGameAdapter } from "@raceiq/backend-core/games/types";
import { renderAnalystSchemaForPrompt } from "@raceiq/backend-core/ai/schemas";
import { isAMS2SessionEndFrame } from "./frame";
import { ams2Parser } from "./game-parser";
import { AMS2_LAP_DETECTOR_POLICY } from "./lap-policy";
export const ams2ServerAdapter: ServerGameAdapter = {
  parserStateIsFrameLocal: true,
  ...ams2Adapter,
  runtime: {pit: {seedFuelFromHistory: true, seedTireWearFromHistory: true, useDistanceBasedWearCurves: true}, bestLapFromSession: false, requiresTrackCalibration: false, normSuspensionTravelMm: {min: 0, max: 100}},
  processNames: ["AMS2AVX.exe", "AMS2.exe"],
  ...ams2Parser,
  isSessionEndFrame: isAMS2SessionEndFrame,
  createLapDetector: options => new LapDetector({...options, bypassPacketRateFilter: true, policy: AMS2_LAP_DETECTOR_POLICY}),
  aiSystemPrompt: `You are an Automobilista 2 driving coach. Use only the supplied telemetry. Never infer unavailable slip or setup data. Return JSON matching: ${renderAnalystSchemaForPrompt()}`,
};
