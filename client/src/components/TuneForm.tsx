import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { useQuery } from "@tanstack/react-query";
import type { TuneSettings } from "../data/tune-catalog";
import type { TuneCategory } from "@shared/types";
import { client } from "../lib/rpc";
import { GearRatioChart } from "./tune/GearRatioChart";
import { useSettings } from "../hooks/queries";

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAllCars() {
	return useQuery<
		{
			ordinal: number;
			name: string;
			specs?: {
				topSpeedMph: number;
				hp: number;
				torque: number;
				engine: string;
				drivetrain: string;
				weightKg: number;
				displacement: number;
				aspiration: string;
				imageUrl: string;
				division: string;
			};
		}[]
	>({
		queryKey: ["all-cars"],
		queryFn: () => client.api.cars.$get().then((r) => r.json()),
		staleTime: Infinity,
	});
}

// ── Constants ────────────────────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<string, string> = {
	circuit: "Circuit",
	wet: "Wet",
	"low-drag": "Low Drag",
	stable: "Stable",
	"track-specific": "Track Specific",
};

export const CATEGORY_COLORS: Record<string, string> = {
	circuit: "bg-blue-500/20 text-blue-400",
	wet: "bg-cyan-500/20 text-cyan-400",
	"low-drag": "bg-red-500/20 text-red-400",
	stable: "bg-green-500/20 text-green-400",
	"track-specific": "bg-orange-500/20 text-orange-400",
};

export const ALL_CATEGORIES: TuneCategory[] = [
	"circuit",
	"wet",
	"low-drag",
	"stable",
	"track-specific",
];

// ── Unit conversion ──────────────────────────────────────────────────────────

const IMPERIAL = {
	tires: { factor: 14.50377, metric: "bar", imperial: "psi" },
	springs: { factor: 56.0, metric: "kgf/mm", imperial: "lb/in" },
	height: { factor: 0.393701, metric: "cm", imperial: "in" },
	aero: { factor: 2.20462, metric: "kgf", imperial: "lb" },
} as const;

type ConvCategory = keyof typeof IMPERIAL;

export function toDisplay(
	value: number,
	cat: ConvCategory,
	isMetric: boolean,
): number {
	if (isMetric) return value;
	return Math.round(value * IMPERIAL[cat].factor * 1000) / 1000;
}

export function fromDisplay(
	value: number,
	cat: ConvCategory,
	isMetric: boolean,
): number {
	if (isMetric) return value;
	return Math.round((value / IMPERIAL[cat].factor) * 1000) / 1000;
}

export function unitLabel(cat: ConvCategory, isMetric: boolean): string {
	return isMetric ? IMPERIAL[cat].metric : IMPERIAL[cat].imperial;
}

