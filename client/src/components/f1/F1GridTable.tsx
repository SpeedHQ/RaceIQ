import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/AppTable";
import { m } from "@/paraglide/messages";
import type { F1ExtendedData } from "../../../../shared/telemetry/f1-2025";

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
      <div className="max-h-[400px] overflow-y-auto">
        <Table density="compact" fit variant="embedded">
          <TableHeader>
            <TableHead>{m.f1grid_header_position()}</TableHead>
            <TableHead>{m.f1grid_header_driver()}</TableHead>
            <TableHead align="end">{m.label_delta()}</TableHead>
            <TableHead align="end">{m.f1grid_header_interval()}</TableHead>
            <TableHead align="end">{m.label_best()}</TableHead>
            <TableHead align="center">{m.label_tires()}</TableHead>
            <TableHead align="end">{m.f1grid_header_age()}</TableHead>
            <TableHead align="center">{m.f1grid_header_pit()}</TableHead>
          </TableHeader>
          <TableBody>
            {sorted.map((entry) => {
              const isPlayer = entry.name !== "" && playerCarIndex !== undefined;
              return (
                <TableRow key={entry.position} selected={isPlayer}>
                  <TableCell emphasis>{entry.position}</TableCell>
                  <TableCell tone="primary" truncate="narrow">
                    {entry.name || `${m.label_car()} ${entry.position}`}
                  </TableCell>
                  <TableCell align="end" numeric tone="muted">
                    {entry.position === 1 ? m.f1grid_leader() : formatGap(entry.gapToLeader)}
                  </TableCell>
                  <TableCell align="end" numeric tone="muted">
                    {formatGap(entry.gapToCarAhead)}
                  </TableCell>
                  <TableCell align="end" numeric>
                    {formatTime(entry.bestLapTime)}
                  </TableCell>
                  <TableCell align="center">
                    <span className="tire-compound-dot inline-block w-2.5 h-2.5 rounded-full" data-tire-compound={(entry.tyreCompound || "unknown").toLowerCase()} />
                  </TableCell>
                  <TableCell align="end" numeric tone="dim">
                    {entry.tyreAge}
                  </TableCell>
                  <TableCell align="center" tone="dim">
                    {entry.pitStatus === 1 ? m.f1grid_pit_in() : entry.pitStatus === 2 ? m.f1grid_pit_pitting() : entry.numPitStops > 0 ? entry.numPitStops : ""}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
