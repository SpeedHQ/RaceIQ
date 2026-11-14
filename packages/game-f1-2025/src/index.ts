import type { ServerGameAdapter } from "@raceiq/backend-core/games/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getF1ErsDeployModeName } from "@raceiq/shared/telemetry/f1-2025";
import { f1Adapter } from "@raceiq/game-f1-2025-metadata/index";
import { getF1CarName } from "@raceiq/game-f1-2025-metadata/racing/cars/f1";
import { getF1TrackName, getF1TrackInfo } from "@raceiq/game-f1-2025-metadata/racing/tracks/catalogs/f1";
import { LapDetector } from "@raceiq/backend-core/lap-detection/detector";
import { renderAnalystSchemaForPrompt } from "@raceiq/backend-core/ai/schemas";

import { f1Parser } from "./game-parser";
import { F1StateAccumulator } from "./f1-state";
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

WIRE FORMAT AND REGULATIONS:
- UDP Format 2026 can carry cars with or without 2026 regulations. Use the separate native regulations flag; missing is unavailable, not false.
- Mode 3 is named Boost in UDP 2026 and Overtake in UDP 2025, independently of the regulations flag.
- The per-lap harvest limit is not battery capacity, stored energy, deployment allowance, or remaining harvest. Keep its native joule meaning.
- Do not grade 2026 battery reserve using a fixed 4 MJ denominator or legacy reserve percentages. Unless capacity is independently verified in context, discuss measured joules and leave percentages unavailable.
- Active aero and overtake are not DRS. Interpret them only when the native 2026 regulations flag is true. Do not infer missed activation or lap-time gains from the last observation; it is not a lap-wide opportunity analysis.
- Missing lap endpoints do not establish a full-lap energy delta. Recorded zero and false are valid observations; absent/non-finite readings are unavailable.

