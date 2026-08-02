import type { ServerGameAdapter } from "../types";
import type { TelemetryPacket } from "../../../shared/types";
import { f1Adapter } from "../../../shared/games/f1-2025";
import { F1StateAccumulator } from "../../parsers/f1-state";
import { parseF1Header } from "../../parsers/f1-wire";
import { getF1CarName } from "../../../shared/f1-car-data";
import { getF1TrackName, getF1TrackInfo } from "../../../shared/f1-track-data";
import { LapDetector } from "../../lap-detector";
import { renderAnalystSchemaForPrompt } from "../../ai/schemas";

const F1_SYSTEM_PROMPT = `You are an expert Formula 1 racing engineer and driving coach. Analyse the telemetry data provided and give specific, actionable feedback.

Your response MUST be valid JSON matching this exact schema. Output ONLY the JSON object, no markdown fences, no extra text.

${renderAnalystSchemaForPrompt()}

CATEGORY GUIDELINES:
- "pace": 4-6 items covering speed, ERS deployment, throttle %, braking efficiency, full-throttle time, gear usage. Each with a concrete value.
- "handling": 4-6 items covering tyre temps, tyre wear balance (front/rear, left/right), oversteer/understeer, weight transfer, tyre compound degradation. Each with a concrete value.
- "corners": Top 3-5 problem corners where time is being lost. Include speed numbers.
- "technique": 3-5 actionable driving tips. Consider ERS harvesting vs deployment, lift-and-coast for fuel/tyre saving, and tyre temperature management.

THERMAL REFERENCE (F1 25, slick tyres, dry):
- Tyre surface temp: optimal 90-110°C, warning 80-89°C or 111-125°C, critical <80°C or >125°C.
- Tyre inner-carcass temp: optimal 95-115°C, warning 85-94°C or 116-125°C, critical <85°C or >125°C.
- Brake disc temp: optimal 450-700°C, warning 350-449°C or 701-850°C, critical <350°C or >850°C (carbon brakes cold-crack below 200°C and fade above 900°C).
- Tyre health / wear remaining: good 100-85%, warning 84-60%, critical <60% (scale grip loss and lap-time cost in your verdict).
When citing temps in \`pace\`, \`handling\`, or \`corners\`, use these bands to grade \`assessment\`.

ERS & LAP-TYPE RULES (read \`Session Type\` from the prompt context):
- \`one-shot-qualifying\` / \`time-trial\` / \`qualifying-3\`: this is a single hot lap. ERS deployment must be aggressive — reserve should finish near 0-10% at the line. If \`ers.reserve\` ends the lap above ~15%, flag it as left-on-the-table in \`technique[]\` and in the verdict.
- \`qualifying-1\` / \`qualifying-2\` / \`short-qualifying\`: same single-lap logic — target 0-10% reserve at the line.
- \`race\` / \`race-2\` / \`race-3\`: opposite — ending the lap at 0% is a strategy problem. Grade deployment against race-pace cadence, not max dump.
- \`practice-*\`: neutral. Skip ERS end-of-lap reserve critique.
- When \`Session Type\` is \`unknown\` or missing, assume \`one-shot-qualifying\` (covers the common Analyse-one-good-lap flow).

DRS:
- Do not mention DRS anywhere in the output (pace, handling, corners, technique, verdict). Zone data is unreliable and raw activation counts are not actionable feedback.

- Factor in ERS deployment strategy — was energy used in the right places?
- Consider tyre compound characteristics (soft/medium/hard) and degradation patterns
- Weather conditions affect grip levels and optimal driving lines
- Reference specific numbers from the data — don't be vague
- Be specific and actionable, not generic
- Address the driver as "you"
- Output ONLY valid JSON, nothing else`;

