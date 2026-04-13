import { useNavigate } from "@tanstack/react-router";
import { useTelemetryStore } from "../stores/telemetry";
import { useDeleteLap } from "../hooks/queries";
import { useGameRoute } from "../stores/game";

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "-:--.---";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, "0")}`;
}

interface RecordedLapsProps {
  trackOrdinal?: number;
  maxLaps?: number;
}

export function RecordedLaps({ trackOrdinal, maxLaps = 15 }: RecordedLapsProps) {
  const navigate = useNavigate({ from: "/" });
  const gameRoute = useGameRoute();
  const laps = useTelemetryStore((s) => s.sessionLaps);
  const deleteLap = useDeleteLap();

  // Filter by track if provided, otherwise use all
  const filteredLaps = trackOrdinal != null
    ? laps.filter((l) => l.trackOrdinal === trackOrdinal)
    : laps;

  const sorted = [...filteredLaps]
    .sort((a, b) => b.lapNumber - a.lapNumber)
    .slice(0, maxLaps);

  const allTimes = filteredLaps.map(l => l.lapTime);
  const best = allTimes.length > 0 ? Math.min(...allTimes) : 0;

  // Collect best sectors from lap data
  const allS1: number[] = [], allS2: number[] = [], allS3: number[] = [];
  for (const l of filteredLaps) {
    if (l.s1Time && l.s1Time > 0) allS1.push(l.s1Time);
    if (l.s2Time && l.s2Time > 0) allS2.push(l.s2Time);
    if (l.s3Time && l.s3Time > 0) allS3.push(l.s3Time);
  }
  const bestS1 = allS1.length > 0 ? Math.min(...allS1) : 0;
  const bestS2 = allS2.length > 0 ? Math.min(...allS2) : 0;
  const bestS3 = allS3.length > 0 ? Math.min(...allS3) : 0;

  const sectorColor = (time: number, bestTime: number) => {
    if (time <= 0) return "text-app-text-dim";
    if (bestTime > 0 && time <= bestTime) return "text-purple-400";
    if (bestTime > 0 && time - bestTime < 0.3) return "text-emerald-400";
    if (bestTime > 0 && time - bestTime < 1.0) return "text-yellow-400";
    return "text-app-text-secondary";
  };

  return (
    <div className="border-b border-app-border">
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Recorded Laps</h2>
      </div>
      {sorted.length === 0 ? (
        <div className="p-3 text-center text-xs text-app-text-dim">No completed laps yet</div>
      ) : (
        <>
          <div className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_auto_auto] gap-x-2 px-3 py-1 text-xs text-app-text-dim uppercase tracking-wider border-b border-app-border/50">
            <div className="w-10">Lap</div>
            <div className="text-right">S1</div>
            <div className="text-right">S2</div>
            <div className="text-right">S3</div>
            <div className="text-right">Time</div>
            <div className="text-right w-14">Delta</div>
            <div className="w-16"></div>
          </div>
          <div className="divide-y divide-app-border/30">
            {sorted.map((l) => {
              const s1 = l.s1Time ?? 0;
              const s2 = l.s2Time ?? 0;
              const s3 = l.s3Time ?? 0;
              const delta = l.lapTime - best;
              const isBest = delta === 0;
              const timeColor = isBest ? "text-purple-400" : delta < 0.5 ? "text-emerald-400" : delta < 1.5 ? "text-app-text" : "text-red-400";
              return (
                <div key={l.id} className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_auto_auto] gap-x-2 px-3 py-1.5 items-center">
                  <span
                    className={`text-xs font-mono w-10 flex items-center gap-1 ${l.isValid ? "text-app-text-muted" : "text-red-400"}`}
                    title={!l.isValid ? (l.invalidReason ?? "invalid") : undefined}
                  >
                    {!l.isValid && <span className="text-red-400 leading-none">✕</span>}
                    {l.lapNumber}
                  </span>
                  <span className={`text-sm font-mono tabular-nums text-right ${sectorColor(s1, bestS1)}`}>
                    {s1 > 0 ? s1.toFixed(3) : "—"}
                  </span>
                  <span className={`text-sm font-mono tabular-nums text-right ${sectorColor(s2, bestS2)}`}>
                    {s2 > 0 ? s2.toFixed(3) : "—"}
                  </span>
                  <span className={`text-sm font-mono tabular-nums text-right ${sectorColor(s3, bestS3)}`}>
                    {s3 > 0 ? s3.toFixed(3) : "—"}
                  </span>
                  <span className={`text-base font-mono font-bold tabular-nums text-right ${timeColor}`}>
                    {formatLapTime(l.lapTime)}
                  </span>
                  <span className="text-xs text-app-text-dim font-mono tabular-nums text-right w-14">
                    {isBest ? "PB" : `+${delta.toFixed(3)}`}
                  </span>
                  <div className="flex items-center gap-1 w-16 justify-end">
                    <button
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      onClick={() => navigate({ to: `${gameRoute}/analyse` as any, search: { track: l.trackOrdinal, car: l.carOrdinal, lap: l.id } as any })}
                      className="px-1.5 py-0.5 text-[10px] rounded bg-purple-600 hover:bg-purple-500 text-white"
                    >
                      Analyse
                    </button>
                    <button
                      onClick={() => deleteLap.mutate(l.id)}
                      className="px-1 py-0.5 text-[10px] rounded bg-slate-700 hover:bg-red-600 text-app-text"
                    >
                      ×
                    </button>
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
