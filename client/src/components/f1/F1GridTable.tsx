import type { F1ExtendedData } from "@shared/types";
import { m } from "@/paraglide/messages";

function formatGap(gap: number): string {
  if (gap === 0) return "-";
  if (gap < 0) return `-${Math.abs(gap).toFixed(1)}`;
  return `+${gap.toFixed(1)}`;
}

function formatTime(seconds: number): string {
  if (seconds <= 0) return "-";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, "0")}`;
}

export function F1GridTable({ f1, playerCarIndex }: { f1: F1ExtendedData; playerCarIndex?: number }) {
  const sorted = [...f1.grid].sort((a, b) => a.position - b.position);

  return (
    <div className="rounded-lg bg-app-surface overflow-hidden">
      <div className="px-3 py-2 border-b border-app-border">
        <span className="text-xs text-app-text-muted font-medium">
          {m.f1grid_section_standings()} &mdash; {f1.sessionType?.replace("-", " ").toUpperCase() ?? m.f1grid_session_fallback()}
          {f1.totalLaps > 0 && ` (${f1.totalLaps} ${m.label_laps()})`}
        </span>
      </div>
      <div className="overflow-y-auto max-h-[400px]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-app-surface">
            <tr className="text-app-text-dim border-b border-app-border">
              <th className="px-2 py-1 text-left w-8">{m.f1grid_header_position()}</th>
              <th className="px-2 py-1 text-left">{m.f1grid_header_driver()}</th>
              <th className="px-2 py-1 text-right">{m.label_delta()}</th>
              <th className="px-2 py-1 text-right">{m.f1grid_header_interval()}</th>
              <th className="px-2 py-1 text-right">{m.label_best()}</th>
              <th className="px-2 py-1 text-center w-6">{m.label_tires()}</th>
              <th className="px-2 py-1 text-right w-8">{m.f1grid_header_age()}</th>
              <th className="px-2 py-1 text-center w-8">{m.f1grid_header_pit()}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => {
              const isPlayer = entry.name !== "" && playerCarIndex !== undefined;
              return (
                <tr key={entry.position} className={`border-b border-app-border/50 hover:bg-app-surface-hover/50 ${isPlayer ? "" : ""}`}>
                  <td className="px-2 py-1 font-bold text-app-text-secondary">{entry.position}</td>
                  <td className="px-2 py-1 text-app-text truncate max-w-[120px]">{entry.name || `${m.label_car()} ${entry.position}`}</td>
                  <td className="px-2 py-1 text-right text-app-text-muted tabular-nums">{entry.position === 1 ? m.f1grid_leader() : formatGap(entry.gapToLeader)}</td>
                  <td className="px-2 py-1 text-right text-app-text-muted tabular-nums">{formatGap(entry.gapToCarAhead)}</td>
                  <td className="px-2 py-1 text-right text-app-text-secondary tabular-nums">{formatTime(entry.bestLapTime)}</td>
                  <td className="px-2 py-1 text-center">
                    <span className="tire-compound-dot inline-block w-2.5 h-2.5 rounded-full" data-tire-compound={(entry.tyreCompound || "unknown").toLowerCase()} />
                  </td>
                  <td className="px-2 py-1 text-right text-app-text-dim tabular-nums">{entry.tyreAge}</td>
                  <td className="px-2 py-1 text-center text-app-text-dim">
                    {entry.pitStatus === 1 ? m.f1grid_pit_in() : entry.pitStatus === 2 ? m.f1grid_pit_pitting() : entry.numPitStops > 0 ? entry.numPitStops : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
