import { lmuAdapter } from "../../../shared/games/lmu";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { renderAnalystSchemaForPrompt } from "../../ai/schemas";
import { LapDetector } from "../../lap-detection/detector";
import type { ServerGameAdapter } from "../types";
import { normalizeLMUSourceFrame } from "./normalizer";
import {
  canHandleLMUSourceFrame,
  decodeLMUSourceFrame,
} from "./source-frame";

const LMU_SYSTEM_PROMPT = `You are an expert Le Mans Ultimate driver coach and endurance race engineer.

Analyze supplied lap telemetry and give specific, data-grounded advice. Account for
multi-class traffic, hybrid deployment, tire state, track limits, and long-stint
consistency when relevant. Your response MUST be valid JSON matching this exact
schema. Output ONLY the JSON object, without markdown fences or extra text.

${renderAnalystSchemaForPrompt()}

Use concrete corner speeds, braking points, throttle application, steering, tire
temperatures, pressures, fuel, energy, and lap-time values when data contains them.
Do not invent setup values or track landmarks absent from input.`;

export const lmuServerAdapter: ServerGameAdapter = {
  ...lmuAdapter,
  runtime: {
    pit: {
      seedFuelFromHistory: true,
      seedTireWearFromHistory: true,
      useDistanceBasedWearCurves: true,
    },
    bestLapFromSession: false,
    requiresTrackCalibration: false,
    normSuspensionTravelMm: { min: 0, max: 100 },
  },
  processNames: ["Le Mans Ultimate.exe", "Le Mans Ultimate"],

  canHandle(buffer: Buffer): boolean {
    return canHandleLMUSourceFrame(buffer);
  },

  tryParse(buffer: Buffer): TelemetryPacket | null {
    const frame = decodeLMUSourceFrame(buffer);
    return frame ? normalizeLMUSourceFrame(frame) : null;
  },

  createParserState(): null {
    return null;
  },

  createLapDetector: (options) => new LapDetector(options),
  aiSystemPrompt: LMU_SYSTEM_PROMPT,

  buildAiContext(packets: TelemetryPacket[]): string {
    const first = packets[0]?.lmu;
    const last = packets[packets.length - 1]?.lmu;
    if (!first || !last) return "";
    return [
      `LMU car: ${first.carModel || first.carName}`,
      `Class: ${first.vehicleClass}`,
      `Track: ${first.trackName} (${first.trackLengthM.toFixed(0)} m)`,
      `Track limits steps at lap end: ${last.trackLimitsSteps}`,
      `Virtual energy at lap end: ${last.virtualEnergy.toFixed(3)}`,
    ].join("\n");
  },
};
