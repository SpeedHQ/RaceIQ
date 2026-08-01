import type { LapMeta } from "@shared/types";
import { useNavigate } from "@tanstack/react-router";
import { m } from "@/paraglide/messages";
import { useDeleteLap } from "../hooks/queries";
import { storedLapsSectorCount } from "../lib/lap-sectors";
import { useGameRoute } from "../stores/game";
import { Button } from "./ui/button";

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "-:--.---";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, "0")}`;
}

interface RecordedLapsProps {
  laps: LapMeta[];
  trackOrdinal?: number;
  maxLaps?: number;
}

export function RecordedLaps({ laps, trackOrdinal, maxLaps = 15 }: RecordedLapsProps) {
  const navigate = useNavigate({ from: "/" });
  const gameRoute = useGameRoute();
  const deleteLap = useDeleteLap();

  // Filter by track if provided, otherwise use all
  const filteredLaps = trackOrdinal != null ? laps.filter((l) => l.trackOrdinal === trackOrdinal) : laps;

  const sorted = [...filteredLaps].sort((a, b) => b.lapNumber - a.lapNumber).slice(0, maxLaps);
  const sectorCount = storedLapsSectorCount(filteredLaps);
  const sectorLabels = Array.from({ length: sectorCount }, (_, index) => `S${index + 1}`);
  const gridTemplateColumns = sectorCount > 0 ? `auto repeat(${sectorCount}, minmax(0,1fr)) minmax(0,1fr) auto auto` : "auto minmax(0,1fr) auto auto";

  const allTimes = filteredLaps.map((l) => l.lapTime);
  const best = allTimes.length > 0 ? Math.min(...allTimes) : 0;

  const bestSectors = Array.from({ length: sectorCount }, (_, index) => {
    const times = filteredLaps.map((lap) => lap.sectorTimes?.[index] ?? 0).filter((time) => time > 0);
    return times.length > 0 ? Math.min(...times) : 0;
  });

  const sectorColor = (time: number, bestTime: number) => {
    if (time <= 0) return "text-app-text-dim";
    if (bestTime > 0 && time <= bestTime) return "text-(--lap-pace-best)";
    if (bestTime > 0 && time - bestTime < 0.3) return "text-(--lap-pace-on-target)";
    if (bestTime > 0 && time - bestTime < 1.0) return "text-(--lap-pace-average)";
    return "text-app-text-secondary";
  };

  return (
    <div className="border-b border-app-border">
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.laps_recorded_title()}</h2>
      </div>
      {sorted.length === 0 ? (
        <div className="p-3 text-center text-xs text-app-text-dim">{m.laps_none_completed()}</div>
      ) : (
        <>
          <div className="grid gap-x-2 px-3 py-1 text-xs text-app-text-dim uppercase tracking-wider border-b border-app-border/50" style={{ gridTemplateColumns }}>
            <div className="w-10">{m.label_lap()}</div>
            {sectorLabels.map((label) => (
              <div key={label} className="text-right">
                {label}
              </div>
            ))}
            <div className="text-right">{m.label_time()}</div>
            <div className="text-right w-14">{m.label_delta()}</div>
            <div className="w-16"></div>
          </div>
          <div className="divide-y divide-app-border/30">
            {sorted.map((l) => {
              const delta = l.lapTime - best;
              const isBest = delta === 0;
              const timeColor = isBest ? "text-(--lap-pace-best)" : delta < 0.5 ? "text-(--lap-pace-on-target)" : delta < 1.5 ? "text-app-text" : "text-(--lap-pace-off-target)";
              return (
                <div key={l.id} className="grid gap-x-2 px-3 py-1.5 items-center" style={{ gridTemplateColumns }}>
                  <span
                    className={`text-xs font-mono w-10 flex items-center gap-1 ${l.isValid ? "text-app-text-muted" : "text-status-danger"}`}
                    title={!l.isValid ? (l.invalidReason ?? "invalid") : undefined}
                  >
                    {!l.isValid && <span className="text-status-danger leading-none">✕</span>}
                    {l.lapNumber}
                  </span>
                  {sectorLabels.map((label, index) => {
                    const time = l.sectorTimes?.[index] ?? 0;
                    return (
                      <span key={label} className={`text-sm font-mono tabular-nums text-right ${sectorColor(time, bestSectors[index])}`}>
                        {time > 0 ? time.toFixed(3) : "—"}
                      </span>
                    );
                  })}
                  <span className={`text-base font-mono font-bold tabular-nums text-right ${timeColor}`}>{formatLapTime(l.lapTime)}</span>
                  <span className="text-xs text-app-text-dim font-mono tabular-nums text-right w-14">{isBest ? "PB" : `+${delta.toFixed(3)}`}</span>
                  <div className="flex items-center gap-1 w-16 justify-end">
                    <Button // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      onClick={() => navigate({ to: `${gameRoute}/analyse` as any, search: { track: l.trackOrdinal, car: l.carOrdinal, lap: l.id } as any })}
                      variant="app-primary"
                      size="app-sm"
                      className="!px-1.5 !py-0.5"
                    >
                      {m.label_analyse()}
                    </Button>
                    <Button variant="app-danger" size="app-sm" onClick={() => deleteLap.mutate(l.id)} className="!px-1 !py-0.5">
                      ×
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
