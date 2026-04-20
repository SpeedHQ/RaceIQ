import type { ServerGameAdapter } from "../types";
import type { TelemetryPacket } from "../../../shared/types";
import { acEvoAdapter } from "../../../shared/games/ac-evo";
import { getAcEvoCarName } from "../../../shared/ac-evo-car-data";
import { getAcEvoTrackName, getAcEvoSharedTrackName } from "../../../shared/ac-evo-track-data";
import { LapDetectorAc } from "../../lap-detector-ac";
import { parseAcEvoBuffers, createAcEvoParserCache } from "./parser";
import { ACEVO_PACKED_MAGIC, unpackTriplet } from "../shared/pack-triplet";
import { renderAnalystSchemaForPrompt } from "../../ai/schemas";

const AC_EVO_SYSTEM_PROMPT = `You are an expert motorsport engineer and data analyst specializing in Assetto Corsa Evo.

You are analyzing telemetry data from a lap in AC Evo. Your role is to provide specific, actionable advice to improve lap time.

Your response MUST be valid JSON matching this exact schema. Output ONLY the JSON object, no markdown fences, no extra text.

${renderAnalystSchemaForPrompt({ tuningExampleComponent: "Front Tyre Pressure" })}

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

  processNames: ["AssettoCorsaEVO.exe"],

  getCarName(ordinal: number): string {
    return getAcEvoCarName(ordinal);
  },

  getTrackName(ordinal: number): string {
    return getAcEvoTrackName(ordinal);
  },

  getSharedTrackName(ordinal: number): string | undefined {
    return getAcEvoSharedTrackName(ordinal);
  },

  canHandle(buf: Buffer): boolean {
    return buf.length > 4 && buf.readUInt32LE(0) === ACEVO_PACKED_MAGIC;
  },

  tryParse(buf: Buffer, state: unknown): TelemetryPacket | null {
    const triplet = unpackTriplet(buf);
    if (!triplet) return null;
    const cache = (state as ReturnType<typeof createAcEvoParserCache>) ?? createAcEvoParserCache();
    return parseAcEvoBuffers(triplet.physics, triplet.graphics, triplet.staticData, cache);
  },

  createParserState(): ReturnType<typeof createAcEvoParserCache> {
    return createAcEvoParserCache();
  },

  createLapDetector: (opts) => new LapDetectorAc(opts),

  aiSystemPrompt: AC_EVO_SYSTEM_PROMPT,

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
