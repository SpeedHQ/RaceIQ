import { resolve } from "node:path";
import type { ServerGameAdapter } from "@raceiq/backend-core/games/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { accAdapter } from "@raceiq/game-acc-metadata/index";
import { getAccCarName } from "@raceiq/game-acc-metadata/racing/cars/acc"
import { getAccTrackName, getAccSharedTrackName, getAccTrackByName, getAccTrackBySetupFolder } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc"
import { LapDetectorAcc } from "./lap-detector"
import { renderAnalystSchemaForPrompt } from "@raceiq/backend-core/ai/schemas";
import { buildKunosAiContext } from "@raceiq/backend-core/games/kunos/ai-context";

import { accParser } from "./game-parser";
const ACC_SYSTEM_PROMPT = `You are an expert GT racing engineer and data analyst specializing in Assetto Corsa Competizione.

You are analyzing telemetry data from a lap in ACC. Your role is to provide specific, actionable advice to improve lap time.

Your response MUST be valid JSON matching this exact schema. Output ONLY the JSON object, no markdown fences, no extra text.

${renderAnalystSchemaForPrompt()}

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

  runtime: {
    pit: {
      seedFuelFromHistory: true,
      seedTireWearFromHistory: true,
      useDistanceBasedWearCurves: true,
    },
    bestLapFromSession: true,
    requiresTrackCalibration: false,
    normSuspensionTravelMm: { min: 0, max: 50 },
  },

  processNames: ["acc.exe", "acs2.exe", "AC2-Win64-Shipping.exe"],

  getSetupsDirCandidates(home: string): string[] {
    return [
      resolve(home, "Documents", "Assetto Corsa Competizione", "Setups"),
      resolve(home, "OneDrive", "Documents", "Assetto Corsa Competizione", "Setups"),
    ];
  },

  getCarName(ordinal: number): string {
    return getAccCarName(ordinal);
  },

  getTrackName(ordinal: number): string {
    return getAccTrackName(ordinal);
  },

  getSharedTrackName(ordinal: number): string | undefined {
    return getAccSharedTrackName(ordinal);
  },

  getTrackOrdinalByName(name: string): number | undefined {
    return getAccTrackBySetupFolder(name)?.id ?? getAccTrackByName(name)?.id;
  },

  canHandle: accParser.canHandle,
  tryParse(buf, state, timestampMs) {
    return accParser.tryParse(buf, state as never, timestampMs ?? Date.now());
  },
  tryParseLapIndex(buf, state, timestampMs) {
    return accParser.tryParseLapIndex(buf, state as never, timestampMs ?? Date.now());
  },
  primeParserState(buf, state) {
    accParser.primeParserState(buf, state as never);
  },
  createParserState: accParser.createParserState,
  createLapDetector: (opts) => new LapDetectorAcc(opts),

  aiSystemPrompt: ACC_SYSTEM_PROMPT,

  buildAiContext(packets: TelemetryPacket[]): string {
    return buildKunosAiContext(packets, true);
  },
};
