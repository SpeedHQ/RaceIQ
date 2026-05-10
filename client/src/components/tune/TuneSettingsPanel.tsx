import type { TuneSettings } from "../../data/tune-catalog";
import { GearRatioChart } from "./GearRatioChart";

function storedHeightUnit(settings: TuneSettings): "cm" | "in" {
	return settings.springs.unit === "lb/in" ? "in" : "cm";
}

export function TuneSettingsPanel({ settings }: { settings: TuneSettings }) {
	const ratios = settings.gearing.ratios ?? [];
	const sections: { title: string; rows: [string, string][] }[] = [
		{
			title: "Tires",
			rows: [
				["Front Pressure", `${settings.tires.frontPressure.toFixed(2)} bar`],
				["Rear Pressure", `${settings.tires.rearPressure.toFixed(2)} bar`],
			],
		},
		{
			title: "Gearing",
			rows: [
				["Final Drive", settings.gearing.finalDrive.toFixed(2)],
				...ratios.map(
					(ratio, index) =>
						[`Gear ${index + 1}`, ratio.toFixed(2)] as [string, string],
				),
				...(settings.gearing.description
					? [["Notes", settings.gearing.description] as [string, string]]
					: []),
			],
		},
		{
			title: "Alignment",
			rows: [
				["Front Camber", `${settings.alignment.frontCamber.toFixed(1)}\u00B0`],
				["Rear Camber", `${settings.alignment.rearCamber.toFixed(1)}\u00B0`],
				["Front Toe", `${settings.alignment.frontToe.toFixed(1)}\u00B0`],
				["Rear Toe", `${settings.alignment.rearToe.toFixed(1)}\u00B0`],
				...(settings.alignment.frontCaster != null
					? [
							[
								"Front Caster",
								`${settings.alignment.frontCaster.toFixed(1)}\u00B0`,
							] as [string, string],
						]
					: []),
			],
		},
		{
			title: "Anti-Roll Bars",
			rows: [
				["Front", settings.antiRollBars.front.toFixed(1)],
				["Rear", settings.antiRollBars.rear.toFixed(1)],
			],
		},
		{
			title: "Springs",
			rows: [
				[
					"Front Rate",
					`${settings.springs.frontRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`,
				],
				[
					"Rear Rate",
					`${settings.springs.rearRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`,
				],
				[
					"Front Height",
					`${settings.springs.frontHeight.toFixed(1)} ${storedHeightUnit(settings)}`,
				],
				[
					"Rear Height",
					`${settings.springs.rearHeight.toFixed(1)} ${storedHeightUnit(settings)}`,
				],
			],
		},
		{
			title: "Damping",
			rows: [
				["Front Bump", settings.damping.frontBump.toFixed(1)],
				["Rear Bump", settings.damping.rearBump.toFixed(1)],
				["Front Rebound", settings.damping.frontRebound.toFixed(1)],
				["Rear Rebound", settings.damping.rearRebound.toFixed(1)],
			],
		},
		{
			title: "Aero",
			rows: [
				[
					"Front Downforce",
					`${settings.aero.frontDownforce} ${settings.aero.unit ?? "kgf"}`,
				],
				[
					"Rear Downforce",
					`${settings.aero.rearDownforce} ${settings.aero.unit ?? "kgf"}`,
				],
			],
		},
		{
			title: "Differential",
			rows: [
				["Rear Accel", `${settings.differential.rearAccel}%`],
				["Rear Decel", `${settings.differential.rearDecel}%`],
				...(settings.differential.frontAccel != null
					? [
							["Front Accel", `${settings.differential.frontAccel}%`] as [
								string,
								string,
							],
						]
					: []),
				...(settings.differential.frontDecel != null
					? [
							["Front Decel", `${settings.differential.frontDecel}%`] as [
								string,
								string,
							],
						]
					: []),
				...(settings.differential.center != null
					? [["Center", `${settings.differential.center}%`] as [string, string]]
					: []),
			],
		},
		{
			title: "Brakes",
			rows: [
				["Balance", `${settings.brakes.balance}%`],
				["Pressure", `${settings.brakes.pressure}%`],
			],
		},
	];

	return (
		<div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-w-2xl">
			{sections.map((section) => (
				<div key={section.title} className="rounded-lg bg-app-bg/85 p-3">
					<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
						{section.title}
					</h4>
					<div className="space-y-0">
						{section.rows.map(([label, value]) => (
							<div key={label} className="flex justify-between text-xs gap-2">
								<span className="text-app-text-muted whitespace-nowrap">
									{label}
								</span>
								<span
									className="text-app-text font-mono whitespace-nowrap"
									style={
										label === "Notes"
											? { whiteSpace: "normal", textAlign: "right" }
											: undefined
									}
								>
									{value}
								</span>
							</div>
						))}
					</div>
					{section.title === "Gearing" && ratios.length > 0 && (
						<div className="mt-2 pt-2 border-t border-app-border/60">
							<GearRatioChart
								ratios={ratios}
								finalDrive={settings.gearing.finalDrive}
								topSpeedKph={settings.gearing.topSpeedKph}
							/>
						</div>
					)}
				</div>
			))}
		</div>
	);
}
