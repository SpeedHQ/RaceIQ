import type { F1ExtendedData } from "@shared/types";
import { m } from "@/paraglide/messages";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/AppTable";

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
        <span className="text-app-label text-app-text-muted font-medium">
          {m.f1grid_section_standings()} &mdash; {f1.sessionType?.replace("-", " ").toUpperCase() ?? m.f1grid_session_fallback()}
          {f1.totalLaps > 0 && ` (${f1.totalLaps} ${m.label_laps()})`}
        </span>
      </div>
      <Table fit className="rounded-none overflow-y-auto max-h-[400px]">
        <TableHeader className="bg-app-surface" rowClassName="text-app-text-dim border-b border-app-border">
          <TableHead className="px-2 py-1 text-left w-8">{m.f1grid_header_position()}</TableHead>
          <TableHead className="px-2 py-1 text-left">{m.f1grid_header_driver()}</TableHead>
          <TableHead className="px-2 py-1 text-right">{m.label_delta()}</TableHead>
          <TableHead className="px-2 py-1 text-right">{m.f1grid_header_interval()}</TableHead>
          <TableHead className="px-2 py-1 text-right">{m.label_best()}</TableHead>
          <TableHead className="px-2 py-1 text-center w-6">{m.label_tires()}</TableHead>
          <TableHead className="px-2 py-1 text-right w-8">{m.f1grid_header_age()}</TableHead>
          <TableHead className="px-2 py-1 text-center w-8">{m.f1grid_header_pit()}</TableHead>
        </TableHeader>
        <TableBody className="divide-y-0">
          {sorted.map((entry) => {
            const isPlayer = entry.name !== "" && playerCarIndex !== undefined;
            return (
              <TableRow key={entry.position} className={`border-b border-app-border/50 hover:bg-app-surface-hover/50 ${isPlayer ? "" : ""}`}>
                <TableCell className="px-2 py-1 font-bold text-app-text-secondary">{entry.position}</TableCell>
                <TableCell className="px-2 py-1 text-app-text truncate max-w-[120px]">{entry.name || `${m.label_car()} ${entry.position}`}</TableCell>
                <TableCell className="px-2 py-1 text-right text-app-text-muted tabular-nums">{entry.position === 1 ? m.f1grid_leader() : formatGap(entry.gapToLeader)}</TableCell>
                <TableCell className="px-2 py-1 text-right text-app-text-muted tabular-nums">{formatGap(entry.gapToCarAhead)}</TableCell>
                <TableCell className="px-2 py-1 text-right text-app-text-secondary tabular-nums">{formatTime(entry.bestLapTime)}</TableCell>
                <TableCell className="px-2 py-1 text-center">
                  <span className="tire-compound-dot inline-block w-2.5 h-2.5 rounded-full" data-tire-compound={(entry.tyreCompound || "unknown").toLowerCase()} />
                </TableCell>
                <TableCell className="px-2 py-1 text-right text-app-text-dim tabular-nums">{entry.tyreAge}</TableCell>
                <TableCell className="px-2 py-1 text-center text-app-text-dim">
                  {entry.pitStatus === 1 ? m.f1grid_pit_in() : entry.pitStatus === 2 ? m.f1grid_pit_pitting() : entry.numPitStops > 0 ? entry.numPitStops : ""}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