function storedHeightUnit(settings: TuneSettings): "cm" | "in" {
	return settings.springs.unit === "lb/in" ? "in" : "cm";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function defaultTuneSettings(): TuneSettings {
	return {
		tires: { frontPressure: 1.7, rearPressure: 1.7 },
		gearing: {
			finalDrive: 3.5,
			ratios: [3.5, 2.5, 1.9, 1.5, 1.2, 1.0],
			topSpeedKph: 250,
		},
		alignment: {
			frontCamber: -1.0,
			rearCamber: -0.5,
			frontToe: 0.0,
			rearToe: 0.0,
		},
		antiRollBars: { front: 20, rear: 20 },
		springs: { frontRate: 100, rearRate: 100, frontHeight: 10, rearHeight: 10 },
		damping: { frontRebound: 8, rearRebound: 8, frontBump: 5, rearBump: 5 },
		rollCenterHeight: { front: 0, rear: 0 },
		antiGeometry: { antiDiveFront: 0, antiSquatRear: 0 },
		aero: { frontDownforce: 100, rearDownforce: 100 },
		differential: { rearAccel: 60, rearDecel: 30 },
		brakes: { balance: 50, pressure: 100 },
	};
}

export function withDefaults(s?: TuneSettings): TuneSettings {
	if (!s) return defaultTuneSettings();
	return {
		...s,
		rollCenterHeight: s.rollCenterHeight ?? { front: 0, rear: 0 },
		antiGeometry: s.antiGeometry ?? { antiDiveFront: 0, antiSquatRear: 0 },
	};
}

// ── TuneFormData interface ───────────────────────────────────────────────────

export interface TuneFormData {
	name: string;
	author: string;
	carOrdinal: number;
	category: TuneCategory;
	description: string;
	settings: TuneSettings;
	unitSystem: "metric" | "imperial";
}

// ── NumberField ──────────────────────────────────────────────────────────────

export function NumberField({
	label,
	value,
	onChange,
	step,
	unit,
}: {
	label: string;
	value: number;
	onChange: (v: number) => void;
	step?: number;
	unit?: string;
}) {
	return (
		<label className="flex items-center justify-between gap-3 text-xs">
			<span className="text-app-text-muted whitespace-nowrap">{label}</span>
			<div className="flex items-center gap-2">
				{unit && (
					<span className="text-[10px] text-app-text-muted w-10 text-right">
						{unit}
					</span>
				)}
				<input
					type="number"
					value={value}
					step={step ?? 0.1}
					onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
					className="w-20 bg-app-bg border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text font-mono text-right focus:outline-none focus:ring-1 focus:ring-app-accent"
				/>
			</div>
		</label>
	);
}

// ── TuneSettingsPanel (read-only) ────────────────────────────────────────────

export function TuneSettingsPanel({
	settings: raw,
}: {
	settings: TuneSettings;
}) {
	const settings = {
		...raw,
		rollCenterHeight: raw.rollCenterHeight ?? { front: 0, rear: 0 },
		antiGeometry: raw.antiGeometry ?? { antiDiveFront: 0, antiSquatRear: 0 },
	};
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
			title: "Roll Center Height",
			rows: [
				[
					"Front",
					`${settings.rollCenterHeight.front.toFixed(1)} ${storedHeightUnit(settings)}`,
				],
				[
					"Rear",
					`${settings.rollCenterHeight.rear.toFixed(1)} ${storedHeightUnit(settings)}`,
				],
			],
		},
		{
			title: "Anti-Geometry",
			rows: [
				[
					"Anti-dive (front)",
					`${settings.antiGeometry.antiDiveFront.toFixed(1)}%`,
				],
				[
					"Anti-squat (rear)",
					`${settings.antiGeometry.antiSquatRear.toFixed(1)}%`,
				],
			],
		},
		{
			title: "Aero",
			rows: [
				[
					"Front",
					`${settings.aero.frontDownforce} ${settings.aero.unit ?? "kgf"}`,
				],
				[
					"Rear",
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

	const tiresSection = sections.find((section) => section.title === "Tires");
	const alignmentSection = sections.find(
		(section) => section.title === "Alignment",
	);
	const gearingSection = sections.find(
		(section) => section.title === "Gearing",
	);
	const remainingSections = sections.filter(
		(section) =>
			section.title !== "Tires" &&
			section.title !== "Gearing" &&
			section.title !== "Alignment",
	);
	const orderedSections = [
		...(tiresSection ? [tiresSection] : []),
		...(gearingSection ? [gearingSection] : []),
		...(alignmentSection ? [alignmentSection] : []),
		...remainingSections,
	];

	const renderSection = (section: {
		title: string;
		rows: [string, string][];
	}) => (
		<div
			key={section.title}
			className="mb-3 break-inside-avoid rounded-lg bg-app-bg p-3"
		>
			<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
				{section.title}
			</h4>
			<div className="space-y-0">
				{section.rows.map(([label, value]) => (
					<div key={label} className="flex justify-between text-xs gap-2">
						<span className="text-app-text-muted whitespace-nowrap">
							{label}
						</span>
						<span className="text-app-text font-mono whitespace-nowrap">
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
						topSpeedMph={
							settings.gearing.topSpeedKph
								? settings.gearing.topSpeedKph / 1.60934
								: undefined
						}
					/>
				</div>
			)}
		</div>
	);

	return (
		<div className="w-full columns-1 gap-3 md:columns-2 xl:columns-3">
			{orderedSections.map((section) => renderSection(section))}
		</div>
	);
}

// ── UserTuneCard ─────────────────────────────────────────────────────────────

export function UserTuneCard({
	tune,
	carName,
	isExpanded,
	onToggle,
	onEdit,
	onDelete,
	isDeleting,
}: {
	tune: {
		id: number;
		name: string;
		carOrdinal: number;
		category: string;
		source?: string;
		description: string;
		author: string;
		settings?: TuneSettings;
	};
	carName?: string;
	isExpanded: boolean;
	onToggle: () => void;
	onEdit: () => void;
	onDelete: () => void;
	isDeleting: boolean;
}) {
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [shareOpen, setShareOpen] = useState(false);
	const [shareStatus, setShareStatus] = useState<"idle" | "copied">("idle");

	const exportedSettings = tune.settings ?? defaultTuneSettings();
	const exportedUnitSystem =
		exportedSettings.springs?.unit === "lb/in" ||
		exportedSettings.aero?.unit === "lb"
			? "imperial"
			: "metric";
	const payload = {
		format: "raceiq-tune/v1",
		exportedAt: new Date().toISOString(),
		unitSystem: exportedUnitSystem,
		name: tune.name,
		author: tune.author,
		carOrdinal: tune.carOrdinal,
		category: tune.category,
		description: tune.description,
		settings: {
			...exportedSettings,
			springs: {
				...exportedSettings.springs,
				unit: undefined,
			},
			aero: {
				...exportedSettings.aero,
				unit: undefined,
			},
		},
	};

	const handleCopyShare = async (e: React.MouseEvent<HTMLButtonElement>) => {
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
			setShareStatus("copied");
			setTimeout(() => setShareStatus("idle"), 2000);
			setShareOpen(false);
		} catch {
			setShareStatus("idle");
		}
	};

	const handleDownloadShare = (e: React.MouseEvent<HTMLButtonElement>) => {
		e.stopPropagation();
		const json = JSON.stringify(payload, null, 2);
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${tune.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || `tune-${tune.id}`}.raceiq-tune.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		setShareOpen(false);
	};

	return (
		<div className="rounded-xl bg-app-surface ring-1 ring-app-border overflow-hidden">
			<button
				onClick={onToggle}
				className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-app-surface transition-colors"
			>
				<div className="min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<span className="font-semibold text-app-text">{tune.name}</span>
						<span className="text-[10px] font-mono text-app-text-muted">
							{carName ?? `Car #${tune.carOrdinal}`}
						</span>
						<span
							className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${CATEGORY_COLORS[tune.category] ?? "bg-gray-500/20 text-gray-400"}`}
						>
							{CATEGORY_LABELS[tune.category] ?? tune.category}
						</span>
						<span className="text-[10px] text-app-text-muted">
							by {tune.author} &middot;{" "}
							{tune.source === "catalog-clone"
								? "cloned from catalog"
								: "user created"}
						</span>
						{tune.source === "catalog-clone" && (
							<span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
								Cloned
							</span>
						)}
					</div>
					<p
						className={`text-xs text-app-text-muted mt-0.5 ${isExpanded ? "" : "line-clamp-1"}`}
					>
						{tune.description}
					</p>
				</div>
				<svg
					className={`w-4 h-4 text-app-text-muted shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					strokeWidth={2}
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M19 9l-7 7-7-7"
					/>
				</svg>
			</button>

			{isExpanded && (
				<div className="px-4 pb-4 space-y-4 border-t border-app-border">
					<div className="flex items-center gap-2 pt-3">
						<button
							onClick={(e) => {
								e.stopPropagation();
								onEdit();
							}}
							className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
						>
							Edit
						</button>
						<div className="relative">
							<button
								onClick={(e) => {
									e.stopPropagation();
									setShareOpen((v) => !v);
								}}
								className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
							>
								{shareStatus === "copied" ? "Copied" : "Share"}
							</button>
							{shareOpen && (
								<div className="absolute left-0 top-full mt-1 z-20 min-w-40 rounded-md border border-app-border bg-app-surface p-1 shadow-lg">
									<button
										type="button"
										onClick={handleCopyShare}
										className="block w-full text-left text-[10px] px-2 py-1 rounded hover:bg-app-accent/20 text-app-text"
									>
										Copy to clipboard
									</button>
									<button
										type="button"
										onClick={handleDownloadShare}
										className="block w-full text-left text-[10px] px-2 py-1 rounded hover:bg-app-accent/20 text-app-text"
									>
										Download JSON
									</button>
								</div>
							)}
						</div>
						{!confirmDelete ? (
							<button
								onClick={(e) => {
									e.stopPropagation();
									setConfirmDelete(true);
								}}
								className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
							>
								Delete
							</button>
						) : (
							<span className="flex items-center gap-1">
								<span className="text-[10px] text-red-400">Sure?</span>
								<button
									onClick={(e) => {
										e.stopPropagation();
										onDelete();
									}}
									disabled={isDeleting}
									className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-red-600/30 text-red-300 hover:bg-red-600/50 disabled:opacity-50 transition-colors"
								>
									{isDeleting ? "..." : "Yes"}
								</button>
								<button
									onClick={(e) => {
										e.stopPropagation();
										setConfirmDelete(false);
									}}
									className="text-[10px] font-semibold uppercase px-2 py-1 rounded text-app-text-muted hover:text-app-text transition-colors"
								>
									No
								</button>
							</span>
						)}
					</div>
					{tune.settings && <TuneSettingsPanel settings={tune.settings} />}
				</div>
			)}
		</div>
	);
}

// ── TuneForm (tabbed full-page) ───────────────────────────────────────────────

export function TuneForm({
	initialData,
	onSubmit,
	onCancel,
	title,
	isSubmitting,
}: {
	initialData?: Partial<TuneFormData>;
	onSubmit: (data: TuneFormData) => void;
	onCancel: () => void;
	title: string;
	isSubmitting: boolean;
}) {
	const [name, setName] = useState(initialData?.name ?? "");
	const [author, setAuthor] = useState(initialData?.author ?? "Me");
	const [carOrdinal, setCarOrdinal] = useState(initialData?.carOrdinal ?? 2860);
	const [category, setCategory] = useState<TuneCategory>(
		initialData?.category ?? "circuit",
	);
	const [description, setDescription] = useState(
		initialData?.description ?? "",
	);
	const [settings, setSettings] = useState<TuneSettings>(
		withDefaults(initialData?.settings),
	);
	const [drivetrain, setDrivetrain] = useState<"rwd" | "fwd" | "awd">(
		initialData?.settings?.drivetrain ?? "rwd",
	);
	const [activeTab, setActiveTab] = useState<"info" | "settings">("settings");
	const [jsonMode, setJsonMode] = useState(false);
	const [jsonText, setJsonText] = useState("");
	const [jsonError, setJsonError] = useState("");
	const { displaySettings } = useSettings();
	const [isMetric, setIsMetric] = useState(() => {
		const u = initialData?.settings?.springs?.unit;
		const au = initialData?.settings?.aero?.unit;
		if (u || au) return u !== "lb/in" && au !== "lb";
		return displaySettings.unit !== "imperial";
	});
	const [carSearchQuery, setCarSearchQuery] = useState("");
	const [carDropOpen, setCarDropOpen] = useState(false);
	const { data: allCars = [] } = useAllCars();

	const filteredFormCars = carSearchQuery
		? allCars
				.filter((c) =>
					c.name.toLowerCase().includes(carSearchQuery.toLowerCase()),
				)
				.slice(0, 20)
		: allCars.slice(0, 20);

	const selectedCarName =
		allCars.find((c) => c.ordinal === carOrdinal)?.name ??
		(carOrdinal ? `Car #${carOrdinal}` : "Select car...");

	useEffect(() => {
		setName(initialData?.name ?? "");
		setAuthor(initialData?.author ?? "Me");
		setCarOrdinal(initialData?.carOrdinal ?? 2860);
		setCategory(initialData?.category ?? "circuit");
		setDescription(initialData?.description ?? "");
		setSettings(withDefaults(initialData?.settings));
		setDrivetrain(initialData?.settings?.drivetrain ?? "rwd");
		setActiveTab("info");
		setJsonMode(false);
		setJsonText("");
		setJsonError("");
		const u = initialData?.settings?.springs?.unit;
		const au = initialData?.settings?.aero?.unit;
		if (u || au) {
			setIsMetric(u !== "lb/in" && au !== "lb");
		} else {
			setIsMetric(displaySettings.unit !== "imperial");
		}
	}, [initialData, displaySettings.unit]);

	const updateSettings = <K extends keyof TuneSettings>(
		group: K,
		field: string,
		value: number,
	) => {
		setSettings((prev) => ({
			...prev,
			[group]: { ...(prev[group] as object), [field]: value },
		}));
	};

	const switchUnitSystem = (nextIsMetric: boolean) => {
		if (nextIsMetric === isMetric) return;
		setSettings((prev) => {
			const convert = (value: number, cat: ConvCategory) =>
				nextIsMetric
					? fromDisplay(value, cat, false)
					: toDisplay(value, cat, false);
			return {
				...prev,
				tires: {
					...prev.tires,
					frontPressure: convert(prev.tires.frontPressure, "tires"),
					rearPressure: convert(prev.tires.rearPressure, "tires"),
				},
				springs: {
					...prev.springs,
					frontRate: convert(prev.springs.frontRate, "springs"),
					rearRate: convert(prev.springs.rearRate, "springs"),
					frontHeight: convert(prev.springs.frontHeight, "height"),
					rearHeight: convert(prev.springs.rearHeight, "height"),
				},
				rollCenterHeight: {
					front: convert(prev.rollCenterHeight.front, "height"),
					rear: convert(prev.rollCenterHeight.rear, "height"),
				},
				aero: {
					...prev.aero,
					frontDownforce: convert(prev.aero.frontDownforce, "aero"),
					rearDownforce: convert(prev.aero.rearDownforce, "aero"),
				},
			};
		});
		setIsMetric(nextIsMetric);
	};

	const parseTuneJson = (rawText: string) => {
		const parsed = JSON.parse(rawText);
		const s = parsed.settings ?? parsed;
		const required = [
			"tires",
			"gearing",
			"alignment",
			"antiRollBars",
			"springs",
			"damping",
			"aero",
			"differential",
			"brakes",
		];
		for (const key of required) {
			if (!s[key]) throw new Error(`Missing section: ${key}`);
		}
		const normalizedSettings = {
			...s,
			springs: {
				...s.springs,
				...(parsed.unitSystem === "imperial"
					? { unit: "lb/in" }
					: parsed.unitSystem === "metric"
						? { unit: "kgf/mm" }
						: {}),
			},
			aero: {
				...s.aero,
				...(parsed.unitSystem === "imperial"
					? { unit: "lb" }
					: parsed.unitSystem === "metric"
						? { unit: "kgf" }
						: {}),
			},
		};
		setSettings(withDefaults(normalizedSettings));
		const isImperialByPayload = parsed.unitSystem === "imperial";
		setIsMetric(
			isImperialByPayload
				? false
				: s.springs?.unit !== "lb/in" && s.aero?.unit !== "lb",
		);
		if (parsed.name) setName(parsed.name);
		if (parsed.author) setAuthor(parsed.author);
		if (parsed.category) setCategory(parsed.category);
		if (parsed.description) setDescription(parsed.description);
		setJsonError("");
		setJsonMode(false);
	};

	const handleJsonParse = () => {
		try {
			parseTuneJson(jsonText);
		} catch (err: unknown) {
			setJsonError(err instanceof Error ? err.message : "Invalid JSON");
		}
	};

	const handleJsonFileImport = async (
		e: React.ChangeEvent<HTMLInputElement>,
	) => {
		const file = e.target.files?.[0];
		if (!file) return;
		try {
			const text = await file.text();
			setJsonText(text);
			parseTuneJson(text);
		} catch (err: unknown) {
			setJsonError(err instanceof Error ? err.message : "Invalid JSON file");
		}
		e.target.value = "";
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const savedSettings: TuneSettings = {
			...settings,
			drivetrain,
			springs: { ...settings.springs, unit: unitLabel("springs", isMetric) },
			aero: { ...settings.aero, unit: unitLabel("aero", isMetric) },
		};
		onSubmit({
			name,
			author,
			carOrdinal,
			category,
			description,
			settings: savedSettings,
			unitSystem: isMetric ? "metric" : "imperial",
		});
	};

	const tabCls = (tab: "info" | "settings") =>
		`px-3 py-1 text-xs font-medium rounded transition-colors ${
			activeTab === tab
				? "bg-app-accent/15 text-app-accent"
				: "text-app-text-muted hover:text-app-text"
		}`;

	return (
		<form onSubmit={handleSubmit} className="flex flex-col min-h-full">
			{/* Sticky header — title, tabs, and actions in one bar */}
			<div className="sticky top-0 z-10 bg-app-bg border-b border-app-border flex items-center gap-3 px-4 py-2">
				<Button
					type="button"
					variant="app-ghost"
					size="app-sm"
					onClick={onCancel}
				>
					&larr;
				</Button>
				<h2 className="text-sm font-semibold text-app-text">{title}</h2>
				<div className="flex items-center gap-1 ml-2">
					<button
						type="button"
						className={tabCls("info")}
						onClick={() => setActiveTab("info")}
					>
						Info
					</button>
					<button
						type="button"
						className={tabCls("settings")}
						onClick={() => setActiveTab("settings")}
					>
						Settings
					</button>
				</div>
				<div className="flex items-center gap-2 ml-auto">
					<Button
						type="button"
						variant="app-outline"
						size="app-sm"
						onClick={onCancel}
					>
						Cancel
					</Button>
					<Button
						type="submit"
						variant="app-primary"
						size="app-sm"
						disabled={!name || isSubmitting}
					>
						{isSubmitting ? "Saving..." : "Save Tune"}
					</Button>
				</div>
			</div>

			{/* Info tab */}
			{activeTab === "info" && (
				<div className="p-6 grid grid-cols-2 gap-4 max-w-2xl">
					<label className="col-span-2 space-y-1">
						<span className="text-xs font-medium text-app-text-muted">
							Name
						</span>
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
						/>
					</label>
					<label className="space-y-1">
						<span className="text-xs font-medium text-app-text-muted">
							Author
						</span>
						<input
							type="text"
							value={author}
							onChange={(e) => setAuthor(e.target.value)}
							required
							className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
						/>
					</label>
					<div className="space-y-1 relative">
						<span className="text-xs font-medium text-app-text-muted">Car</span>
						<input
							type="text"
							value={carDropOpen ? carSearchQuery : selectedCarName}
							onChange={(e) => {
								setCarSearchQuery(e.target.value);
								setCarDropOpen(true);
							}}
							onFocus={() => {
								setCarDropOpen(true);
								setCarSearchQuery("");
							}}
							onBlur={() => setTimeout(() => setCarDropOpen(false), 150)}
							placeholder="Search car..."
							className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
						/>
						{carDropOpen && (
							<div className="absolute left-0 right-0 mt-1 max-h-48 overflow-auto rounded-lg bg-app-surface border border-app-border z-50 shadow-lg">
								{filteredFormCars.map((c) => (
									<button
										key={c.ordinal}
										type="button"
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => {
											setCarOrdinal(c.ordinal);
											setCarSearchQuery("");
											setCarDropOpen(false);
										}}
										className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${carOrdinal === c.ordinal ? "text-app-accent" : "text-app-text"}`}
									>
										{c.name}
									</button>
								))}
								{filteredFormCars.length === 0 && (
									<div className="px-3 py-2 text-xs text-app-text-muted">
										No cars found
									</div>
								)}
							</div>
						)}
					</div>
					<label className="space-y-1">
						<span className="text-xs font-medium text-app-text-muted">
							Category
						</span>
						<select
							value={category}
							onChange={(e) => setCategory(e.target.value as TuneCategory)}
							className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
						>
							{ALL_CATEGORIES.map((c) => (
								<option key={c} value={c}>
									{CATEGORY_LABELS[c]}
								</option>
							))}
						</select>
					</label>
					<label className="space-y-1">
						<span className="text-xs font-medium text-app-text-muted">
							Drivetrain
						</span>
						<select
							value={drivetrain}
							onChange={(e) =>
								setDrivetrain(e.target.value as "rwd" | "fwd" | "awd")
							}
							className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
						>
							<option value="rwd">RWD</option>
							<option value="fwd">FWD</option>
							<option value="awd">AWD</option>
						</select>
					</label>
					<label className="col-span-2 space-y-1">
						<span className="text-xs font-medium text-app-text-muted">
							Description
						</span>
						<input
							type="text"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
						/>
					</label>
					{(() => {
						const carData = allCars.find((c) => c.ordinal === carOrdinal);
						if (!carData?.specs) return null;
						const s = carData.specs;
						return (
							<div className="col-span-2 rounded-lg bg-app-surface ring-1 ring-app-border overflow-hidden">
								<div className="p-3 grid grid-cols-3 gap-x-4 gap-y-2">
									{s.hp > 0 && (
										<div className="flex flex-col">
											<span className="text-[10px] text-app-text-muted uppercase tracking-wide">
												Power
											</span>
											<span className="text-xs font-mono text-app-text">
												{s.hp} hp
											</span>
										</div>
									)}
									{s.torque > 0 && (
										<div className="flex flex-col">
											<span className="text-[10px] text-app-text-muted uppercase tracking-wide">
												Torque
											</span>
											<span className="text-xs font-mono text-app-text">
												{s.torque} lb-ft
											</span>
										</div>
									)}
									{s.weightKg > 0 && (
										<div className="flex flex-col">
											<span className="text-[10px] text-app-text-muted uppercase tracking-wide">
												Weight
											</span>
											<span className="text-xs font-mono text-app-text">
												{s.weightKg} kg
											</span>
										</div>
									)}
									{s.engine && (
										<div className="flex flex-col">
											<span className="text-[10px] text-app-text-muted uppercase tracking-wide">
												Engine
											</span>
											<span className="text-xs font-mono text-app-text truncate">
												{s.engine}
												{s.aspiration && s.aspiration !== "NA"
													? ` · ${s.aspiration}`
													: ""}
											</span>
										</div>
									)}
									{s.topSpeedMph > 0 && (
										<div className="flex flex-col">
											<span className="text-[10px] text-app-text-muted uppercase tracking-wide">
												Top Speed
											</span>
											<span className="text-xs font-mono text-app-text">
												{Math.round(s.topSpeedMph * 1.60934)} km/h
											</span>
										</div>
									)}
									{s.division && (
										<div className="flex flex-col">
											<span className="text-[10px] text-app-text-muted uppercase tracking-wide">
												Division
											</span>
											<span className="text-xs text-app-text truncate">
												{s.division}
											</span>
										</div>
									)}
								</div>
								{s.imageUrl && (
									<img
										src={s.imageUrl}
										alt={carData.name}
										className="w-full object-contain bg-black"
										onError={(e) => {
											(e.target as HTMLImageElement).style.display = "none";
										}}
									/>
								)}
							</div>
						);
					})()}
				</div>
			)}

			{/* Settings tab */}
			{activeTab === "settings" && (
				<div className="p-6 space-y-4">
					<div className="flex items-center justify-between">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-app-text-muted">
							Tune Parameters
						</h3>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => setJsonMode(false)}
								className="hidden"
							>
								JSON Import
							</button>
							{!jsonMode && (
								<div className="flex rounded-md ring-1 ring-app-border overflow-hidden">
									<button
										type="button"
										onClick={() => switchUnitSystem(true)}
										className={`text-[10px] font-semibold px-2.5 py-1 transition-colors ${isMetric ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"}`}
									>
										Metric
									</button>
									<button
										type="button"
										onClick={() => switchUnitSystem(false)}
										className={`text-[10px] font-semibold px-2.5 py-1 transition-colors ${!isMetric ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"}`}
									>
										Imperial
									</button>
								</div>
							)}
						</div>
					</div>

					{jsonMode ? (
						<div className="space-y-2">
							<div className="flex items-center gap-2">
								<label className="text-xs px-3 py-1.5 rounded bg-app-surface ring-1 ring-app-border text-app-text cursor-pointer hover:bg-app-surface-alt transition-colors">
									Import JSON File
									<input
										type="file"
										accept=".json,application/json"
										onChange={handleJsonFileImport}
										className="hidden"
									/>
								</label>
							</div>
							<textarea
								value={jsonText}
								onChange={(e) => {
									setJsonText(e.target.value);
									setJsonError("");
								}}
								placeholder="Paste tune JSON..."
								rows={10}
								className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs text-app-text font-mono focus:outline-none focus:ring-1 focus:ring-app-accent resize-y"
							/>
							{jsonError && <p className="text-xs text-red-400">{jsonError}</p>}
							<button
								type="button"
								onClick={handleJsonParse}
								className="text-xs px-3 py-1.5 rounded bg-app-accent/20 text-app-accent hover:bg-app-accent/30 transition-colors"
							>
								Parse & Populate
							</button>
						</div>
					) : (
						<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
							<div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
								<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
									Tires
								</h4>
								<NumberField
									label="Front Pressure"
									value={settings.tires.frontPressure}
									onChange={(v) => updateSettings("tires", "frontPressure", v)}
									step={isMetric ? 0.01 : 0.1}
									unit={unitLabel("tires", isMetric)}
								/>
								<NumberField
									label="Rear Pressure"
									value={settings.tires.rearPressure}
									onChange={(v) => updateSettings("tires", "rearPressure", v)}
									step={isMetric ? 0.01 : 0.1}
									unit={unitLabel("tires", isMetric)}
								/>
							</div>

							<div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
								<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
									Gearing
								</h4>
								<NumberField
									label="Final Drive"
									value={settings.gearing.finalDrive}
									onChange={(v) => updateSettings("gearing", "finalDrive", v)}
									step={0.01}
									unit=":1"
								/>
								<NumberField
									label="Top Speed"
									value={
										settings.gearing.topSpeedKph ??
										Math.round(
											(allCars.find((c) => c.ordinal === carOrdinal)?.specs
												?.topSpeedMph ?? 0) * 1.60934,
										)
									}
									onChange={(v) =>
										setSettings((s) => ({
											...s,
											gearing: { ...s.gearing, topSpeedKph: v },
										}))
									}
									step={1}
									unit="km/h"
								/>
								<div className="space-y-1 pt-1">
									<div className="flex items-center justify-between">
										<span className="text-xs text-app-text-muted">
											Gear Ratios
										</span>
										<select
											value={settings.gearing.ratios?.length ?? 6}
											onChange={(e) => {
												const count = parseInt(e.target.value);
												const current = settings.gearing.ratios ?? [];
												const ratios = Array.from(
													{ length: count },
													(_, i) => current[i] ?? 3.5 - i * 0.4,
												);
												setSettings((s) => ({
													...s,
													gearing: { ...s.gearing, ratios },
												}));
											}}
											className="bg-app-bg border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text"
										>
											{[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
												<option key={n} value={n}>
													{n} gears
												</option>
											))}
										</select>
									</div>
									{(settings.gearing.ratios ?? []).map((ratio, i) => {
										const topSpeedKph =
											settings.gearing.topSpeedKph ??
											Math.round(
												(allCars.find((c) => c.ordinal === carOrdinal)?.specs
													?.topSpeedMph ?? 0) * 1.60934,
											);
										const topGearRatio = (settings.gearing.ratios ?? [])[
											(settings.gearing.ratios ?? []).length - 1
										];
										const CIRC =
											topSpeedKph && topGearRatio
												? (topSpeedKph *
														topGearRatio *
														settings.gearing.finalDrive) /
													(8000 / 60) /
													3.6
												: 2.0;
										const gearTopKph =
											(8000 / 60 / (ratio * settings.gearing.finalDrive)) *
											CIRC *
											3.6;
										return (
											<label
												key={i}
												className="flex items-center justify-between gap-2 text-xs"
											>
												<span className="text-app-text-muted whitespace-nowrap">
													Gear {i + 1}
												</span>
												<div className="flex items-center gap-1">
													<span className="text-[10px] text-app-text-muted font-mono tabular-nums w-14 text-right">
														{Math.round(gearTopKph)} km/h
													</span>
													<input
														type="number"
														value={ratio}
														step={0.01}
														onChange={(e) => {
															const ratios = [
																...(settings.gearing.ratios ?? []),
															];
															ratios[i] = parseFloat(e.target.value) || 0;
															setSettings((s) => ({
																...s,
																gearing: { ...s.gearing, ratios },
															}));
														}}
														className="w-20 bg-app-bg border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text font-mono text-right focus:outline-none focus:ring-1 focus:ring-app-accent"
													/>
													<span className="text-[10px] text-app-text-muted w-8">
														:1
													</span>
												</div>
											</label>
										);
									})}
									<GearRatioChart
										ratios={settings.gearing.ratios ?? []}
										finalDrive={settings.gearing.finalDrive}
										topSpeedMph={
											(settings.gearing.topSpeedKph ??
												Math.round(
													(allCars.find((c) => c.ordinal === carOrdinal)?.specs
														?.topSpeedMph ?? 0) * 1.60934,
												)) / 1.60934
										}
									/>
								</div>
							</div>

							<div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
								<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
									Alignment
								</h4>
								<NumberField
									label="Front Camber"
									value={settings.alignment.frontCamber}
									onChange={(v) =>
										updateSettings("alignment", "frontCamber", v)
									}
									unit="°"
								/>
								<NumberField
									label="Rear Camber"
									value={settings.alignment.rearCamber}
									onChange={(v) => updateSettings("alignment", "rearCamber", v)}
									unit="°"
								/>
								<NumberField
									label="Front Toe"
									value={settings.alignment.frontToe}
									onChange={(v) => updateSettings("alignment", "frontToe", v)}
									unit="°"
								/>
								<NumberField
									label="Rear Toe"
									value={settings.alignment.rearToe}
									onChange={(v) => updateSettings("alignment", "rearToe", v)}
									unit="°"
								/>
								<NumberField
									label="Front Caster"
									value={settings.alignment.frontCaster ?? 5.0}
									onChange={(v) =>
										updateSettings("alignment", "frontCaster", v)
									}
									unit="°"
								/>
							</div>

							<div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
								<div className="flex items-center justify-between mb-2">
									<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent">
										Anti-Roll Bars
									</h4>
									<span className="text-[10px] text-app-text-muted">
										soft → stiff
									</span>
								</div>
								<NumberField
									label="Front"
									value={settings.antiRollBars.front}
									onChange={(v) => updateSettings("antiRollBars", "front", v)}
								/>
								<NumberField
									label="Rear"
									value={settings.antiRollBars.rear}
									onChange={(v) => updateSettings("antiRollBars", "rear", v)}
								/>
							</div>

							<div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
								<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
									Springs
								</h4>
								<NumberField
									label="Front Rate"
									value={settings.springs.frontRate}
									onChange={(v) => updateSettings("springs", "frontRate", v)}
									step={isMetric ? 0.1 : 1}
									unit={unitLabel("springs", isMetric)}
								/>
								<NumberField
									label="Rear Rate"
									value={settings.springs.rearRate}
									onChange={(v) => updateSettings("springs", "rearRate", v)}
									step={isMetric ? 0.1 : 1}
									unit={unitLabel("springs", isMetric)}
								/>
								<NumberField
									label="Front Height"
									value={settings.springs.frontHeight}
									onChange={(v) => updateSettings("springs", "frontHeight", v)}
									step={0.1}
									unit={unitLabel("height", isMetric)}
								/>
								<NumberField
									label="Rear Height"
									value={settings.springs.rearHeight}
									onChange={(v) => updateSettings("springs", "rearHeight", v)}
									step={0.1}
									unit={unitLabel("height", isMetric)}
								/>
							</div>

							<div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
								<div className="flex items-center justify-between mb-2">
									<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent">
										Damping
									</h4>
									<span className="text-[10px] text-app-text-muted">
										soft → stiff
									</span>
								</div>
								<NumberField
									label="Front Bump"
									value={settings.damping.frontBump}
									onChange={(v) => updateSettings("damping", "frontBump", v)}
								/>
								<NumberField
									label="Rear Bump"
									value={settings.damping.rearBump}
									onChange={(v) => updateSettings("damping", "rearBump", v)}
								/>
								<NumberField
									label="Front Rebound"
									value={settings.damping.frontRebound}
									onChange={(v) => updateSettings("damping", "frontRebound", v)}
								/>
								<NumberField
									label="Rear Rebound"
									value={settings.damping.rearRebound}
									onChange={(v) => updateSettings("damping", "rearRebound", v)}
								/>
							</div>

							<div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
								<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
									Roll Center Height
								</h4>
								<NumberField
									label="Front"
									value={settings.rollCenterHeight.front}
									onChange={(v) =>
										setSettings((s) => ({
											...s,
											rollCenterHeight: { ...s.rollCenterHeight, front: v },
										}))
									}
									unit={unitLabel("height", isMetric)}
								/>
								<NumberField
									label="Rear"
									value={settings.rollCenterHeight.rear}
									onChange={(v) =>
										setSettings((s) => ({
											...s,
											rollCenterHeight: { ...s.rollCenterHeight, rear: v },
										}))
									}
									unit={unitLabel("height", isMetric)}
								/>
							</div>

							<div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
								<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
									Anti-Geometry
								</h4>
								<NumberField
									label="Anti-dive (front)"
									value={settings.antiGeometry.antiDiveFront}
									onChange={(v) =>
										setSettings((s) => ({
											...s,
											antiGeometry: { ...s.antiGeometry, antiDiveFront: v },
										}))
									}
									unit="%"
								/>
								<NumberField
									label="Anti-squat (rear)"
									value={settings.antiGeometry.antiSquatRear}
									onChange={(v) =>
										setSettings((s) => ({
											...s,
											antiGeometry: { ...s.antiGeometry, antiSquatRear: v },
										}))
									}
									unit="%"
								/>
							</div>

							<div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
								<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
									Aero
								</h4>
								<NumberField
									label="Front Downforce"
									value={settings.aero.frontDownforce}
									onChange={(v) => updateSettings("aero", "frontDownforce", v)}
									step={1}
									unit={unitLabel("aero", isMetric)}
								/>
								<NumberField
									label="Rear Downforce"
									value={settings.aero.rearDownforce}
									onChange={(v) => updateSettings("aero", "rearDownforce", v)}
									step={1}
									unit={unitLabel("aero", isMetric)}
								/>
							</div>

							<div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
								<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
									Differential
								</h4>
								{(drivetrain === "rwd" || drivetrain === "awd") && (
									<>
										<NumberField
											label="Rear Accel"
											value={settings.differential.rearAccel}
											onChange={(v) =>
												updateSettings("differential", "rearAccel", v)
											}
											step={1}
											unit="%"
										/>
										<NumberField
											label="Rear Decel"
											value={settings.differential.rearDecel}
											onChange={(v) =>
												updateSettings("differential", "rearDecel", v)
											}
											step={1}
											unit="%"
										/>
									</>
								)}
								{(drivetrain === "fwd" || drivetrain === "awd") && (
									<>
										<NumberField
											label="Front Accel"
											value={settings.differential.frontAccel ?? 0}
											onChange={(v) =>
												updateSettings("differential", "frontAccel", v)
											}
											step={1}
											unit="%"
										/>
										<NumberField
											label="Front Decel"
											value={settings.differential.frontDecel ?? 0}
											onChange={(v) =>
												updateSettings("differential", "frontDecel", v)
											}
											step={1}
											unit="%"
										/>
									</>
								)}
								{drivetrain === "awd" && (
									<NumberField
										label="Center"
										value={settings.differential.center ?? 50}
										onChange={(v) =>
											updateSettings("differential", "center", v)
										}
										step={1}
										unit="%"
									/>
								)}
							</div>

							<div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
								<h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
									Brakes
								</h4>
								<NumberField
									label="Balance"
									value={settings.brakes.balance}
									onChange={(v) => updateSettings("brakes", "balance", v)}
									step={1}
									unit="%"
								/>
								<NumberField
									label="Pressure"
									value={settings.brakes.pressure}
									onChange={(v) => updateSettings("brakes", "pressure", v)}
									step={1}
									unit="%"
								/>
							</div>
						</div>
					)}
				</div>
			)}
		</form>
	);
}
