import { useId } from "react";
import type { TuneSettings } from "../../data/tune-catalog";

function storedHeightUnit(settings: TuneSettings): "cm" | "in" {
	return settings.springs.unit === "lb/in" ? "in" : "cm";
}

function GearRatioChart({
	ratios,
	finalDrive,
	topSpeedKph,
	maxRpm = 8000,
}: {
	ratios: number[];
	finalDrive: number;
	topSpeedKph?: number;
	maxRpm?: number;
}) {
	const clipId = useId();
	if (!ratios.length) return null;

	const topGearRatio = ratios[ratios.length - 1];
	const tireCircumference =
		topSpeedKph && topGearRatio
			? (topSpeedKph * topGearRatio * finalDrive) / (maxRpm / 60) / 3.6
			: 2.0;
	const toKph = (rpm: number, ratio: number) =>
		(rpm / 60 / (ratio * finalDrive)) * tireCircumference * 3.6;
	const maxSpeed = Math.ceil(toKph(maxRpm, topGearRatio) / 50) * 50;

	const width = 280;
	const height = 120;
	const pad = { top: 18, right: 16, bottom: 24, left: 32 };
	const chartWidth = width - pad.left - pad.right;
	const chartHeight = height - pad.top - pad.bottom;
	const sx = (value: number) =>
		Math.min((value / maxSpeed) * chartWidth, chartWidth);
	const sy = (rpm: number) => chartHeight - (rpm / maxRpm) * chartHeight;

	const rpmStep = maxRpm <= 8000 ? 2000 : maxRpm <= 12000 ? 3000 : 4000;
	const rpmGrids = Array.from(
		{ length: Math.floor(maxRpm / rpmStep) },
		(_, index) => (index + 1) * rpmStep,
	);
	const speedGrids = Array.from({ length: 5 }, (_, index) =>
		Math.round((maxSpeed / 4) * index),
	);
	const redlineY = pad.top + sy(maxRpm);

	return (
		<svg
			width="100%"
			viewBox={`0 0 ${width} ${height}`}
			className="block max-w-[280px] text-app-text-muted"
			aria-label="Gear ratio speed chart"
		>
			<defs>
				<clipPath id={clipId}>
					<rect
						x={pad.left}
						y={pad.top}
						width={chartWidth}
						height={chartHeight}
					/>
				</clipPath>
			</defs>

			<rect
				x={pad.left}
				y={pad.top}
				width={chartWidth}
				height={chartHeight}
				fill="currentColor"
				fillOpacity="0.03"
			/>

			{rpmGrids.map((rpm) => (
				<g key={rpm}>
					<line
						x1={pad.left}
						y1={pad.top + sy(rpm)}
						x2={pad.left + chartWidth}
						y2={pad.top + sy(rpm)}
						stroke="currentColor"
						strokeOpacity="0.1"
					/>
					<text
						x={pad.left - 4}
						y={pad.top + sy(rpm) + 3}
						textAnchor="end"
						fontSize="7"
						fill="currentColor"
						fillOpacity="0.45"
					>
						{rpm / 1000}
					</text>
				</g>
			))}

			{speedGrids.map((speed) => (
				<g key={speed}>
					<line
						x1={pad.left + sx(speed)}
						y1={pad.top}
						x2={pad.left + sx(speed)}
						y2={pad.top + chartHeight}
						stroke="currentColor"
						strokeOpacity="0.1"
					/>
					<text
						x={pad.left + sx(speed)}
						y={pad.top + chartHeight + 10}
						textAnchor="middle"
						fontSize="7"
						fill="currentColor"
						fillOpacity="0.45"
					>
						{speed}
					</text>
				</g>
			))}

			<text
				x={pad.left + chartWidth}
				y={pad.top + chartHeight + 20}
				textAnchor="end"
				fontSize="7"
				fill="currentColor"
				fillOpacity="0.35"
			>
				KM/H
			</text>
			<text
				x={pad.left - 4}
				y={pad.top - 6}
				textAnchor="end"
				fontSize="7"
				fill="currentColor"
				fillOpacity="0.35"
			>
				RPM ×1000
			</text>

			{ratios.map((ratio, index) => {
				const startKph = index === 0 ? 0 : toKph(maxRpm, ratios[index - 1]);
				const startRpm =
					index === 0
						? 0
						: (((startKph / 3.6) * (ratio * finalDrive)) / tireCircumference) *
							60;
				const points = Array.from({ length: 60 }, (_, pointIndex) => {
					const rpm = startRpm + (pointIndex / 59) * (maxRpm - startRpm);
					return `${pad.left + sx(toKph(rpm, ratio))},${pad.top + sy(rpm)}`;
				}).join(" ");
				return (
					<g key={`${index}-${ratio}`}>
						<polyline
							points={points}
							fill="none"
							stroke="white"
							strokeWidth="1.5"
							strokeOpacity="0.7"
							clipPath={`url(#${clipId})`}
						/>
						<text
							x={pad.left + sx(toKph(maxRpm, ratio)) + 2}
							y={pad.top + sy(maxRpm) - 3}
							textAnchor="middle"
							fontSize="7"
							fill="white"
							fillOpacity="0.6"
							fontWeight="600"
						>
							{index + 1}
						</text>
					</g>
				);
			})}

			<line
				x1={pad.left}
				y1={redlineY}
				x2={pad.left + chartWidth}
				y2={redlineY}
				stroke="#ef4444"
				strokeWidth="1"
				strokeOpacity="0.8"
				strokeDasharray="3 2"
			/>
			<rect
				x={pad.left}
				y={pad.top}
				width={chartWidth}
				height={chartHeight}
				fill="none"
				stroke="currentColor"
				strokeOpacity="0.15"
			/>
		</svg>
	);
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
