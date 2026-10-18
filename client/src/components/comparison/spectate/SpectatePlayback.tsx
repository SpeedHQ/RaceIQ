import { useSyncExternalStore } from "react";
import { Pause, Play } from "lucide-react";
import { m } from "@/paraglide/messages";
import type { SpectateController } from "./types";
function stamp(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds - minutes * 60).toFixed(3).padStart(6, "0")}`;
}
export function SpectatePlayback({ controller }: { controller: SpectateController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const duration = Number.isFinite(snapshot.duration) ? Math.max(0, snapshot.duration) : 0;
  const time = Math.max(0, Math.min(duration, snapshot.time));
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
        <button
          type="button"
          role="switch"
          aria-checked={snapshot.positionLock}
          disabled={!snapshot.canLock}
          aria-label={m.spectate_position_lock()}
          title={snapshot.canLock ? m.spectate_position_lock() : m.spectate_position_lock_unavailable()}
          className="ml-auto flex items-center gap-2 text-app-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => controller.setPositionLock(!snapshot.positionLock)}
        >
          <span className={`relative h-4 w-7 rounded-full border border-app-border-input ${snapshot.positionLock ? "bg-app-accent/60" : "bg-app-progress-track"}`}>
            <i className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-app-text transition-transform ${snapshot.positionLock ? "translate-x-3" : "translate-x-0.5"}`} />
          </span>
          {m.spectate_position_lock()}
        </button>
        <label className="flex items-center gap-2 text-app-text-secondary">
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
