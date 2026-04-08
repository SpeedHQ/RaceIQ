import { memo, useMemo, type RefObject } from "react";
import type { TelemetryPacket } from "@shared/types";
import { formatLapTime } from "@/lib/format";

interface SectorTimesData {
  times: [number, number, number];
  cursorSector: number;
}

interface TimelineScrubberProps {
  displayTelemetry: TelemetryPacket[];
  cursorIdx: number;
  totalPackets: number;
  currentTime: number;
  totalTime: number;
  lapNumber: number | string;
  sectorTimes: SectorTimesData | null;
  playing: boolean;
  playbackSpeed: number;
  visualTimeFrac: number | null;
  progressRef: RefObject<HTMLDivElement | null>;
  thumbRef: RefObject<HTMLDivElement | null>;
  onTogglePlay: () => void;
  onSpeedChange: (speed: number) => void;
  onSeek: (idx: number) => void;
  onVisualFracChange: (frac: number | null) => void;
}

export const AnalyseTimelineScrubber = memo(function AnalyseTimelineScrubber({
  displayTelemetry,
  cursorIdx,
  totalPackets,
  currentTime,
  totalTime,
  lapNumber,
  sectorTimes,
  playing,
  playbackSpeed,
  visualTimeFrac,
  progressRef,
  thumbRef,
  onTogglePlay,
  onSpeedChange,
  onSeek,
  onVisualFracChange,
}: TimelineScrubberProps) {
  const timelineData = useMemo(() => {
    if (displayTelemetry.length === 0) return null;
    const startTime = displayTelemetry[0].CurrentLap;
    const endTime = displayTelemetry[displayTelemetry.length - 1].CurrentLap;
    const lapDuration = endTime - startTime || 1;
    const timeFracs = displayTelemetry.map(p => (p.CurrentLap - startTime) / lapDuration);
    const times = displayTelemetry.map(p => p.CurrentLap);
    return { timeFracs, times };
  }, [displayTelemetry]);

  const cursorFrac = visualTimeFrac ?? timelineData?.timeFracs?.[cursorIdx] ?? cursorIdx / (totalPackets - 1);
  const cursorPct = cursorFrac * 100;

  return (
    <div className="px-3 py-2 border-b border-app-border bg-app-surface/50 shrink-0">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-[10px] text-app-text-muted">Lap {lapNumber}</span>
        <span className="text-2xl font-mono font-bold tabular-nums text-app-accent">{formatLapTime(currentTime)}</span>
        <span className="text-sm font-mono tabular-nums text-app-text-secondary">/ {formatLapTime(totalTime)}</span>
        {sectorTimes && (["S1", "S2", "S3"] as const).map((name, i) => {
          const colors = ["#ef4444", "#3b82f6", "#eab308"];
          const isActive = sectorTimes.cursorSector === i;
          return (
            <div
              key={name}
              className={`flex items-center gap-1.5 px-2 py-1 rounded ${
                isActive ? "bg-app-surface-alt ring-1" : "bg-app-surface-alt/30"
              }`}
              style={isActive ? { boxShadow: `inset 0 0 0 1px ${colors[i]}40` } : {}}
            >
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: colors[i] }} />
              <span className="text-[10px] font-semibold text-app-text-muted">{name}</span>
              <span className={`text-xs font-mono font-bold tabular-nums ${isActive ? "text-app-text" : "text-app-text-secondary"}`}>
                {formatLapTime(sectorTimes.times[i])}
              </span>
            </div>
          );
        })}
        <span className="text-[10px] font-mono text-app-text-dim ml-auto">
          Packet {cursorIdx + 1}/{totalPackets}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onTogglePlay}
          className="text-lg w-8 h-8 flex items-center justify-center rounded bg-app-surface-alt hover:bg-app-border-input text-app-text transition-colors"
          title={playing ? "Pause (Space)" : "Play (Space)"}
        >
          {playing ? "\u275A\u275A" : "\u25B6"}
        </button>
        <div className="flex gap-1">
          {[0.1, 0.25, 0.5, 1, 1.5, 2, 2.5].map((s) => (
            <button
              key={s}
              onClick={() => onSpeedChange(s)}
              className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                playbackSpeed === s
                  ? "bg-cyan-600 text-white"
                  : "bg-app-surface-alt text-app-text-secondary hover:bg-app-border-input hover:text-app-text"
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
        <div className="flex-1 relative h-4 flex items-center group cursor-pointer"
          onMouseDown={(e) => {
            const bar = e.currentTarget;
            const seek = (clientX: number) => {
              const rect = bar.getBoundingClientRect();
              const clickFrac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
              onVisualFracChange(clickFrac);
              const tf = timelineData?.timeFracs;
              if (tf && tf.length > 0) {
                let lo = 0, hi = tf.length - 1;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (tf[mid] < clickFrac) lo = mid + 1; else hi = mid; }
                if (lo > 0 && Math.abs(tf[lo - 1] - clickFrac) < Math.abs(tf[lo] - clickFrac)) lo--;
                onSeek(lo);
              } else {
                onSeek(Math.round(clickFrac * (totalPackets - 1)));
              }
            };
            seek(e.clientX);
            const onMove = (ev: MouseEvent) => seek(ev.clientX);
            const onUp = () => {
              onVisualFracChange(null);
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
        >
          {/* Track background */}
          <div className="absolute inset-x-0 h-2 bg-app-border-input rounded-full">
            {/* Gap highlights */}
            {timelineData?.timeFracs && timelineData.times && timelineData.times.map((t, i) => {
              if (i === 0) return null;
              const dt = t - timelineData.times[i - 1];
              if (dt <= 0.1) return null;
              const left = timelineData.timeFracs[i - 1] * 100;
              const right = timelineData.timeFracs[i] * 100;
              return (
                <div
                  key={i}
                  className="absolute top-0 h-full bg-red-500/30 border-x border-red-500/50"
                  style={{ left: `${left}%`, width: `${Math.max(0.3, right - left)}%` }}
                  title={`${dt.toFixed(2)}s gap`}
                />
              );
            })}
            {/* Progress fill */}
            <div
              ref={progressRef}
              className="absolute top-0 h-full bg-cyan-500/40 rounded-full"
              style={{ width: `${cursorPct}%` }}
            />
          </div>
          {/* Thumb */}
          <div
            ref={thumbRef}
            className="absolute w-3 h-3 bg-cyan-400 rounded-full shadow-[0_0_6px_rgba(34,211,238,0.5)] -translate-x-1/2 group-hover:scale-125 transition-transform"
            style={{ left: `${cursorPct}%` }}
          />
        </div>
      </div>
    </div>
  );
});
