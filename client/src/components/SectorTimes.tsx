import { useState, useEffect, useRef, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";
import { formatLapTime } from "./LiveTelemetry";
import { useStatus, useTrackSectorBoundaries } from "../hooks/queries";
import { getSoundEnabled, getSoundVolume, getSoundType, getSoundUrl } from "./Settings";

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
let loadingUrls = new Set<string>();

async function loadAudioBuffer(url: string): Promise<AudioBuffer | null> {
  if (audioBufferCache.has(url)) return audioBufferCache.get(url)!;
  if (loadingUrls.has(url)) return null; // already loading
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
    // Not cached yet — load and play when ready
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

/** Play a synth blip tone. */
function playSynth(frequency = 880, duration = 0.08) {
  const volume = getSoundVolume();
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

/**
 * Play the sector blip — uses synth, a bundled preset, or custom URL.
 * frequency/duration only apply to synth mode.
 */
export function playBlip(pitch = 1) {
  try {
    const type = getSoundType();
    if (type === "url") {
      const url = getSoundUrl();
      if (url) { playSample(url, pitch); return; }
      playSample("/sounds/beep-2.mp3", pitch); // fallback
    } else {
      playSample(`/sounds/${type}.mp3`, pitch);
    }
  } catch {}
}

/**
 * SectorTimes — Distance-based sector split timing.
 * Forza doesn't expose sector boundaries, so we use pre-computed fractional
 * positions (s1End, s2End) from the track outline's distance analysis.
 *
 * Shows: current sector time, last/best per sector, delta to best,
 * and estimated lap time based on best sectors + current pace.
 */
export function SectorTimes({ packet }: { packet: TelemetryPacket | null }) {
  const { data: status } = useStatus();
  const trackOrd = packet?.TrackOrdinal ?? (status as any)?.currentSession?.trackOrdinal;
  const { data: sectorsData } = useTrackSectorBoundaries(trackOrd);
  const sectors = (sectorsData as any)?.s1End ? sectorsData as { s1End: number; s2End: number; trackLength?: number } : null;
  const sectorStateRef = useRef<{
    lapDistStart: number;
    lapDistTotal: number;
    currentSector: number;
    sectorStartTime: number;
    currentTimes: [number, number, number];
    bestTimes: [number, number, number];
    lastTimes: [number, number, number];
    lastLap: number;
    bestLapTime: number;
    lastLapTime: number;
    initialized: boolean;
  }>({
    lapDistStart: 0,
    lapDistTotal: 0,
    currentSector: 0,
    sectorStartTime: 0,
    currentTimes: [0, 0, 0],
    bestTimes: [Infinity, Infinity, Infinity],
    lastTimes: [0, 0, 0],
    lastLap: 0,
    bestLapTime: Infinity,
    lastLapTime: 0,
    initialized: false,
  });
  const [, tick] = useState(0);

  // Seed lapDistTotal from track outline length when available
  useEffect(() => {
    if (!sectors?.trackLength || sectors.trackLength <= 0) return;
    const s = sectorStateRef.current;
    if (s.lapDistTotal <= 0) {
      s.lapDistTotal = sectors.trackLength;
    }
  }, [sectors?.trackLength]);

  useEffect(() => {
    if (!packet || !sectors) return;
    const s = sectorStateRef.current;

    // Initialize lapDistStart from first packet so we don't have a huge offset
    if (!s.initialized) {
      s.initialized = true;
      s.lapDistStart = packet.DistanceTraveled;
      s.lastLap = packet.LapNumber;
      s.sectorStartTime = packet.CurrentLap;
    }

    // Handle demo loop: if distance jumps backward, re-initialize
    if (packet.DistanceTraveled < s.lapDistStart - 100) {
      s.lapDistStart = packet.DistanceTraveled;
      s.currentSector = 0;
      s.sectorStartTime = packet.CurrentLap;
      s.currentTimes = [0, 0, 0];
    }

    // Lap boundary crossed
    if (packet.LapNumber > s.lastLap && s.lastLap > 0) {
      if (s.currentTimes[0] > 0 && s.currentTimes[1] > 0) {
        s.lastTimes = [...s.currentTimes] as [number, number, number];
        s.lastTimes[2] = packet.LastLap - s.currentTimes[0] - s.currentTimes[1];
        if (s.lastTimes[2] < 0) s.lastTimes[2] = 0;

        for (let i = 0; i < 3; i++) {
          if (s.lastTimes[i] > 0 && s.lastTimes[i] < s.bestTimes[i]) {
            s.bestTimes[i] = s.lastTimes[i];
          }
        }
      }

      // Track best/last full lap time
      if (packet.LastLap > 0) {
        s.lastLapTime = packet.LastLap;
        if (packet.LastLap < s.bestLapTime) {
          s.bestLapTime = packet.LastLap;
        }
      }

      // Refine lapDistTotal from actual completed distance
      const completedDist = packet.DistanceTraveled - s.lapDistStart;
      if (completedDist > 100) {
        s.lapDistTotal = completedDist;
      }

      s.lapDistStart = packet.DistanceTraveled;
      s.currentSector = 0;
      s.sectorStartTime = 0;
      s.currentTimes = [0, 0, 0];

      // Blip on lap completion (lower pitch than sector)
      if (getSoundEnabled()) {
        playBlip(1.0);
      }
    }
    s.lastLap = packet.LapNumber;

    // Sector boundary detection — works immediately using outline-based trackLength
    if (s.lapDistTotal > 0) {
      const lapDist = packet.DistanceTraveled - s.lapDistStart;
      const frac = lapDist / s.lapDistTotal;

      const expectedSector =
        frac < sectors.s1End ? 0 :
        frac < sectors.s2End ? 1 : 2;

      if (expectedSector > s.currentSector) {
        s.currentTimes[s.currentSector] = packet.CurrentLap - s.sectorStartTime;
        s.sectorStartTime = packet.CurrentLap;
        s.currentSector = expectedSector;
        // Blip on sector boundary (higher pitch)
        if (getSoundEnabled()) {
          playBlip(1.5);
        }
      }
    }

    tick((v) => v + 1);
  }, [packet, sectors]);

  if (!sectors) return null;

  const s = sectorStateRef.current;
  const sectorNames = ["S1", "S2", "S3"];
  const sectorColors = ["#ef4444", "#3b82f6", "#eab308"];

  // Compute estimated lap time:
  // Completed sectors use actual times, remaining use best times
  const hasBests = s.bestTimes[0] < Infinity && s.bestTimes[1] < Infinity && s.bestTimes[2] < Infinity;
  let estimatedLap = 0;
  if (hasBests && packet) {
    for (let i = 0; i < 3; i++) {
      if (i < s.currentSector) {
        // Completed sector — use actual time
        estimatedLap += s.currentTimes[i];
      } else if (i === s.currentSector) {
        // Current sector — use running time
        const running = packet.CurrentLap - s.sectorStartTime;
        estimatedLap += running;
        // For remaining sectors after current, use best times
      } else {
        estimatedLap += s.bestTimes[i];
      }
    }
  }

  // Delta to best lap
  const deltaToBest = hasBests && packet && packet.CurrentLap > 0 && s.bestLapTime < Infinity
    ? estimatedLap - s.bestLapTime
    : null;

  return (
    <div className="border-t border-app-border/50 pt-3">
      {/* Estimated lap time */}
      {hasBests && packet && packet.CurrentLap > 0 && (
        <div className="flex items-baseline gap-4 mb-3 pb-2 border-b border-app-border/50">
          <div>
            <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Est. Lap</div>
            <div className="text-2xl font-mono font-bold text-app-text tabular-nums leading-none">
              {formatLapTime(estimatedLap)}
            </div>
          </div>
          {deltaToBest !== null && (
            <div>
              <div className="text-[10px] text-app-text-muted uppercase tracking-wider">vs Best</div>
              <div className={`text-2xl font-mono font-bold tabular-nums leading-none ${deltaToBest <= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {deltaToBest <= 0 ? "" : "+"}{deltaToBest.toFixed(3)}
              </div>
            </div>
          )}
          {s.bestLapTime < Infinity && (
            <div className="ml-auto">
              <div className="text-[10px] text-purple-400 uppercase tracking-wider">Best Lap</div>
              <div className="text-lg font-mono font-bold text-purple-400 tabular-nums leading-none">{formatLapTime(s.bestLapTime)}</div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {sectorNames.map((name, i) => {
          const current = i === s.currentSector ? (packet ? packet.CurrentLap - s.sectorStartTime : 0) : s.currentTimes[i];
          const best = s.bestTimes[i] < Infinity ? s.bestTimes[i] : 0;
          const last = s.lastTimes[i];
          const isActive = i === s.currentSector;

          // Split delta: show for completed sectors this lap
          const isDone = i < s.currentSector && s.currentTimes[i] > 0;
          const showDelta = isDone && best > 0;
          const delta = showDelta ? s.currentTimes[i] - best : 0;

          // Color code completed sectors by pace: purple=best, green=on pace, orange=off pace
          let timeColor = "text-app-text"; // default / active
          if (isDone && best > 0) {
            if (s.currentTimes[i] <= best * 1.001) timeColor = "text-purple-400"; // best
            else if (delta <= 0.3) timeColor = "text-emerald-400"; // on pace
            else timeColor = "text-orange-400"; // off pace
          }

          return (
            <div key={name} className={`rounded p-2.5 ${isActive ? "bg-app-surface-alt/80 ring-1" : "bg-app-surface-alt/30"}`} style={isActive ? { ringColor: sectorColors[i] } : {}}>
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
