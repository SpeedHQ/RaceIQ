import { useEffect, useRef } from "react";
import { formatLapTime } from "@/lib/format";
import { getSoundEnabled, getSoundVolume, getSoundType, getSoundUrl } from "./Settings";
import { useTelemetryStore } from "../stores/telemetry";

/** Shared AudioContext — reused across all blips to avoid browser throttling. */
let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new AudioContext();
  }
  if (sharedAudioCtx.state === "suspended") {
    sharedAudioCtx.resume();
  }
  return sharedAudioCtx;
}

/** Cache fetched audio buffers by URL to avoid re-downloading. */
const audioBufferCache = new Map<string, AudioBuffer>();
const loadingUrls = new Set<string>();

async function loadAudioBuffer(url: string): Promise<AudioBuffer | null> {
  if (audioBufferCache.has(url)) return audioBufferCache.get(url)!;
  if (loadingUrls.has(url)) return null;
  loadingUrls.add(url);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    const ctx = getAudioContext();
    const audioBuf = await ctx.decodeAudioData(arrayBuf);
    audioBufferCache.set(url, audioBuf);
    return audioBuf;
  } catch {
    return null;
  } finally {
    loadingUrls.delete(url);
  }
}

/** Preload a URL sound into cache. Call from settings when URL changes. */
export function preloadSound(url: string) {
  if (url && !audioBufferCache.has(url)) loadAudioBuffer(url);
}

function playSample(url: string, pitch = 1) {
  const buf = audioBufferCache.get(url);
  if (!buf) {
    loadAudioBuffer(url).then((b) => { if (b) playBuffer(b, pitch); });
    return;
  }
  playBuffer(buf, pitch);
}

function playBuffer(buf: AudioBuffer, pitch = 1) {
  const volume = getSoundVolume();
  const ctx = getAudioContext();
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buf;
  source.playbackRate.value = pitch;
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start();
}

export function playBlip(pitch = 1) {
  try {
    const type = getSoundType();
    if (type === "url") {
      const url = getSoundUrl();
      if (url) { playSample(url, pitch); return; }
      playSample("/sounds/beep-2.mp3", pitch);
    } else {
      playSample(`/sounds/${type}.mp3`, pitch);
    }
  } catch {}
}

/**
 * SectorTimes — Display-only component for server-computed sector splits.
 * All timing computation happens server-side in SectorTracker.
 */
export function SectorTimes() {
  const sectors = useTelemetryStore((s) => s.sectors);
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

  const sectorNames = ["S1", "S2", "S3"];
  const sectorColors = ["#ef4444", "#3b82f6", "#eab308"];

  const hasBests = sectors.bestTimes[0] > 0 && sectors.bestTimes[1] > 0 && sectors.bestTimes[2] > 0;

  return (
    <div className="border-t border-app-border/50 pt-3">
      {/* Estimated lap time */}
      {hasBests && sectors.estimatedLap > 0 && (
        <div className="flex items-baseline gap-4 mb-3 pb-2 border-b border-app-border/50">
          <div>
            <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Est. Lap</div>
            <div className="text-2xl font-mono font-bold text-app-text tabular-nums leading-none">
              {formatLapTime(sectors.estimatedLap)}
            </div>
          </div>
          {sectors.deltaToBest !== 0 && (
            <div>
              <div className="text-[10px] text-app-text-muted uppercase tracking-wider">vs Best</div>
              <div className={`text-2xl font-mono font-bold tabular-nums leading-none ${sectors.deltaToBest <= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {sectors.deltaToBest <= 0 ? "" : "+"}{sectors.deltaToBest.toFixed(3)}
              </div>
            </div>
          )}
          {sectors.bestLapTime > 0 && (
            <div className="ml-auto">
              <div className="text-[10px] text-purple-400 uppercase tracking-wider">Best Lap</div>
              <div className="text-lg font-mono font-bold text-purple-400 tabular-nums leading-none">{formatLapTime(sectors.bestLapTime)}</div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {sectorNames.map((name, i) => {
          const current = i === sectors.currentSector ? sectors.currentSectorTime : sectors.currentTimes[i];
          const best = sectors.bestTimes[i];
          const last = sectors.lastTimes[i];
          const isActive = i === sectors.currentSector;

          const isDone = i < sectors.currentSector && sectors.currentTimes[i] > 0;
          const showDelta = isDone && best > 0;
          const delta = showDelta ? sectors.currentTimes[i] - best : 0;

          let timeColor = "text-app-text";
          if (isDone && best > 0) {
            if (sectors.currentTimes[i] <= best * 1.001) timeColor = "text-purple-400";
            else if (delta <= 0.3) timeColor = "text-emerald-400";
            else timeColor = "text-orange-400";
          }

          return (
            <div key={name} className={`rounded p-2.5 ${isActive ? "bg-app-surface-alt/80 ring-1" : "bg-app-surface-alt/30"}`} style={isActive ? { "--tw-ring-color": sectorColors[i] } as React.CSSProperties : {}}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: sectorColors[i] }} />
                <span className="text-xs font-bold text-app-text-secondary">{name}</span>
                {showDelta && (
                  <span className={`text-xs font-mono ml-auto font-bold ${delta <= 0 ? "text-emerald-400" : "text-orange-400"}`}>
                    {delta <= 0 ? "" : "+"}{delta.toFixed(3)}
                  </span>
                )}
              </div>
              <div className={`text-xl font-mono font-bold tabular-nums leading-none mb-1.5 ${timeColor}`}>
                {current > 0 ? formatLapTime(current) : "--:--.---"}
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-[10px] text-app-text-muted">Last</span>
                <span className="text-sm font-mono font-bold text-app-text-secondary tabular-nums">{last > 0 ? formatLapTime(last) : "-"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[10px] text-purple-400">Best</span>
                <span className="text-sm font-mono font-bold text-purple-400 tabular-nums">{best > 0 ? formatLapTime(best) : "-"}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
