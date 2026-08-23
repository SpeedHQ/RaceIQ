import { memo, type RefObject, useEffect, useMemo, useRef } from "react";
import { SECTOR_COLOR_VARS } from "@/lib/colors";
import { formatLapTime } from "@/lib/format";
import { Button } from "../ui/button";
import { type SemanticAnalysisFrame, semanticNumber } from "@/components/track-map/types";

const currentLap = (frame: SemanticAnalysisFrame): number => semanticNumber(frame, "timing.current-lap") ?? 0;

interface SectorTimesData {
  times: number[];
  sectorCount: number;
  cursorSector: number;
}
interface TimelineScrubberProps {
  displayTelemetry: SemanticAnalysisFrame[];
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
interface TimelineData {
  timeFracs: number[];
  times: number[];
}

const PlaybackControls = memo(function PlaybackControls({
  playing,
  playbackSpeed,
  onTogglePlay,
  onSpeedChange,
}: Pick<TimelineScrubberProps, "playing" | "playbackSpeed" | "onTogglePlay" | "onSpeedChange">) {
  return (
    <>
      <Button
        type="button"
        onClick={onTogglePlay}
        className="text-lg w-8 h-8 flex items-center justify-center rounded bg-app-surface-alt hover:bg-app-surface-hover text-app-text transition-colors"
        title={playing ? "Pause (Space)" : "Play (Space)"}
      >
        {playing ? "\u275A\u275A" : "\u25B6"}
      </Button>
      <div className="flex flex-wrap gap-1">
        {[0.1, 0.25, 0.5, 1, 1.5, 2, 2.5].map((speed) => (
          <Button
            type="button"
            key={speed}
            aria-pressed={playbackSpeed === speed}
            onClick={() => onSpeedChange(speed)}
            className={`px-1.5 py-0.5 text-app-caption font-mono rounded transition-colors ${
              playbackSpeed === speed ? "bg-app-accent text-app-on-filled" : "bg-app-surface-alt text-app-text-secondary hover:bg-app-surface-hover hover:text-app-text"
            }`}
          >
            {speed}x
          </Button>
        ))}
      </div>
    </>
  );
});

const TimelineGapHighlights = memo(function TimelineGapHighlights({ timelineData }: { timelineData: TimelineData }) {
  return timelineData.times.map((time, index) => {
    if (index === 0) return null;
    const delta = time - timelineData.times[index - 1];
    if (delta <= 0.1) return null;
    const left = timelineData.timeFracs[index - 1] * 100;
    const right = timelineData.timeFracs[index] * 100;
    return (
      <div
        key={`${timelineData.timeFracs[index - 1]}-${timelineData.timeFracs[index]}`}
        className="absolute top-0 h-full border-x bg-status-danger/30 border-status-danger/50"
        style={{ left: `${left}%`, width: `${Math.max(0.3, right - left)}%` }}
        title={`${delta.toFixed(2)}s gap`}
      />
    );
  });
});

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
  const scrubCleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      scrubCleanupRef.current?.();
      scrubCleanupRef.current = null;
    },
    [],
  );
  const timelineData = useMemo(() => {
    if (displayTelemetry.length === 0) return null;
    const startTime = currentLap(displayTelemetry[0]);
    // Use max current-lap as end time — last frame may have reset to next lap
    let maxTime = startTime;
    for (const frame of displayTelemetry) {
      const time = currentLap(frame);
      if (time > maxTime) maxTime = time;
    }
    const lapDuration = maxTime - startTime || 1;
    let prevFrac = 0;
    const timeFracs = displayTelemetry.map((frame) => {
      const frac = Math.max(prevFrac, (currentLap(frame) - startTime) / lapDuration);
      prevFrac = frac;
      return frac;
    });
    const times = displayTelemetry.map(currentLap);
    return { timeFracs, times };
  }, [displayTelemetry]);

  const cursorFrac = visualTimeFrac ?? timelineData?.timeFracs?.[cursorIdx] ?? cursorIdx / (totalPackets - 1);
  const cursorPct = cursorFrac * 100;

  return (
    <div className="px-3 py-2 border-b border-app-border bg-app-surface/50 shrink-0">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="text-app-caption text-app-text-muted">Lap {lapNumber}</span>
        <span className="text-2xl font-mono font-bold tabular-nums text-app-accent">{formatLapTime(currentTime)}</span>
        <span className="text-sm font-mono tabular-nums text-app-text-secondary">/ {formatLapTime(totalTime)}</span>
        {sectorTimes &&
          Array.from({ length: sectorTimes.sectorCount }, (_, index) => `S${index + 1}`).map((name, i) => {
            const isActive = sectorTimes.cursorSector === i;
            return (
              <div
                key={name}
                className={`flex items-center gap-1.5 px-2 py-1 rounded ${isActive ? "bg-app-surface-alt ring-1 ring-inset ring-(--local-sector-color)/25" : "bg-app-surface-alt/30"}`}
                style={{ ["--local-sector-color" as string]: SECTOR_COLOR_VARS[i % SECTOR_COLOR_VARS.length] }}
              >
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: SECTOR_COLOR_VARS[i % SECTOR_COLOR_VARS.length] }} />
                <span className="text-app-caption font-semibold text-app-text-muted">{name}</span>
                <span className={`text-xs font-mono font-bold tabular-nums ${isActive ? "text-app-text" : "text-app-text-secondary"}`}>{formatLapTime(sectorTimes.times[i])}</span>
              </div>
            );
          })}
        <span className="ml-auto text-app-caption font-mono text-app-text-dim">
          Packet {cursorIdx + 1}/{totalPackets}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <PlaybackControls playing={playing} playbackSpeed={playbackSpeed} onTogglePlay={onTogglePlay} onSpeedChange={onSpeedChange} />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Lap timeline"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, totalPackets - 1)}
          aria-valuenow={cursorIdx}
          className="group relative flex h-4 basis-full cursor-pointer items-center @3xl/workspace:basis-auto @3xl/workspace:flex-1"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              const direction = event.key === "ArrowLeft" ? -1 : 1;
              onSeek(Math.max(0, Math.min(totalPackets - 1, cursorIdx + direction)));
            }
          }}
          onMouseDown={(e) => {
            scrubCleanupRef.current?.();
            const bar = e.currentTarget;
            const seek = (clientX: number) => {
              const rect = bar.getBoundingClientRect();
              const clickFrac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
              onVisualFracChange(clickFrac);
              const tf = timelineData?.timeFracs;
              if (tf && tf.length > 0) {
                let lo = 0,
                  hi = tf.length - 1;
                while (lo < hi) {
                  const mid = (lo + hi) >> 1;
                  if (tf[mid] < clickFrac) lo = mid + 1;
                  else hi = mid;
                }
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
              scrubCleanupRef.current = null;
            };
            const cleanup = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            scrubCleanupRef.current = cleanup;
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
        >
          {/* Track background */}
          <div className="absolute inset-x-0 h-2 bg-app-border-input rounded-full">
            {/* Gap highlights */}
            {timelineData && <TimelineGapHighlights timelineData={timelineData} />}
            {/* Progress fill */}
            <div ref={progressRef} className="absolute top-0 h-full rounded-full bg-app-accent/40" style={{ width: `${cursorPct}%` }} />
          </div>
          {/* Thumb */}
          <div
            ref={thumbRef}
            className="absolute w-3 h-3 bg-app-accent rounded-full shadow-[var(--app-glow-accent)] -translate-x-1/2 group-hover:scale-125 transition-transform"
            style={{ left: `${cursorPct}%` }}
          />
        </div>
      </div>
    </div>
  );
});
