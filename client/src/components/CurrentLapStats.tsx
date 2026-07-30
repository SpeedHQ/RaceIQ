import type { TelemetryPacket } from "@shared/types";
import { deltaColor as colorForDelta, SECTOR_COLOR_VARS } from "@/lib/colors";
import { m } from "../paraglide/messages";
import { useTelemetryStore } from "../stores/telemetry";

interface Props {
  packet: TelemetryPacket | null;
}

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

export function CurrentLapStats({ packet }: Props) {
  const sectors = useTelemetryStore((state) => state.sectors);

  if (!packet) return null;

  const sectorNames = sectors ? Array.from({ length: sectors.sectorCount }, (_, index) => `S${index + 1}`) : [];
  const theoreticalBest = sectors?.bestTimes.every((time) => time > 0) ? sectors.bestTimes.reduce((sum, time) => sum + time, 0) : 0;

  return (
    <div className="p-3 space-y-2">
      <div className="flex justify-between items-end mb-1">
        <div>
          <div className="text-xs text-app-text-muted uppercase tracking-wider">{m.livestats_current_lap_label()}</div>
          <div className="text-xl font-mono font-semibold text-app-text tabular-nums">{formatLapTime(packet.CurrentLap)}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-app-text-muted">Lap {packet.LapNumber}</div>
        </div>
      </div>

      {sectors ? (
        <div className="space-y-1.5 border-t border-app-border pt-2">
          {sectorNames.map((name, i) => {
            const current = i === sectors.currentSector ? sectors.currentSectorTime : (sectors.currentTimes[i] ?? 0);
            const best = sectors.bestTimes[i] ?? 0;
            const last = sectors.lastTimes[i] ?? 0;
            const isActive = i === sectors.currentSector;
            const isDone = i < sectors.currentSector && (sectors.currentTimes[i] ?? 0) > 0;
            const color = SECTOR_COLOR_VARS[i % SECTOR_COLOR_VARS.length];

            // Delta vs best
            let delta = "";
            let deltaColor = "";
            if (isDone && best > 0) {
              const diff = sectors.currentTimes[i] - best;
              delta = diff >= 0 ? `+${diff.toFixed(3)}` : diff.toFixed(3);
              deltaColor = colorForDelta(diff);
            }

            return (
              <div
                key={name}
                className={`rounded px-2 py-1.5 ${isActive ? "bg-app-surface-alt/80 ring-1 ring-inset ring-(--local-sector-color)/25" : "bg-app-surface-alt/30"}`}
                style={{ ["--local-sector-color" as string]: color }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                    <span className="text-app-caption font-semibold text-app-text-secondary">{name}</span>
                  </div>
                  <span className={`text-sm font-mono font-bold tabular-nums ${isActive ? "text-app-text" : "text-app-text"}`}>{current > 0 ? formatLapTime(current) : "--:--.---"}</span>
                </div>
                <div className="flex items-center justify-between mt-0.5">
                  <div className="flex gap-3">
                    <span className="text-app-micro text-app-text-muted">
                      {m.telemetry_last()} <span className="font-mono text-app-text-secondary">{last > 0 ? formatLapTime(last) : "-"}</span>
                    </span>
                    <span className="text-app-micro" style={{ color: "var(--lap-record)" }}>
                      {m.label_best()} <span className="font-mono">{best > 0 ? formatLapTime(best) : "-"}</span>
                    </span>
                  </div>
                  {delta && (
                    <span className="text-app-micro font-mono font-bold" style={{ color: deltaColor }}>
                      {delta}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {/* Last/Best total */}
          <div className="flex justify-between pt-1 border-t border-app-border/50">
            <span className="text-app-micro text-app-text-muted">
              {m.telemetry_last()} <span className="font-mono text-app-text-secondary">{sectors.lastLapTime > 0 ? formatLapTime(sectors.lastLapTime) : "-"}</span>
            </span>
            <span className="text-app-micro" style={{ color: "var(--lap-record)" }}>
              {m.label_best()} <span className="font-mono">{theoreticalBest > 0 ? formatLapTime(theoreticalBest) : "-"}</span>
            </span>
          </div>
        </div>
      ) : (
        <div className="border-t border-app-border pt-2 text-xs text-app-text-muted">{m.livestats_complete_lap_message()}</div>
      )}
    </div>
  );
}
