import type { ServerGameAdapter } from "../types";
import type { TelemetryPacket } from "../../../shared/types";
import { accAdapter } from "../../../shared/games/acc";
import { getAccCarName } from "../../../shared/acc-car-data";
import { getAccTrackName, getAccSharedTrackName } from "../../../shared/acc-track-data";
import { LapDetectorV2 } from "../../lap-detector-v2";
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
- "setup": 3-5 high-level setup changes. Always include the symptom from data and the specific fix. Consider brake bias, tyre pressures, differential, spring/damper balance.
- "tuning": 4-8 specific component adjustments with concrete target values. Cover: tyre pressures, brake bias, TC, TC Cut, ABS, engine map, anti-roll bars, bump/rebound, ride height, diff preload. Only include components where the data suggests a change is needed.

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
  canHandle(_buf: Buffer): boolean {
    return false;
  },

  tryParse(_buf: Buffer, _state: unknown): TelemetryPacket | null {
    return null;
  },

  createParserState(): null {
    return null;
  },

  createLapDetector: (opts) => new LapDetectorV2(opts),

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
