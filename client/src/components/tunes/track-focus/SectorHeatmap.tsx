import type { LapMeta } from "@shared/types";
import { useMemo } from "react";
import { severityRangeColor } from "@/lib/colors";
import { Table, TBody, TD, TH, THead, TRow } from "../../ui/AppTable";
import { Button } from "../../ui/button";

interface SectorHeatmapProps {
  laps: LapMeta[];
  focusLapId: number | null;
  onFocusLap: (lapId: number) => void;
}

function cellColor(delta: number | null): string {
  if (delta == null) return "var(--app-border)";
  return severityRangeColor(Math.abs(delta), [0.15, 0.4]);
}

/**
 * Source-defined-sector x N-column (lap) delta heatmap: each cell is that lap's
 * sector time minus the stint's best valid time for that sector. Gray when
 * the lap is invalid or missing the sector. Click a column to focus that lap.
 */
export function SectorHeatmap({ laps, focusLapId, onFocusLap }: SectorHeatmapProps) {
  const sectorCount = laps.reduce((count, lap) => Math.max(count, lap.sectorTimes?.length ?? 0), 0);
  const bestBySector = useMemo(() => {
    return Array.from({ length: sectorCount }, (_, sectorIndex) => {
      let best: number | null = null;
      for (const lap of laps) {
        if (!lap.isValid || lap.experimentExcluded) continue;
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
      <Table density="compact" fit variant="embedded">
        <THead>
          <TH sticky="start">Lap</TH>
          {laps.map((lap) => (
            <TH key={lap.id} align="center">
              {lap.lapNumber}
            </TH>
          ))}
        </THead>
        <TBody>
          {Array.from({ length: sectorCount }, (_, si) => `S${si + 1}`).map((label, si) => (
            <TRow key={label}>
              <TD sticky="start" emphasis tone="muted">
                {label}
              </TD>
              {laps.map((lap) => {
                const raw = lap.sectorTimes?.[si];
                const best = bestBySector[si];
                const delta = lap.isValid && raw != null && best != null ? raw - best : null;
                const isFocus = lap.id === focusLapId;
                return (
                  <TD key={lap.id}>
                    <Button
                      variant="app-ghost"
                      size="app-sm"
                      title={`S${si + 1} L${lap.lapNumber} ${delta == null ? "n/a" : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}s`}`}
                      onClick={() => onFocusLap(lap.id)}
                      className="!h-6 !w-full !rounded-sm !border-0 !p-0 block"
                      style={{
                        background: cellColor(delta),
                        opacity: delta == null ? 0.3 : 0.85,
                        outline: isFocus ? "2px solid var(--app-accent)" : "none",
                        outlineOffset: -2,
                      }}
                    />
                  </TD>
                );
              })}
            </TRow>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
