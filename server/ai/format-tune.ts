import type { TuneSettings, TuneCategory } from "../../shared/types";

interface TuneForPrompt {
	name: string;
	author: string;
	category: TuneCategory;
	settings: TuneSettings;
}

function summariseGameSpecificSettings(settings: unknown): string | null {
	if (!settings || typeof settings !== "object") return null;
	const lines: string[] = [];
	const walk = (value: unknown, path: string) => {
		if (lines.length >= 60 || value == null) return;
		if (Array.isArray(value)) {
			if (value.length > 0 && value.length <= 8 && value.every((item) => typeof item === "number" || typeof item === "string")) {
				lines.push(`${path}: [${value.join(", ")}]`);
			}
			return;
		}
		if (typeof value === "object") {
			for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
				walk(child, path ? `${path}.${key}` : key);
			}
			return;
		}
		if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
			lines.push(`${path}: ${value}`);
		}
	};
	walk(settings, "");
	return lines.length > 0 ? lines.join("\n") : null;
}

function isForzaTuneSettings(settings: TuneSettings): boolean {
	const value = settings as unknown as Record<string, unknown>;
	return Boolean(value.tires && value.gearing && value.alignment && value.antiRollBars && value.springs && value.damping && value.aero && value.differential && value.brakes);
}


export function formatTuneForPrompt(tune: TuneForPrompt): string {
	if (!isForzaTuneSettings(tune.settings)) {
		const summary = summariseGameSpecificSettings(tune.settings);
		return [
			`--- ACTIVE TUNE: "${tune.name}" by ${tune.author} (${tune.category}) ---`,
			summary ? `Game-specific setup values:\n${summary}` : "Game-specific setup values unavailable.",
		].join("\n");
	}
	const s = tune.settings;
	const lines: string[] = [];

	lines.push(
		`--- ACTIVE TUNE: "${tune.name}" by ${tune.author} (${tune.category}) ---`,
	);

	const compound = s.tires.compound ? ` (${s.tires.compound})` : "";
	lines.push(
		`Tires (front/rear axle only): Front ${s.tires.frontPressure} PSI, Rear ${s.tires.rearPressure} PSI${compound}`,
	);

	const ratios = s.gearing.ratios
		? `, Ratios: [${s.gearing.ratios.join(", ")}]`
		: "";
	lines.push(`Gearing: Final Drive ${s.gearing.finalDrive}${ratios}`);

	const caster =
		s.alignment.frontCaster != null
			? `, Caster ${s.alignment.frontCaster}°`
			: "";
	lines.push(
		`Alignment: Camber F ${s.alignment.frontCamber}° R ${s.alignment.rearCamber}°, Toe F ${s.alignment.frontToe}° R ${s.alignment.rearToe}°${caster}`,
	);

	lines.push(
		`Anti-Roll Bars: F ${s.antiRollBars.front}, R ${s.antiRollBars.rear}`,
	);

	const springUnit = s.springs.unit ?? "lb/in";
	const heightUnit = springUnit === "lb/in" ? "in" : "cm";
	lines.push(
		`Springs: F ${s.springs.frontRate} ${springUnit} @ ${s.springs.frontHeight}${heightUnit}, R ${s.springs.rearRate} ${springUnit} @ ${s.springs.rearHeight}${heightUnit}`,
	);

	lines.push(
		`Damping: Bump F ${s.damping.frontBump} R ${s.damping.rearBump}, Rebound F ${s.damping.frontRebound} R ${s.damping.rearRebound}`,
	);

	lines.push(
		"Forza tune adjustability: tire pressure, springs, damping, anti-roll bars, ride height, aero, and alignment are changed as front/rear axle settings only; do not suggest individual FL/FR/RL/RR setup adjustments.",
	);

	const aeroUnit = s.aero.unit ?? "lb";
	lines.push(
		`Aero: Front ${s.aero.frontDownforce} ${aeroUnit}, Rear ${s.aero.rearDownforce} ${aeroUnit}`,
	);

	const diff = s.differential;
	let diffStr = `Accel ${diff.rearAccel}%, Decel ${diff.rearDecel}%`;
	if (diff.frontAccel != null)
		diffStr = `Front Accel ${diff.frontAccel}% Decel ${diff.frontDecel ?? 0}%, Rear ${diffStr}`;
	if (diff.center != null) diffStr += `, Center ${diff.center}%`;
	lines.push(`Differential: ${diffStr}`);

	lines.push(
		`Brakes: Balance ${s.brakes.balance}%, Pressure ${s.brakes.pressure}%`,
	);

	return lines.join("\n");
}
