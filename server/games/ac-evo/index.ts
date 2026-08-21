import { resolve } from "node:path";
import type { ServerGameAdapter } from "../types";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { acEvoAdapter } from "../../../shared/games/ac-evo";
import { getAcEvoCarName } from "../../../shared/racing/cars/ac-evo"
import { getAcEvoTrackName, getAcEvoSharedTrackName, getAcEvoTrackByName, getAcEvoTrackBySetupFolder } from "../../../shared/racing/tracks/catalogs/ac-evo"
import { LAP_DETECTOR_AC_EVO_ID, LapDetectorAcEvo } from "./lap-detector"
import { parseAcEvoBuffers, createAcEvoParserCache, type AcEvoParserCache } from "./parser";
import { ACEVO_PACKED_MAGIC, unpackTriplet } from "../kunos/pack-triplet";
import { renderAnalystSchemaForPrompt } from "../../ai/schemas";
import { buildKunosAiContext } from "../kunos/ai-context";
import { resolveKunosReplayTimestamp } from "../kunos/replay-clock";
import {
  baseRaceEventObservation,
  kunosDamagePercent,
  localPlayerObservation,
  normalizedFuelLitres,
  normalizedTireWear,
} from "../race-event-observation";

const AC_EVO_SYSTEM_PROMPT = `You are an expert motorsport engineer and data analyst specializing in Assetto Corsa Evo.

You are analyzing telemetry data from a lap in AC Evo. Your role is to provide specific, actionable advice to improve lap time.

Your response MUST be valid JSON matching this exact schema. Output ONLY the JSON object, no markdown fences, no extra text.

${renderAnalystSchemaForPrompt()}

CATEGORY GUIDELINES:
- "pace": 4-6 items covering speed, throttle %, braking efficiency, full-throttle time, gear usage. Each with a concrete value.
- "handling": 4-6 items covering tyre core temps (inner/outer/core), tyre wear balance, oversteer/understeer, weight transfer. Each with a concrete value.
- "corners": Top 3-5 problem corners where time is being lost. Include speed numbers.
- "technique": 3-5 actionable driving tips. Adapt tone to car class (road car vs GT3). Reference compound and temperature.
- "setup": 6-12 specific component adjustments with concrete \`current\` and \`target\` values (integers for slider fields, psi with one decimal for tyre pressures). Each entry MUST include \`symptom\` (data-cited), \`fix\`, and \`direction\`. Aim for coverage across categories where data supports a change: (a) Tyre pressures (all four), (b) Electronics (TC, ABS, Engine Map), (c) Brake bias, (d) Anti-roll bars, (e) Bump/Rebound, (f) Ride height, (g) Differential preload. Skip only categories that are genuinely on-target.

THERMAL REFERENCE (AC Evo, compound-dependent):
- Slick tyres: optimal core 75-100°C, warning 60-74°C or 101-115°C, critical <60°C or >115°C.
- Semi-slicks: optimal core 60-85°C, warning 45-59°C or 86-100°C, critical <45°C or >100°C.
- Road tyres: optimal core 40-70°C, warning 25-39°C or 71-85°C, critical <25°C or >85°C.
- Brake disc temp: optimal 350-700°C for race cars, 200-500°C for road cars; warning 150°C either side; critical <100°C or >900°C.
- Tyre wear (per-tyre %): good 0-20%, warning 20-45%, critical >45%.
When you cite a temp, pair it with the tyre compound (the prompt context lists it) so grading is unambiguous.

AC EVO-SPECIFIC RULES:
- Tyre type matters: road tyres, semi-slicks, and slicks have different optimal pressures and temperature windows — cite the type before recommending a pressure.
- TC/ABS are integer sliders — recommend integer step changes (e.g. "TC: 5 → 3").
- When analyzing road cars, prioritise smoothness and weight transfer; when analyzing GT3/race cars, prioritise trail braking and aggressive rotation.
- Reference specific numbers from the data — don't be vague.
- Address the driver as "you".
- Output ONLY valid JSON, nothing else.`;

