import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { resolveWheelMetric } from "../../../../shared/racing/analysis/metric-values";
import { suspensionCompressionBias } from "../../../../shared/racing/analysis/laps/physics/vehicle";
import { Info } from "lucide-react";
import { operatingRangeColor } from "../../lib/colors";
import { m } from "../../paraglide/messages";
import type { SemanticAnalysisFrame } from "./track-map/types";
import { WheelTable } from "./WheelTable";

interface Props { frame: SemanticAnalysisFrame; gameId: import("../../../../shared/games/ids").GameId; }
const unavailable = <span className="text-app-text-dim">—</span>;

export function AnalyseSuspensionPanel({ frame, gameId }: Props) {
  const analysis = resolveAnalysisTelemetry(getGame(gameId));
  const normalizedValues = resolveWheelMetric(frame, { kind: "value", semanticId: "suspension.norm-suspension-travel" });
  const millimeterValues = analysis.suspensionTravel.source !== "unavailable" && analysis.suspensionTravel.binding?.kind === "value" && analysis.suspensionTravel.display === "millimeters" ? resolveWheelMetric(frame, analysis.suspensionTravel.binding).map((value) => value == null ? null : value * 1000) : [null, null, null, null];
  const normalized = normalizedValues as [number | null, number | null, number | null, number | null];
  const millimeters = millimeterValues as [number | null, number | null, number | null, number | null];
  const showMillimeters = analysis.suspensionTravel.source !== "unavailable" && analysis.suspensionTravel.display === "millimeters";
  const bias = analysis.suspensionCompressionBias.source !== "unavailable" && normalized.every((value): value is number => value != null)
    ? suspensionCompressionBias([normalized[0]!, normalized[1]!, normalized[2]!, normalized[3]!])
    : null;
  const title = <span className="flex items-center gap-1 group relative">{m.dataguide_suspension()}<Info className="w-3 h-3 text-app-text-dim cursor-help inline" /><span className="absolute left-0 bottom-full mb-2 hidden group-hover:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1 text-app-caption text-app-text-secondary whitespace-nowrap z-10 pointer-events-none normal-case tracking-normal">{m.analyse_suspension_compression_tooltip()}</span></span>;
  const cell = (index: number) => showMillimeters ? (millimeters[index] == null ? unavailable : `${Math.round(millimeters[index]!)}mm`) : (normalized[index] == null ? unavailable : <span style={{ color: operatingRangeColor(normalized[index]!, [0.25, 0.65, 0.85]) }}>{`${(normalized[index]! * 100).toFixed(0)}%`}</span>);
  return <WheelTable title={title} borderTop rows={[{ label: m.dataguide_travel(), fl: cell(0), fr: cell(1), rl: cell(2), rr: cell(3) }, { label: m.analyse_suspension_compression_bias(), fl: bias == null ? unavailable : `${m.analyse_suspension_front()} ${(bias.front * 100).toFixed(0)}%`, rl: bias == null ? unavailable : `${m.analyse_suspension_left()} ${(bias.left * 100).toFixed(0)}%`, fr: "", rr: "", span2: true }]} />;
}
