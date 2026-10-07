import { ams2Adapter } from "@raceiq/game-ams2-metadata/index";
import { LapDetector } from "@raceiq/backend-core/lap-detection/detector";
import type { ServerGameAdapter } from "@raceiq/backend-core/games/types";
import { renderAnalystSchemaForPrompt } from "@raceiq/backend-core/ai/schemas";
import { classifyPitCycleLap } from "@raceiq/analysis-core/racing/laps/pit-cycle";
import { normalizeAMS2Frame } from "./normalizer";
import { decodeAMS2Frame } from "./frame";
export const ams2ServerAdapter: ServerGameAdapter = {
  ...ams2Adapter,
  runtime: {pit: {seedFuelFromHistory: true, seedTireWearFromHistory: true, useDistanceBasedWearCurves: true}, bestLapFromSession: false, requiresTrackCalibration: false, normSuspensionTravelMm: {min: 0, max: 100}},
  processNames: ["AMS2AVX.exe", "AMS2.exe"],
  canHandle: buffer => decodeAMS2Frame(buffer) !== null,
  tryParse: buffer => normalizeAMS2Frame(buffer),
  tryParseLapIndex: buffer => normalizeAMS2Frame(buffer),
  primeParserState: () => {}, createParserState: () => null,
  createLapDetector: options => new LapDetector({...options, bypassPacketRateFilter: true, policy: {
    resolveLapTime: (_packets, next) => next.LastLap > 0 ? next.LastLap : 0,
    classifyPitCycle: (packets, count) => classifyPitCycleLap(packets) ?? (count === 0 ? "outlap" : null),
    invalidReason: packets => packets.some(p => p.ams2?.lapInvalidated) ? "game-invalidated" : null,
  }}),
  aiSystemPrompt: `You are an Automobilista 2 driving coach. Use only the supplied telemetry. Never infer unavailable slip or setup data. Return JSON matching: ${renderAnalystSchemaForPrompt()}`,
};
