import type { ServerGameAdapter } from "../types";
import { forzaAdapter } from "../../../shared/games/fm-2023";
import { parseForzaPacket } from "./parser";
import { carMap, trackMap } from "../../../shared/car-data";
import { getForzaSharedOutline } from "../../../shared/track-data";
import { LapDetector } from "../../lap-detection/detector";
import { renderAnalystSchemaForPrompt } from "../../ai/schemas";

const FORZA_SYSTEM_PROMPT = `You are an expert Forza Motorsport racing engineer and driving coach. Analyse the telemetry data provided and give specific, actionable feedback.

Your response MUST be valid JSON matching this exact schema. Output ONLY the JSON object, no markdown fences, no extra text.

${renderAnalystSchemaForPrompt()}

CATEGORY GUIDELINES:
- "pace": 4-6 items covering speed, throttle %, braking efficiency, full-throttle time, gear usage. Each with a concrete value.
- "handling": 4-6 items covering suspension travel, tire temps, tire wear balance, oversteer/understeer, weight transfer. Each with a concrete value.
- "corners": Top 3-5 problem corners where time is being lost. Include speed numbers.
- "technique": 3-5 actionable driving tips. Reference specific telemetry values.

THERMAL REFERENCE (Forza Motorsport, generic):
- Tyre surface temp (road/sport/street): optimal 70-95°C, warning 50-69°C or 96-115°C, critical <50°C or >115°C.
- Tyre surface temp (race compound): optimal 85-105°C, warning 65-84°C or 106-125°C, critical <65°C or >125°C.
- Brake disc temp: optimal 300-600°C for steel/race, warning <250°C or >700°C, critical <150°C or >800°C.
- Tyre wear (per-tyre %): good 0-20%, warning 20-50%, critical >50% — pace loss becomes meaningful past 30%.
Grade \`pace\` and \`handling\` \`assessment\` values against these bands; note when the data suggests a different compound/class than assumed.

RULES:
- Reference specific numbers from the data — don't be vague
- Be specific and actionable, not generic
- Address the driver as "you"
- Output ONLY valid JSON, nothing else`;

export const forzaServerAdapter: ServerGameAdapter = {
	...forzaAdapter,

	runtime: {
		pit: {
			seedFuelFromHistory: true,
			seedTireWearFromHistory: false,
			useDistanceBasedWearCurves: false,
		},
		bestLapFromSession: false,
		requiresTrackCalibration: true,
		normSuspensionTravelMm: { min: 20, max: 80 },
	},

	processNames: ["ForzaMotorsport.exe", "forza_steamworks_release_final"],

	getCarName(ordinal) {
		const car = carMap.get(ordinal);
		if (!car) return `Car #${ordinal}`;
		return `${car.year} ${car.make} ${car.model}`;
	},

	getTrackName(ordinal) {
		const track = trackMap.get(ordinal);
		if (!track) return `Track #${ordinal}`;
		return `${track.name} - ${track.variant}`;
	},

	getSharedTrackName(ordinal) {
		return getForzaSharedOutline(ordinal);
	},

	canHandle(buf) {
		return buf.length >= 324 && buf.length <= 400;
	},

	tryParse(buf) {
		return parseForzaPacket(buf);
	},

	createParserState() {
		return null;
	},

	createLapDetector: (opts) => new LapDetector(opts),

	aiSystemPrompt: FORZA_SYSTEM_PROMPT,
};
