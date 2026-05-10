import { useId } from "react";

export function GearRatioChart({
	ratios,
	finalDrive,
	topSpeedKph,
	topSpeedMph,
	maxRpm = 8000,
}: {
	ratios: number[];
	finalDrive: number;
	topSpeedKph?: number;
	topSpeedMph?: number;
	maxRpm?: number;
}) {
	const clipId = useId();
	if (!ratios.length) return null;

	const topGearRatio = ratios[ratios.length - 1];
	const referenceTopSpeedKph =
		topSpeedKph ?? (topSpeedMph ? topSpeedMph * 1.60934 : undefined);
	const tireCircumference =
		referenceTopSpeedKph && topGearRatio
			? (referenceTopSpeedKph * topGearRatio * finalDrive) / (maxRpm / 60) / 3.6
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
			className="block w-full text-app-text-muted"
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
