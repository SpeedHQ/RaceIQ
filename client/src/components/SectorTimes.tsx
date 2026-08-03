import { useEffect, useRef } from "react";
import { lapPaceColor, SECTOR_COLOR_VARS } from "@/lib/colors";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import type { LiveSectorData } from "../../../shared/racing/live/types";
import { getSoundEnabled, getSoundType, getSoundUrl, getSoundVolume } from "./Settings";

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

/** Cache fetched audio buffers by URL with bounded LRU eviction. */
const MAX_AUDIO_BUFFER_CACHE_SIZE = 8;
const audioBufferCache = new Map<string, AudioBuffer>();
const loadingAudioBuffers = new Map<string, Promise<AudioBuffer | null>>();
const invalidatedLoadingUrls = new Set<string>();

function getCachedAudioBuffer(url: string): AudioBuffer | null {
  const cached = audioBufferCache.get(url);
  if (!cached) return null;
  audioBufferCache.delete(url);
  audioBufferCache.set(url, cached);
  return cached;
}

function enforceAudioBufferLimit(): void {
  while (audioBufferCache.size > MAX_AUDIO_BUFFER_CACHE_SIZE) {
    const oldestUrl = audioBufferCache.keys().next().value;
    if (!oldestUrl) break;
    audioBufferCache.delete(oldestUrl);
  }
}

export function removeCachedSound(url: string): void {
  if (!url) return;
  audioBufferCache.delete(url);
  if (loadingAudioBuffers.has(url)) invalidatedLoadingUrls.add(url);
}

async function loadAudioBuffer(url: string): Promise<AudioBuffer | null> {
  invalidatedLoadingUrls.delete(url);
  const cached = getCachedAudioBuffer(url);
  if (cached) return cached;

  const inFlight = loadingAudioBuffers.get(url);
  if (inFlight) return inFlight;

  const loadPromise = Promise.resolve().then(async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const arrayBuf = await res.arrayBuffer();
      const ctx = getAudioContext();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);
      if (!invalidatedLoadingUrls.has(url)) {
        audioBufferCache.set(url, audioBuf);
        enforceAudioBufferLimit();
      }
      return audioBuf;
    } catch {
      return null;
    } finally {
      loadingAudioBuffers.delete(url);
      invalidatedLoadingUrls.delete(url);
    }
  });
  loadingAudioBuffers.set(url, loadPromise);
  return loadPromise;
}

/** Preload a URL sound into cache. Call from settings when URL changes. */
export function preloadSound(url: string) {
  if (!url) return;
  void loadAudioBuffer(url);
}

function playSample(url: string, pitch = 1) {
  const buf = getCachedAudioBuffer(url);
  if (!buf) {
    loadAudioBuffer(url).then((b) => {
      if (b) playBuffer(b, pitch);
    });
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
      if (url) {
        playSample(url, pitch);
        return;
      }
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
