import { useMemo, useSyncExternalStore } from "react";
import { Pause, Play } from "lucide-react";
import { m } from "@/paraglide/messages";
import type { SpectateController, SpectatePair } from "./types";
function stamp(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds - minutes * 60).toFixed(3).padStart(6, "0")}`;
}
export function SpectatePlayback({ controller, pair }: { controller: SpectateController; pair: SpectatePair }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const duration = Number.isFinite(snapshot.duration) ? Math.max(0, snapshot.duration) : 0;
  const time = Math.max(0, Math.min(duration, snapshot.time));
  // The replay clock always follows A's elapsed time, including position-lock mode.
  const sectors = useMemo(() => {
    const times = pair.comparison.lapA.sectorTimes;
    if (!times?.length || times.some((value) => !Number.isFinite(value) || value <= 0)) return [];
    let elapsed = 0;
    return times.map((seconds, index) => {
      const start = elapsed;
      elapsed += seconds;
      const other = pair.comparison.lapB.sectorTimes?.[index];
      const delta = other != null && Number.isFinite(other) && other > 0 ? Math.round((seconds - other) * 1000) / 1000 : null;
      return { sector: index + 1, start, time: elapsed, seconds, delta };
    });
  }, [pair]);
  return (
    <section
      className="relative z-10 flex shrink-0 flex-col gap-2 border-t border-app-border bg-app-bg px-3 py-2"
      aria-label={m.spectate_playback()}
      data-spectate-playback=""
      data-time={time}
      data-duration={duration}
      data-playing={snapshot.playing}
      data-seeking={snapshot.seeking}
      data-position-lock={snapshot.positionLock}
      data-a-distance={snapshot.a?.distance ?? ""}
      data-b-distance={snapshot.b?.distance ?? ""}
      data-a-time={snapshot.a?.time ?? ""}
      data-b-time={snapshot.b?.time ?? ""}
    >
      <div className="relative pt-5">
        {sectors.map((sector) => sector.start < duration && duration > 0 && (
          <span
            key={sector.sector}
            data-sector-duration={sector.sector}
            className="pointer-events-none absolute top-0 -translate-x-full whitespace-nowrap text-app-compact tracking-tight tabular-nums text-app-text-muted"
            style={{
              left: `calc(8px + (100% - 16px) * ${Math.min(sector.time, duration) / duration})`,
            }}
          >
            <span style={{ color: sector.delta === null || sector.delta === 0 ? undefined : sector.delta < 0 ? "var(--status-success)" : "var(--status-danger)" }}>
              {sector.seconds.toFixed(3)}
            </span>
            {sector.delta !== null && <span style={{ color: sector.delta === 0 ? undefined : sector.delta < 0 ? "var(--status-success)" : "var(--status-danger)" }}>
              {` (${sector.delta > 0 ? "+" : ""}${sector.delta.toFixed(3)} s)`}
            </span>}
            {" "}S{sector.sector}
          </span>
        ))}
        {sectors.map((split, index) => index < sectors.length - 1 && split.time > 0 && split.time < duration && (
          <button
            key={split.sector}
            type="button"
            data-sector-split={split.sector}
            data-split-time={split.time}
            title={`S${split.sector} · ${stamp(split.time)} (A)`}
            aria-label={`S${split.sector} · ${stamp(split.time)} (A)`}
            onClick={() => controller.scrub(split.time)}
            className="absolute top-5 flex h-3 w-4 -translate-x-1/2 items-start justify-center text-app-label tabular-nums text-app-text-secondary hover:text-app-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent"
            style={{ left: `calc(8px + (100% - 16px) * ${split.time / duration})` }}
          >
            <span className="h-2 w-px bg-current" aria-hidden="true" />
          </button>
        ))}
      <input
        aria-label={m.spectate_seek()}
        className="h-1.5 w-full cursor-pointer accent-app-accent"
        type="range"
        min={0}
        max={duration}
        step={0.001}
        value={time}
        onChange={(event) => controller.scrub(Number(event.currentTarget.value))}
      />
      </div>
      <div className="flex items-center gap-3 text-app-label">
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-sm border border-app-border-input text-app-text hover:text-app-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent"
          aria-label={snapshot.playing ? m.spectate_pause() : m.spectate_play()}
          onClick={() => (snapshot.playing ? controller.pause() : controller.play())}
        >
          {snapshot.playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
        </button>
        <output className="tabular-nums text-app-text" aria-live="off">
          {stamp(time)}
        </output>
        <span className="text-app-text-secondary">/ {stamp(duration)}</span>
        <label className="ml-auto flex items-center gap-2 text-app-text-secondary">
          {m.spectate_playback_speed()}
          <select
            className="rounded-sm border border-app-border-input bg-app-surface px-1.5 py-1 text-app-text"
            aria-label={m.spectate_playback_speed()}
            value={snapshot.speed}
            onChange={(event) => controller.setSpeed(Number(event.currentTarget.value))}
          >
            {[0.25, 0.5, 1, 1.5, 2, 4].map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