export const f1ServerAdapter: ServerGameAdapter = {
  ...f1Adapter,

  processNames: ["F1_25.exe", "F1_2025.exe"],

  getCarName(ordinal) {
    return getF1CarName(ordinal);
  },

  getTrackName(ordinal) {
    return getF1TrackName(ordinal);
  },

  getSharedTrackName(ordinal) {
    return getF1TrackInfo(ordinal)?.commonTrackName || undefined;
  },

  canHandle(buf) {
    return buf.length >= 29 && buf.readUInt16LE(0) === 2025;
  },

  tryParse(buf, state) {
    const accumulator = state as F1StateAccumulator;
    const header = parseF1Header(buf);
    return accumulator.feed(header, buf);
  },

  createParserState() {
    return new F1StateAccumulator();
  },

  aiSystemPrompt: F1_SYSTEM_PROMPT,

  buildAiContext(packets: TelemetryPacket[]): string {
    if (packets.length === 0) return "";
    const first = packets[0];
    const last = packets[packets.length - 1];

    let context = "";

    // Tyre compound (top-level TyreCompound survives CSV; f1.tyreCompound is first-packet only)
    const compoundNum = first.TyreCompound ?? first.f1?.tyreVisualCompound;
    const compoundNames: Record<number, string> = { 16: "soft", 17: "medium", 18: "hard", 7: "inter", 8: "wet" };
    const compound = compoundNum != null ? (compoundNames[compoundNum] ?? `compound-${compoundNum}`) : (first.f1?.tyreCompound ?? "unknown");
    context += `\nTyre Compound: ${compound}`;

    // Weather (top-level WeatherType survives CSV)
    const weatherNames: Record<number, string> = { 0: "clear", 1: "light cloud", 2: "overcast", 3: "light rain", 4: "heavy rain", 5: "storm" };
    const weather = first.WeatherType != null ? (weatherNames[first.WeatherType] ?? "unknown") : (first.f1?.weather ?? "unknown");
    context += `\nWeather: ${weather}`;
    if (first.TrackTemp) context += `\nTrack Temp: ${first.TrackTemp}°C`;
    if (first.AirTemp) context += `\nAir Temp: ${first.AirTemp}°C`;

// ERS deployment summary (use top-level fields which survive CSV storage)
    const ersFirst = first.ErsStoreEnergy;
    const ersLast = last.ErsStoreEnergy;
    if (typeof ersFirst === "number" && typeof ersLast === "number" && (ersFirst > 0 || ersLast > 0)) {
      context += `\nERS Energy: ${(ersFirst / 1000).toFixed(0)} kJ -> ${(ersLast / 1000).toFixed(0)} kJ (delta: ${((ersLast - ersFirst) / 1000).toFixed(0)} kJ)`;
    }
    const ersDeployed = last.ErsDeployed;
    const ersHarvested = last.ErsHarvested;
    if (typeof ersDeployed === "number" && ersDeployed > 0) {
      context += `\nERS Deployed This Lap: ${(ersDeployed / 1000).toFixed(0)} kJ`;
    }
    if (typeof ersHarvested === "number" && ersHarvested > 0) {
      context += `\nERS Harvested This Lap: ${(ersHarvested / 1000).toFixed(0)} kJ`;
    }

    // Car setup (from in-game settings)
    const setup = first.f1?.setup;
    if (setup) {
      context += `\n\n--- CURRENT CAR SETUP ---`;
      context += `\nFront Wing: ${setup.frontWing}`;
      context += `\nRear Wing: ${setup.rearWing}`;
      context += `\nDifferential On-Throttle: ${setup.onThrottle}%`;
      context += `\nDifferential Off-Throttle: ${setup.offThrottle}%`;
      context += `\nFront Camber: ${setup.frontCamber.toFixed(2)}°`;
      context += `\nRear Camber: ${setup.rearCamber.toFixed(2)}°`;
      context += `\nFront Toe: ${setup.frontToe.toFixed(2)}°`;
      context += `\nRear Toe: ${setup.rearToe.toFixed(2)}°`;
      context += `\nFront Suspension: ${setup.frontSuspension}`;
      context += `\nRear Suspension: ${setup.rearSuspension}`;
      context += `\nFront Anti-Roll Bar: ${setup.frontAntiRollBar}`;
      context += `\nRear Anti-Roll Bar: ${setup.rearAntiRollBar}`;
      context += `\nFront Ride Height: ${setup.frontRideHeight}`;
      context += `\nRear Ride Height: ${setup.rearRideHeight}`;
      context += `\nBrake Pressure: ${setup.brakePressure}%`;
      context += `\nBrake Bias: ${setup.brakeBias}%`;
      context += `\nEngine Braking: ${setup.engineBraking}%`;
      context += `\nFront Left Tyre Pressure: ${setup.frontLeftTyrePressure.toFixed(1)} psi`;
      context += `\nFront Right Tyre Pressure: ${setup.frontRightTyrePressure.toFixed(1)} psi`;
      context += `\nRear Left Tyre Pressure: ${setup.rearLeftTyrePressure.toFixed(1)} psi`;
      context += `\nRear Right Tyre Pressure: ${setup.rearRightTyrePressure.toFixed(1)} psi`;
      context += `\nFuel Load: ${setup.fuelLoad.toFixed(1)} kg`;
    }

    return context;
  },

  createLapDetector: (opts) => new LapDetector(opts),
};
