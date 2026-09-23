import { getSoundType, getSoundUrl, getSoundVolume } from "./settings-storage";

/** Shared AudioContext — reused across all blips to avoid browser throttling. */
let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") sharedAudioCtx = new AudioContext();
  if (sharedAudioCtx.state === "suspended") void sharedAudioCtx.resume();
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
export function preloadSound(url: string): void {
  if (!url) return;
  void loadAudioBuffer(url);
}

function playSample(url: string, pitch = 1): void {
  const buf = getCachedAudioBuffer(url);
  if (!buf) {
    void loadAudioBuffer(url).then((loaded) => {
      if (loaded) playBuffer(loaded, pitch);
    });
    return;
  }
  playBuffer(buf, pitch);
}

function playBuffer(buf: AudioBuffer, pitch = 1): void {
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

export function playBlip(pitch = 1): void {
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
