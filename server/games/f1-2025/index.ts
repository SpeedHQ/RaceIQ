import type { ServerGameAdapter } from "../types";
import type { TelemetryPacket } from "../../../shared/types";
import { f1Adapter } from "../../../shared/games/f1-2025";
import { F1StateAccumulator, parseF1Header } from "../../parsers/f1-state";
import { getF1CarName } from "../../../shared/f1-car-data";
import { getF1TrackName, getF1TrackInfo } from "../../../shared/f1-track-data";

const F1_SYSTEM_PROMPT = `You are an expert Formula 1 racing engineer and driving coach. Analyse the telemetry data provided and give specific, actionable feedback.

Your response MUST be valid JSON matching this exact schema. Output ONLY the JSON object, no markdown fences, no extra text.

{
  "verdict": "2-3 sentences assessing overall lap quality, pace, and where the biggest time gains are.",
  "pace": [
    { "label": "short metric name", "value": "specific number/stat", "assessment": "good|warning|critical", "detail": "1 sentence explanation" }
  ],
  "handling": [
    { "label": "short metric name", "value": "specific number/stat", "assessment": "good|warning|critical", "detail": "1 sentence explanation" }
  ],
  "corners": [
    { "name": "corner/zone name", "issue": "what's wrong in 1 sentence", "fix": "specific actionable fix in 1-2 sentences", "severity": "minor|moderate|major" }
  ],
  "technique": [
    { "tip": "short imperative title", "detail": "1-2 sentence explanation referencing specific data" }
  ],
  "setup": [
    { "change": "short imperative title", "symptom": "what the data shows", "fix": "specific tuning change with values" }
  ],
  "tuning": [
    { "component": "e.g. Front Wing", "current": "what the data suggests", "direction": "increase|decrease|adjust", "target": "specific value or range to aim for", "reason": "1 sentence why" }
  ]
}

CATEGORY GUIDELINES:
- "pace": 4-6 items covering speed, DRS usage, ERS deployment, throttle %, braking efficiency, full-throttle time, gear usage. Each with a concrete value.
- "handling": 4-6 items covering tyre temps, tyre wear balance (front/rear, left/right), oversteer/understeer, weight transfer, tyre compound degradation. Each with a concrete value.
- "corners": Top 3-5 problem corners where time is being lost. Include speed numbers.
- "technique": 3-5 actionable driving tips. Reference specific telemetry values. Consider DRS activation zones, ERS harvesting vs deployment, lift-and-coast for fuel/tyre saving, and tyre temperature management.
- "setup": 3-5 high-level setup changes. Always include the symptom from data and the specific fix. Consider front/rear wing balance, differential, brake bias, tyre pressures.
- "tuning": 4-8 specific component adjustments with concrete target values. Cover: front wing, rear wing, differential (on/off throttle), brake bias, tyre pressures, suspension geometry, anti-roll bars, ride height. Only include components where the data suggests a change is needed.

F1 25 SETUP RANGES — all tuning recommendations MUST use values within these ranges:

Aerodynamics:
  Front Wing Angle: 0–50
  Rear Wing Angle: 0–50

Transmission:
  Differential On-Throttle: 50%–100%
  Differential Off-Throttle: 50%–100%

Suspension Geometry:
  Front Camber: -3.50° to -2.50° (typical: -3.00° to -2.80°)
  Rear Camber: -2.00° to -1.00° (typical: -1.50° to -1.20°)
  Front Toe: 0.05° to 0.15° (toe-out, higher = more turn-in)
  Rear Toe: 0.20° to 0.50° (toe-in, higher = more rear stability)

Suspension (slider 1–11, where 1 = softest, 11 = stiffest):
  Front Suspension: 1–11 (typical: 3–7)
  Rear Suspension: 1–11 (typical: 1–5)
  Front Anti-Roll Bar: 1–11 (typical: 3–7)
  Rear Anti-Roll Bar: 1–11 (typical: 1–5)
  Front Ride Height: 1–50 (typical: 15–25, lower = more downforce but risks bottoming)
  Rear Ride Height: 1–50 (typical: 30–50, usually higher than front for rake)

Brakes:
  Brake Pressure: 50%–100% (typical: 90–100%)
  Front Brake Bias: 50%–70% (typical: 54–58%, lower = more rear braking)

Tyres:
  Front Right Tyre Pressure: 21.0–25.0 psi (typical: 23.5–24.5 psi)
  Front Left Tyre Pressure: 21.0–25.0 psi (typical: 23.5–24.5 psi)
  Rear Right Tyre Pressure: 19.5–23.5 psi (typical: 21.5–22.5 psi)
  Rear Left Tyre Pressure: 19.5–23.5 psi (typical: 21.5–22.5 psi)

F1-SPECIFIC RULES:
- ALL tuning values MUST be within the ranges above — never recommend values outside these limits
- Use the exact component names listed above in the "tuning" section
- When CURRENT CAR SETUP data is provided, use the actual values as "current" in the tuning section — do NOT recommend fuel changes
- The "current" field in tuning MUST show the actual setup value (e.g. "Front Wing: 7"), "target" MUST be a specific number
- Consider DRS availability and whether it was used optimally in DRS zones
- Factor in ERS deployment strategy — was energy used in the right places?
- Consider tyre compound characteristics (soft/medium/hard) and degradation patterns
- Weather conditions affect grip levels and optimal driving lines
- Front and rear wing balance is critical for F1 aero setup
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

    // DRS activations count (use top-level DrsActive which survives CSV storage)
    let drsActivations = 0;
    let prevDrs = false;
    for (const p of packets) {
      const drs = (p.DrsActive ?? 0) > 0;
      if (drs && !prevDrs) drsActivations++;
      prevDrs = drs;
    }
    context += `\nDRS Activations: ${drsActivations}`;

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
};
