import type { ServerGameAdapter } from "../types";
import { forzaAdapter } from "../../../shared/games/fm-2023";
import { parseForzaPacket } from "../../parsers/forza";
import { carMap, trackMap } from "../../../shared/car-data";
import { getForzaSharedOutline } from "../../../shared/track-data";
import { LapDetector } from "../../lap-detector";
import { renderAnalystSchemaForPrompt } from "../../ai/schemas";

const FORZA_SYSTEM_PROMPT = `You are an expert Forza Motorsport racing engineer and driving coach. Analyse the telemetry data provided and give specific, actionable feedback.

Your response MUST be valid JSON matching this exact schema. Output ONLY the JSON object, no markdown fences, no extra text.

${renderAnalystSchemaForPrompt({ tuningExampleComponent: "Front Springs" })}

CATEGORY GUIDELINES:
- "pace": 4-6 items covering speed, throttle %, braking efficiency, full-throttle time, gear usage. Each with a concrete value.
- "handling": 4-6 items covering suspension travel, tire temps, tire wear balance, oversteer/understeer, weight transfer. Each with a concrete value.
- "corners": Top 3-5 problem corners where time is being lost. Include speed numbers.
- "technique": 3-5 actionable driving tips. Reference specific telemetry values.
- "setup": 6-12 specific component adjustments with concrete \`current\` and \`target\` numeric values (both with units, e.g. "750 lb/in" → "680 lb/in"). Each entry MUST include \`symptom\` (data-cited), \`fix\`, and \`direction\`. Aim for coverage across categories where data supports a change: (a) Springs + Dampers (Bump first, then Rebound), (b) Anti-roll bars, (c) Aero (front/rear downforce), (d) Alignment (camber, caster, toe), (e) Differential accel/decel, (f) Tire pressures, (g) Gearing, (h) Brake bias. Skip only categories that are genuinely on-target.

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
- When tune settings are provided, correlate telemetry symptoms (e.g., understeer, tire temps, suspension bottoming) with specific setup values and recommend concrete adjustments with target numbers
- Reference the actual tune values when suggesting changes (e.g., "Front springs at 750 lb/in are too stiff for this track — try 650-680 lb/in")
- For Forza setup recommendations, adjustable tune values are front/rear axle settings only. Never recommend individual FL/FR/RL/RR tire pressure, damping, spring, anti-roll bar, ride-height, aero, or alignment changes. If per-tire telemetry differs, translate it into a front/rear axle adjustment or a driving/coaching note.
- Output ONLY valid JSON, nothing else`;

export const forzaServerAdapter: ServerGameAdapter = {
	...forzaAdapter,

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