ERS & LAP-TYPE RULES (read \`Session Type\` from context; reserve-percent targets apply only when battery capacity is independently known):
- \`one-shot-qualifying\` / \`time-trial\` / \`qualifying-3\`: this is a single hot lap. ERS deployment must be aggressive — reserve should finish near 0-10% at the line. If \`ers.reserve\` ends the lap above ~15%, flag it as left-on-the-table in \`technique[]\` and in the verdict.
- \`qualifying-1\` / \`qualifying-2\` / \`short-qualifying\`: same single-lap logic — target 0-10% reserve at the line.
- \`race\` / \`race-2\` / \`race-3\`: opposite — ending the lap at 0% is a strategy problem. Grade deployment against race-pace cadence, not max dump.
- \`practice-*\`: neutral. Skip ERS end-of-lap reserve critique.
- When \`Session Type\` is \`unknown\` or missing, assume \`one-shot-qualifying\` (covers the common Analyse-one-good-lap flow).

DRS:
- Mention DRS only when a precomputed "DRS Available but Closed" insight supplies sustained eligibility and activation evidence. Treat it as an observation with the stated source limitations, not guaranteed lost time. Do not infer missed opportunities from raw activation counts or approaching-zone data.

- Factor in ERS deployment strategy — was energy used in the right places?
- Consider tyre compound characteristics (soft/medium/hard) and degradation patterns
- Weather conditions affect grip levels and optimal driving lines
- Reference specific numbers from the data — don't be vague
- Be specific and actionable, not generic
- Address the driver as "you"
- Output ONLY valid JSON, nothing else`;

export const f1ServerAdapter = {
  ...f1Adapter,

  runtime: {
    pit: {
      seedFuelFromHistory: false,
      seedTireWearFromHistory: true,
      useDistanceBasedWearCurves: false,
    },
    bestLapFromSession: true,
    requiresTrackCalibration: true,
    normSuspensionTravelMm: { min: 20, max: 80 },
  },

  processNames: ["F1_25.exe", "F1_2025.exe"],

  getCarName(carId: string) {
    return getF1CarName(Number(carId));
  },

  getTrackName(trackId: string) {
    return getF1TrackName(Number(trackId));
  },

  getSharedTrackName(trackId: string) {
    return getF1TrackInfo(Number(trackId))?.commonTrackName || undefined;
  },

  canHandle: f1Parser.canHandle,
  tryParse(buf, state) {
    return f1Parser.tryParse(buf, state as never);
  },
  tryParseLapIndex(buf, state) {
    return f1Parser.tryParseLapIndex.call(this, buf, state as never);
  },
  primeParserState(buf, state) {
    f1Parser.primeParserState(buf, state as never);
  },
  createParserState: f1Parser.createParserState,
  captureParserCheckpoint(state) {
    if (!(state instanceof F1StateAccumulator)) throw new Error("Missing f1-2025 parser state for checkpoint");
    return state.captureCheckpoint();
  },
  restoreParserCheckpoint(state, payload) {
    if (!(state instanceof F1StateAccumulator)) throw new Error("Missing f1-2025 parser state for checkpoint restore");
    state.restoreCheckpoint(payload);
    return state;
  },

  aiSystemPrompt: F1_SYSTEM_PROMPT,

  buildAiContext(packets: TelemetryPacket[]): string {
    if (packets.length === 0) return "";
    const first = packets[0];
    const last = packets[packets.length - 1];

    let context = "";
    if (first.f1?.sessionType) context += `\nSession Type: ${first.f1.sessionType}`;
    if (first.f1?.packetFormat != null) context += `\nUDP Format: ${first.f1.packetFormat}`;
    if (first.f1?.packetFormat === 2026) {
      const aero = packets.findLast((packet) => packet.f1?.carTelemetry2)?.f1?.carTelemetry2;
      context += `\n2026 Car Regulations: ${aero?.regulations2026 ?? "unavailable"}`;
      if (aero?.regulations2026 === true) {
        const mode = aero.activeAeroMode === 0 ? "corner" : aero.activeAeroMode === 1 ? "straight" : "unknown";
        const distance = (value: number) => (value === 0 ? "unavailable (native 0)" : `${value} m`);
        context += `\nActive Aero at Last Observation: ${mode} (${aero.activeAeroMode}), available=${aero.activeAeroAvailable}, activationDistance=${distance(aero.activeAeroActivationDistance)}`;
        context += `\nOvertake at Last Observation: available=${aero.overtakeAvailable}, active=${aero.overtakeActive}, activationDistance=${distance(aero.overtakeActivationDistance)}`;
      }
    }

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
    if (typeof ersFirst === "number" && Number.isFinite(ersFirst) && typeof ersLast === "number" && Number.isFinite(ersLast)) {
      context += `\nERS Energy: ${(ersFirst / 1000).toFixed(0)} kJ -> ${(ersLast / 1000).toFixed(0)} kJ (delta: ${((ersLast - ersFirst) / 1000).toFixed(0)} kJ)`;
    } else if (typeof ersLast === "number" && Number.isFinite(ersLast)) {
      context += `\nERS Energy at Last Sample: ${(ersLast / 1000).toFixed(0)} kJ (start unavailable; delta unavailable)`;
    }
    const ersDeployed = last.ErsDeployed;
    const ersHarvested = last.ErsHarvested;
    if (typeof ersDeployed === "number" && Number.isFinite(ersDeployed)) {
      context += `\nERS Deployed This Lap: ${(ersDeployed / 1000).toFixed(0)} kJ`;
    }
    if (typeof ersHarvested === "number" && Number.isFinite(ersHarvested)) {
      context += `\nERS Harvested This Lap: ${(ersHarvested / 1000).toFixed(0)} kJ`;
    }
    const harvestLimit = packets.findLast((packet) => packet.f1?.ersHarvestLimitPerLap != null)?.f1?.ersHarvestLimitPerLap;
    if (harvestLimit != null && Number.isFinite(harvestLimit)) context += `\nERS Harvest Limit This Lap: ${(harvestLimit / 1000).toFixed(0)} kJ (not battery capacity)`;
    const deployMode = getF1ErsDeployModeName(last.ErsDeployMode, first.f1?.packetFormat ?? 2025);
    if (deployMode) context += `\nERS Deploy Mode: ${deployMode} (${last.ErsDeployMode})`;

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
} satisfies ServerGameAdapter;
