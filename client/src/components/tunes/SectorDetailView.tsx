import type { TelemetryPacket, TuneIssue } from "@shared/types";
import { useState } from "react";
import { SectorMap } from "./SectorMap";
import { bandColor, buildSectorRanges, CORNERS, CornerBars, type CornerKey, METRICS } from "./SectorRangeBreakdown";

interface SectorTimes {
  times: [number, number, number];
  s1Idx: number;
  s2Idx: number;
}

interface SectorDetailViewProps {
  telemetry: TelemetryPacket[];
  sectorTimes: SectorTimes | null;
  sectorIndex: number;
  trackOrdinal?: number;
  issues: TuneIssue[];
}

const SECTOR_COLORS = ["#f87171", "#60a5fa", "#facc15"] as const;
const SEVERITY_CLASS: Record<TuneIssue["severity"], string> = {
  critical: "text-red-400 border-red-800/60 bg-red-950/30",
  warn: "text-amber-400 border-amber-800/60 bg-amber-950/30",
  info: "text-sky-400 border-sky-800/60 bg-sky-950/30",
};

/**
 * SectorDetailView — deep dive on a single sector: a large hover-scrubbable map
 * of the lap with this sector lit, every metric's per-corner range for the
 * sector (temps, brakes, pressure, wear), and the issues located here. Hovering
 * the map scrubs a cursor line across all the metric bars at once.
 */
export function SectorDetailView({ telemetry, sectorTimes, sectorIndex, trackOrdinal, issues }: SectorDetailViewProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [markFrac, setMarkFrac] = useState<number | null>(null);
  const cursorFrame = hoverIdx != null ? telemetry[hoverIdx] : null;

  const readout = (frame: TelemetryPacket) =>
    CORNERS.map((c) => {
      const v = METRICS[0].sel[c](frame);
      const ok = v != null && Number.isFinite(v);
      return { label: c, value: ok ? `${v!.toFixed(1)} °C` : "—", color: ok ? bandColor(v!) : undefined };
    });

  const cursorFor = (sel: Record<CornerKey, (p: TelemetryPacket) => number | undefined>): Partial<Record<CornerKey, number>> | undefined => {
    if (!cursorFrame) return undefined;
    const out: Partial<Record<CornerKey, number>> = {};
    for (const c of CORNERS) {
      const v = sel[c](cursorFrame);
      if (v != null && Number.isFinite(v)) out[c] = v;
    }
    return out;
  };

  const sectorTime = sectorTimes && sectorTimes.times[sectorIndex] > 0 ? sectorTimes.times[sectorIndex].toFixed(3) : "—";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2">
      {/* Map + issues */}
      <div className="lg:border-r border-app-border">
        <div className="flex items-center justify-between px-4 py-2 border-b border-app-border">
          <div className="flex items-center gap-2">
            <span className="w-6 h-1 rounded" style={{ background: SECTOR_COLORS[sectorIndex] }} />
            <span className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Sector {sectorIndex + 1}</span>
          </div>
          <span className="text-lg font-mono tabular-nums text-app-text">{sectorTime}</span>
        </div>
        {telemetry.length > 0 ? (
          <SectorMap
            telemetry={telemetry}
            sectorTimes={sectorTimes}
            highlight={sectorIndex}
            showTimes={false}
            trackOrdinal={trackOrdinal}
            readout={readout}
            onHover={setHoverIdx}
            markFraction={markFrac}
          />
        ) : (
          <div className="p-4 text-xs text-app-text-dim">No telemetry</div>
        )}
        <div className="px-4 py-3 border-t border-app-border">
          <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-2">Issues in this sector</div>
          {issues.length === 0 ? (
            <div className="text-xs text-app-text-dim">No issues located in this sector.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {issues.map((it) => {
                const locatable = it.distanceFrac != null;
                return (
                  <div
                    key={`${it.kind}-${it.corner ?? ""}-${it.detail}`}
                    onMouseEnter={locatable ? () => setMarkFrac(it.distanceFrac!) : undefined}
                    onMouseLeave={locatable ? () => setMarkFrac(null) : undefined}
                    className={`text-xs px-2 py-1 rounded border ${SEVERITY_CLASS[it.severity]} ${locatable ? "cursor-pointer" : ""}`}
                  >
                    <span className="font-mono uppercase mr-1.5 opacity-70">{it.kind}</span>
                    {it.corner ? <span className="font-mono mr-1">{it.corner}</span> : null}
                    {it.detail}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Every metric's range for this sector; hovering the map scrubs all of them */}
      <div className="divide-y divide-app-border">
        {METRICS.map((m) => {
          const model = buildSectorRanges(telemetry, sectorTimes, m);
          if (!model) return null;
          return (
            <div key={m.key} className="p-3">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">{m.label}</span>
                <span className="text-[10px] text-app-text-dim tabular-nums">
                  {Math.round(model.domain[0])}–{Math.round(model.domain[1])} {m.unit}
                </span>
              </div>
              <CornerBars ranges={model.sectors[sectorIndex]} domain={model.domain} metric={m} cursor={cursorFor(m.sel)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
