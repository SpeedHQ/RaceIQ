import { iracingAdapter } from "../../../shared/games/iracing";
import { getIRacingSharedTrackName,
getIRacingTrackName,
getIRacingTrackOrdinalByName, } from "../../../shared/racing/tracks/catalogs/iracing"
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { renderAnalystSchemaForPrompt } from "../../ai/schemas";
import { LAP_DETECTOR_IRACING_ID, LapDetectorIRacing } from "./lap-detector";
import type { ServerGameAdapter } from "../types";
import {
  createIRacingParserState,
  type IRacingParserState,
  normalizeIRacingFrame,
} from "./normalizer";
import {
  canHandleIRacingSourceFrame,
  decodeIRacingSourceFrame,
} from "./source-frame";
import {
  baseRaceEventObservation,
  localPlayerObservation,
  normalizedFuelLitres,
  normalizedTireWear,
} from "../race-event-observation";

const IRACING_SYSTEM_PROMPT = `You are an expert iRacing driver coach and race engineer.

Analyze the supplied lap telemetry and give specific, data-grounded advice.
Your response MUST be valid JSON matching this exact schema. Output ONLY the
JSON object, without markdown fences or extra text.

${renderAnalystSchemaForPrompt()}

Use concrete corner speeds, braking points, throttle application, steering,
tire temperatures, fuel, and lap-time values when the data contains them.
Do not invent setup values or track landmarks that are absent from the input.`;

export const iracingServerAdapter: ServerGameAdapter = {
  ...iracingAdapter,

  runtime: {
    pit: {
      seedFuelFromHistory: true,
      seedTireWearFromHistory: true,
      useDistanceBasedWearCurves: false,
    },
    bestLapFromSession: false,
    requiresTrackCalibration: false,
    normSuspensionTravelMm: { min: 0, max: 100 },
  },
  processNames: [
    "iRacingSim64DX11.exe",
    "iRacingSim64DX11",
    "iRacingSim.exe",
  ],

  getTrackName(ordinal: number): string {
    return getIRacingTrackName(ordinal);
  },

  getSharedTrackName(ordinal: number): string | undefined {
    return getIRacingSharedTrackName(ordinal);
  },

  getTrackOrdinalByName(name: string): number | undefined {
    return getIRacingTrackOrdinalByName(name);
  },

  canHandle(buf: Buffer): boolean {
    return canHandleIRacingSourceFrame(buf);
  },

  tryParse(buf: Buffer, state: unknown): TelemetryPacket | null {
    const parserState = state as IRacingParserState | null;
    const frame = decodeIRacingSourceFrame(buf, parserState?.source);
    return frame
      ? normalizeIRacingFrame(frame, parserState)
      : null;
  },

  createParserState(): IRacingParserState {
    return createIRacingParserState();
  },

  toRaceEventObservation(packet, context) {
    const observation = baseRaceEventObservation(packet, context);
    observation.trackDistanceM =
      packet.iracing &&
      Number.isFinite(packet.iracing.lapDistanceM) &&
      packet.iracing.lapDistanceM >= 0
        ? packet.iracing.lapDistanceM
        : null;
    observation.trackDistancePct =
      packet.iracing &&
      Number.isFinite(packet.iracing.lapDistancePct) &&
      packet.iracing.lapDistancePct >= 0 &&
      packet.iracing.lapDistancePct <= 1
        ? packet.iracing.lapDistancePct
        : null;
    // The live SDK does not provide stable world-space racing-line position.
    observation.worldPosition = null;
    const onPitRoad = packet.iracing?.onPitRoad;
    observation.participants = [
      localPlayerObservation(packet, {
        pitState:
          typeof onPitRoad === "boolean"
            ? onPitRoad
              ? "pit-lane"
              : "out"
            : "unknown",
        nativePitCode:
          typeof onPitRoad === "boolean" ? (onPitRoad ? 1 : 0) : null,
        fuelLitres: normalizedFuelLitres(
          packet,
          iracingAdapter.telemetry.fuel.packetUnit,
        ),
        tireCompound: null,
        tireWear:
          packet.iracing?.pitTireWearAvailable === true
            ? normalizedTireWear(packet)
            : null,
        damage: null,
        penaltyValue: null,
        incidentCount:
          packet.iracing &&
          Number.isInteger(packet.iracing.incidents) &&
          packet.iracing.incidents >= 0
            ? packet.iracing.incidents
            : null,
      }),
    ];
    return observation;
  },

  lapDetectorId: LAP_DETECTOR_IRACING_ID,

  createLapDetector: (opts) => new LapDetectorIRacing(opts),
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
