import { iracingAdapter } from "../../../shared/games/iracing";
import type { TelemetryPacket } from "../../../shared/types";
import { renderAnalystSchemaForPrompt } from "../../ai/schemas";
import { LapDetector } from "../../lap-detector";
import type { ServerGameAdapter } from "../types";
import { normalizeIRacingFrame } from "./normalizer";
import {
  canHandleIRacingSourceFrame,
  decodeIRacingSourceFrame,
} from "./source-frame";

const IRACING_SYSTEM_PROMPT = `You are an expert iRacing driver coach and race engineer.

Analyze the supplied lap telemetry and give specific, data-grounded advice.
Your response MUST be valid JSON matching this exact schema. Output ONLY the
JSON object, without markdown fences or extra text.

${renderAnalystSchemaForPrompt({ tuningExampleComponent: "Brake bias" })}

Use concrete corner speeds, braking points, throttle application, steering,
tire temperatures, fuel, and lap-time values when the data contains them.
Do not invent setup values or track landmarks that are absent from the input.`;

export const iracingServerAdapter: ServerGameAdapter = {
  ...iracingAdapter,
  processNames: [
    "iRacingSim64DX11.exe",
    "iRacingSim64DX11",
    "iRacingSim.exe",
  ],

  canHandle(buf: Buffer): boolean {
    return canHandleIRacingSourceFrame(buf);
  },

  tryParse(buf: Buffer, _state: unknown): TelemetryPacket | null {
    const frame = decodeIRacingSourceFrame(buf);
    return frame ? normalizeIRacingFrame(frame) : null;
  },

  createParserState(): null {
    return null;
  },

  createLapDetector: (opts) => new LapDetector(opts),
  aiSystemPrompt: IRACING_SYSTEM_PROMPT,

  buildAiContext(packets: TelemetryPacket[]): string {
    const first = packets[0]?.iracing;
    const last = packets[packets.length - 1]?.iracing;
    if (!first || !last) return "";
    return [
      `iRacing car: ${first.carName} (${first.carClassName})`,
      `Track: ${first.trackName} (${first.trackLengthM.toFixed(0)} m)`,
      `Incidents at lap end: ${last.incidents}`,
      `Pit road at lap end: ${last.onPitRoad ? "yes" : "no"}`,
    ].join("\n");
  },
};
