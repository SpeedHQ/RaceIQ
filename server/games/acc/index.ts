import type { ServerGameAdapter } from "../types";
import type { TelemetryPacket } from "../../../shared/types";
import { accAdapter } from "../../../shared/games/acc";
import { getAccCarName } from "../../../shared/acc-car-data";
import { getAccTrackName, getAccSharedTrackName } from "../../../shared/acc-track-data";
import { LapDetectorAcc } from "../../lap-detector-acc";
import { parseAccBuffers } from "./parser";
import { ACC_PACKED_MAGIC, unpackTriplet } from "../shared/pack-triplet";
import { renderAnalystSchemaForPrompt } from "../../ai/schemas";

const ACC_SYSTEM_PROMPT = `You are an expert GT racing engineer and data analyst specializing in Assetto Corsa Competizione.

You are analyzing telemetry data from a lap in ACC. Your role is to provide specific, actionable advice to improve lap time.

Your response MUST be valid JSON matching this exact schema. Output ONLY the JSON object, no markdown fences, no extra text.

${renderAnalystSchemaForPrompt({ tuningExampleComponent: "Front Tyre Pressure" })}

CATEGORY GUIDELINES:
- "pace": 4-6 items covering speed, throttle %, braking efficiency, full-throttle time, gear usage. Each with a concrete value.
- "handling": 4-6 items covering tyre core temps (inner/outer/core), tyre wear balance, oversteer/understeer, weight transfer. Each with a concrete value.
- "corners": Top 3-5 problem corners where time is being lost. Include speed numbers.
- "technique": 3-5 actionable driving tips. Consider tyre compound windows, TC/TC Cut/ABS tuning for conditions, trail-braking on entry, throttle modulation on exit, and weather/grip adaptation.
- "setup": 6-12 specific component adjustments with concrete \`current\` and \`target\` values (integers for slider fields, psi with one decimal for tyre pressures). Each entry MUST include \`symptom\` (data-cited), \`fix\`, and \`direction\`. Aim for coverage across categories where data supports a change: (a) Tyre pressures (all four), (b) Electronics (TC, TC Cut, ABS, Engine Map), (c) Brake bias + brake pressure, (d) Anti-roll bars, (e) Bump/Rebound, (f) Ride height, (g) Differential preload. Skip only categories that are genuinely on-target.

THERMAL REFERENCE (ACC, GT3/GT4):
- Tyre core temp (DHE/DHD slicks): optimal 70-100°C, warning 55-69°C or 101-115°C, critical <55°C or >115°C (past 115°C tyre life drops fast, past 130°C grip collapses).
- Tyre inner vs outer delta: >5°C hotter inside suggests too much negative camber; >5°C hotter outside suggests too little.
- Brake disc temp: optimal 400-750°C, warning 250-399°C or 751-900°C, critical <250°C (glazing risk) or >950°C (fade + pad wear spike).
- Tyre wear (per-tyre %): good 0-15%, warning 15-40%, critical >40%.
- Brake pad wear: good 0-30%, warning 30-60%, critical >60% (pedal travel starts growing).
Grade \`pace\` and \`handling\` \`assessment\` values against these bands.

ACC-SPECIFIC RULES:
- GT3/GT4 tyre pressure targets are typically 26.0–28.0 psi hot (27.5 psi ideal) — use psi with one decimal.
- TC/TC Cut/ABS are integer sliders in ACC — recommend integer step changes (e.g. "TC: 4 → 3").
- Engine Map: lower numbers are more aggressive; reference the current value and an integer target.
- Reference tyre compound (dry/wet) and weather/grip when recommending pressures or electronics.
- Reference specific numbers from the data — don't be vague.
- Address the driver as "you".
- Output ONLY valid JSON, nothing else.`;

export const accServerAdapter: ServerGameAdapter = {
  ...accAdapter,

  processNames: ["acc.exe", "acs2.exe", "AC2-Win64-Shipping.exe"],

  getCarName(ordinal: number): string {
    return getAccCarName(ordinal);
  },

  getTrackName(ordinal: number): string {
    return getAccTrackName(ordinal);
  },

  getSharedTrackName(ordinal: number): string | undefined {
    return getAccSharedTrackName(ordinal);
  },

  // ACC uses shared memory, not UDP — canHandle returns false since
  // ACC data doesn't go through the UDP parser dispatch.
  canHandle(buf: Buffer): boolean {
    return buf.length > 4 && buf.readUInt32LE(0) === ACC_PACKED_MAGIC;
  },

  tryParse(buf: Buffer, _state: unknown): TelemetryPacket | null {
    const triplet = unpackTriplet(buf);
    if (!triplet) return null;
    return parseAccBuffers(triplet.physics, triplet.graphics, triplet.staticData, {
      carOrdinal: triplet.carOrdinal,
      trackOrdinal: triplet.trackOrdinal,
    });
  },

  createParserState(): null {
    return null;
  },

  createLapDetector: (opts) => new LapDetectorAcc(opts),

  aiSystemPrompt: ACC_SYSTEM_PROMPT,

  buildAiContext(packets: TelemetryPacket[]): string {
    if (packets.length === 0) return "";

    const first = packets[0];
    const last = packets[packets.length - 1];
    const accFirst = first.acc;
    const accLast = last.acc;

    const lines: string[] = [];

    if (accFirst) {
      lines.push(`Tire compound: ${accFirst.tireCompound}`);
      lines.push(`Electronics — TC: ${accFirst.tc}, TC Cut: ${accFirst.tcCut}, ABS: ${accFirst.abs}, Engine Map: ${accFirst.engineMap}`);
      lines.push(`Brake bias: ${(accFirst.brakeBias * 100).toFixed(1)}% front`);
      lines.push(`Weather — Rain: ${(accFirst.rainIntensity * 100).toFixed(0)}%, Grip: ${accFirst.trackGripStatus}`);
    }

    if (accLast) {
      lines.push(`Fuel per lap: ${accLast.fuelPerLap.toFixed(2)}L`);
      lines.push(`Tire core temps (end) — FL: ${accLast.tireCoreTemp[0].toFixed(1)}°C, FR: ${accLast.tireCoreTemp[1].toFixed(1)}°C, RL: ${accLast.tireCoreTemp[2].toFixed(1)}°C, RR: ${accLast.tireCoreTemp[3].toFixed(1)}°C`);
      lines.push(`Brake pad wear — FL: ${(accLast.brakePadWear[0] * 100).toFixed(1)}%, FR: ${(accLast.brakePadWear[1] * 100).toFixed(1)}%, RL: ${(accLast.brakePadWear[2] * 100).toFixed(1)}%, RR: ${(accLast.brakePadWear[3] * 100).toFixed(1)}%`);

      const hasDamage = Object.values(accLast.carDamage).some((v) => v > 0);
      if (hasDamage) {
        lines.push(`Car damage — Front: ${accLast.carDamage.front.toFixed(2)}, Rear: ${accLast.carDamage.rear.toFixed(2)}, Left: ${accLast.carDamage.left.toFixed(2)}, Right: ${accLast.carDamage.right.toFixed(2)}`);
      }
    }

    const speeds = packets.map((p) => p.Speed * 3.6);
    const maxSpeed = Math.max(...speeds);
    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    lines.push(`Speed — Max: ${maxSpeed.toFixed(1)} km/h, Avg: ${avgSpeed.toFixed(1)} km/h`);

    return lines.join("\n");
  },
};