export const acEvoServerAdapter: ServerGameAdapter = {
  ...acEvoAdapter,

  runtime: {
    pit: {
      seedFuelFromHistory: true,
      seedTireWearFromHistory: true,
      useDistanceBasedWearCurves: false,
    },
    bestLapFromSession: false,
    requiresTrackCalibration: false,
    normSuspensionTravelMm: { min: 20, max: 80 },
  },

  processNames: ["AssettoCorsaEVO.exe"],

  getSetupsDirCandidates(home: string): string[] {
    // AC EVO saves setups to Saved Games\ACE\Car Setups as binary
    // .carsetup (protobuf) files — not under Documents like ACC.
    return [resolve(home, "Saved Games", "ACE", "Car Setups")];
  },

  getCarName(ordinal: number): string {
    return getAcEvoCarName(ordinal);
  },

  getTrackName(ordinal: number): string {
    return getAcEvoTrackName(ordinal);
  },

  getSharedTrackName(ordinal: number): string | undefined {
    return getAcEvoSharedTrackName(ordinal);
  },

  getTrackOrdinalByName(name: string): number | undefined {
    return getAcEvoTrackBySetupFolder(name)?.id ?? getAcEvoTrackByName(name)?.id;
  },

  canHandle(buf: Buffer): boolean {
    return buf.length > 4 && buf.readUInt32LE(0) === ACEVO_PACKED_MAGIC;
  },

  tryParse(buf: Buffer, state: unknown): TelemetryPacket | null {
    const triplet = unpackTriplet(buf);
    if (!triplet) return null;
    if (triplet.physics.length < 4) return null;
    const cache = (state as AcEvoParserCache | null) ?? createAcEvoParserCache();
    const timestampMS = resolveKunosReplayTimestamp(cache.replayClock, triplet.physics.readInt32LE(0), triplet.timestampMS);
    return parseAcEvoBuffers(triplet.physics, triplet.graphics, triplet.staticData, cache, timestampMS);
  },

  createParserState(): AcEvoParserCache {
    return createAcEvoParserCache();
  },

  toRaceEventObservation(packet, context) {
    const observation = baseRaceEventObservation(packet, context);
    const flag = packet.acc?.flagStatus?.toLowerCase() ?? "unknown";
    observation.nativeRaceControlCode = flag;
    if (flag === "green") observation.sessionPhase = "green";
    else if (flag === "yellow") {
      observation.sessionPhase = "caution";
      observation.cautionKind = "local-yellow";
    } else if (flag === "red") observation.sessionPhase = "red";
    else if (flag === "checkered") observation.sessionPhase = "checkered";

    const nativePitCode = packet.acc?.pitStatus ?? null;
    const pitState =
      nativePitCode === "out"
        ? "out"
        : nativePitCode === "pit_lane"
          ? "pit-lane"
          : nativePitCode === "in_pit"
            ? "pit-stall"
            : "unknown";
    observation.participants = [
      localPlayerObservation(packet, {
        pitState,
        nativePitCode,
        fuelLitres: normalizedFuelLitres(
          packet,
          acEvoAdapter.telemetry.fuel.packetUnit,
        ),
        tireCompound:
          packet.acc?.tireCompound && packet.acc.tireCompound !== "unknown"
            ? packet.acc.tireCompound
            : null,
        tireWear: normalizedTireWear(packet),
        damage: kunosDamagePercent(packet),
        penaltyValue: null,
        incidentCount: null,
      }),
    ];
    return observation;
  },

  lapDetectorId: LAP_DETECTOR_AC_EVO_ID,

  createLapDetector: (opts) => new LapDetectorAcEvo(opts),

  aiSystemPrompt: AC_EVO_SYSTEM_PROMPT,

  buildAiContext(packets: TelemetryPacket[]): string {
    return buildKunosAiContext(packets, false);
  },
};
