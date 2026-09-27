import { useEffect, useRef } from "react";
import { lapPaceColor, SECTOR_COLOR_VARS } from "@/lib/colors";
import { formatLapTime } from "@/lib/format";
import { getSoundEnabled } from "@/lib/settings-storage";
import { playBlip } from "@/lib/sound";
import { m } from "@/paraglide/messages";
import type { LiveSectorData } from "../../../shared/racing/live/types";


/**
 * SectorTimes — Display-only component for server-computed sector splits.
 * All timing computation happens server-side in SectorTracker.
 */
export function SectorTimes({ sectors }: { sectors: LiveSectorData | null }) {
  const prevSectorRef = useRef<number>(-1);
  const prevLapTimeRef = useRef<number>(0);

  // Play sounds on sector/lap transitions
  useEffect(() => {
    if (!sectors) return;

    // Sector boundary blip
    if (prevSectorRef.current >= 0 && sectors.currentSector !== prevSectorRef.current) {
      if (sectors.currentSector > prevSectorRef.current) {
        if (getSoundEnabled()) playBlip(1.5);
      } else {
        // Sector went from 2→0 = new lap
        if (getSoundEnabled()) playBlip(1.0);
      }
    }
    prevSectorRef.current = sectors.currentSector;

    // Lap completion blip
    if (sectors.lastLapTime > 0 && sectors.lastLapTime !== prevLapTimeRef.current) {
      if (prevLapTimeRef.current > 0 && getSoundEnabled()) playBlip(1.0);
      prevLapTimeRef.current = sectors.lastLapTime;
    }
  }, [sectors]);

  if (!sectors) return null;

  const translatedNames = [m.sectortimes_s1(), m.sectortimes_s2(), m.sectortimes_s3()];
  const sectorNames = Array.from({ length: sectors.sectorCount }, (_, index) => translatedNames[index] ?? `S${index + 1}`);
  return (
    <div className="border-t border-app-border/50 pt-3">
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
        }}
      >
        {sectorNames.map((name, i) => {
          const current = i === sectors.currentSector ? sectors.currentSectorTime : sectors.currentTimes[i];
          const best = sectors.bestTimes[i];
          const last = sectors.lastTimes[i];
          const isActive = i === sectors.currentSector;

          const isDone = i < sectors.currentSector && sectors.currentTimes[i] > 0;
          const showDelta = isDone && best > 0;
          const delta = showDelta ? sectors.currentTimes[i] - best : 0;

          let timeColor = "var(--app-text)";
          if (isDone && best > 0) {
            if (sectors.currentTimes[i] <= best * 1.001) timeColor = lapPaceColor(true, true);
            else timeColor = lapPaceColor(false, delta <= 0.3);
          }

          return (
            <div
              key={name}
              className={`rounded p-2.5 ${isActive ? "ring-1" : ""}`}
              style={isActive ? ({ "--tw-ring-color": SECTOR_COLOR_VARS[i % SECTOR_COLOR_VARS.length] } as React.CSSProperties) : {}}
            >
              <div className="flex items-center gap-1.5 mb-1.5">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SECTOR_COLOR_VARS[i % SECTOR_COLOR_VARS.length] }} />
                <span className="text-xs font-bold text-app-text-secondary">{name}</span>
                <span className="text-xl font-mono font-bold tabular-nums leading-none ml-auto" style={{ color: timeColor }}>
                  {current > 0 ? formatLapTime(current) : "--:--.---"}
                </span>
                {showDelta && (
                  <span className="text-xs font-mono font-bold" style={{ color: lapPaceColor(false, delta <= 0) }}>
                    {delta <= 0 ? "" : "+"}
                    {delta.toFixed(3)}
                  </span>
                )}
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-app-caption text-app-text-muted">{m.label_last()}</span>
                <span className="text-sm font-mono font-bold text-app-text-secondary tabular-nums">{last > 0 ? formatLapTime(last) : "-"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-app-caption" style={{ color: "var(--lap-record)" }}>
                  {m.label_best()}
                </span>
                <span className="text-sm font-mono font-bold tabular-nums" style={{ color: "var(--lap-record)" }}>
                  {best > 0 ? formatLapTime(best) : "-"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
