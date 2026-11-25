import type { ServerGameAdapter } from "@raceiq/backend-core/games/types";
import { LapDetector } from "@raceiq/backend-core/lap-detection/detector";
import { renderAnalystSchemaForPrompt } from "@raceiq/backend-core/ai/schemas";
import { gt7Adapter } from "@raceiq/game-gt7-metadata/index";
import { gt7Parser } from "./parser";

export const gt7ServerAdapter: ServerGameAdapter = {
  parserStateIsFrameLocal: false,
  ...gt7Adapter,
  runtime: {
    pit: { seedFuelFromHistory: true, seedTireWearFromHistory: false, useDistanceBasedWearCurves: false },
    bestLapFromSession: false,
    requiresTrackCalibration: false,
    normSuspensionTravelMm: { min: 0, max: 100 },
  },
  canHandle: gt7Parser.canHandle,
  tryParse: gt7Parser.tryParse,
  tryParseLapIndex: gt7Parser.tryParseLapIndex,
  primeParserState: gt7Parser.primeParserState,
  createParserState: gt7Parser.createParserState,
  captureParserCheckpoint: gt7Parser.captureParserCheckpoint,
  restoreParserCheckpoint: gt7Parser.restoreParserCheckpoint,
  createLapDetector: options => new LapDetector({ ...options, bypassPacketRateFilter: true }),
  aiSystemPrompt: `You are a Gran Turismo 7 driving coach. Analyze only supplied telemetry and never invent track, event, setup, or opponent data. Return JSON matching: ${renderAnalystSchemaForPrompt()}`,
};
