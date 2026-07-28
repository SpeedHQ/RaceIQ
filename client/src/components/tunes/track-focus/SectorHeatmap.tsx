import type { LapMeta } from "@shared/types";
import { useMemo } from "react";

interface SectorHeatmapProps {
  laps: LapMeta[];
  focusLapId: number | null;
  onFocusLap: (lapId: number) => void;
}

function cellColor(delta: number | null): string {
  if (delta == null) return "#334155";
  const a = Math.abs(delta);
  if (a < 0.15) return "var(--color-dynamics-green, #34d399)";
  if (a < 0.4) return "var(--color-dynamics-amber, #f59e0b)";
  return "var(--color-dynamics-red, #ef4444)";
}

/**
 * 3-row (sector) x N-column (lap) delta heatmap: each cell is that lap's
 * sector time minus the stint's best valid time for that sector. Gray when
 * the lap is invalid or missing the sector. Click a column to focus that lap.
 */
export function SectorHeatmap({ laps, focusLapId, onFocusLap }: SectorHeatmapProps) {
  const sectorCount = laps.reduce((count, lap) => Math.max(count, lap.sectorTimes?.length ?? 0), 0);
  const bestBySector = useMemo(() => {
    return Array.from({ length: sectorCount }, (_, sectorIndex) => {
      let best: number | null = null;
      for (const lap of laps) {
        if (!lap.isValid || lap.tuningExcluded) continue;
        const v = lap.sectorTimes?.[sectorIndex];
        if (v != null && (best == null || v < best)) best = v;
      }
      return best;
    });
  }, [laps, sectorCount]);

  if (laps.length === 0) {
    return <div className="text-app-text-dim text-sm">No laps to compare.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse w-full text-[11px]">
        <thead>
          <tr>
            <th className="text-left text-app-text-muted font-semibold pr-2 pb-1 sticky left-0 bg-app-surface">Lap</th>
            {laps.map((lap) => (
              <th key={lap.id} className="text-app-text-dim font-normal px-1 pb-1 text-center min-w-[34px]">
                {lap.lapNumber}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: sectorCount }, (_, si) => `S${si + 1}`).map((label, si) => (
            <tr key={label}>
              <td className="text-app-text-muted font-semibold pr-2 py-0.5 sticky left-0 bg-app-surface">{label}</td>
              {laps.map((lap) => {
                const raw = lap.sectorTimes?.[si];
                const best = bestBySector[si];
                const delta = lap.isValid && raw != null && best != null ? raw - best : null;
                const isFocus = lap.id === focusLapId;
                return (
                  <td key={lap.id} className="p-0.5">
                    <button
                      type="button"
                      title={`S${si + 1} L${lap.lapNumber} ${delta == null ? "n/a" : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}s`}`}
                      onClick={() => onFocusLap(lap.id)}
                      className="w-full h-6 rounded-sm block"
                      style={{
                        background: cellColor(delta),
                        opacity: delta == null ? 0.3 : 0.85,
                        outline: isFocus ? "2px solid var(--color-app-accent, #22d3ee)" : "none",
                        outlineOffset: -2,
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
