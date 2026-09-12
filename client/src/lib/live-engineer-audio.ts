const QWEN_CATALOG_URL = "/audio/live-engineer/qwen-v2/manifest.json";
const QWEN_CATALOG_VERSION = "live-engineer-qwen-v2";
export const DEFAULT_JOIN_GAP_MS = -10;
export const DEFAULT_RADIO_FILTER = { lowCutHz: 250, highCutHz: 3000 } as const;
export const DEFAULT_RADIO_COMPRESSOR = { thresholdDb: -24, ratio: 6 } as const;
export const LAP_TIME_MINUTE_PAUSE_MS = 100;

export function getSegmentPauseMs(segmentId: string): number {
  return segmentId === "unit.minute" ? LAP_TIME_MINUTE_PAUSE_MS / 1000 : 0;
}

const RADIO_DRIVE_AMOUNT = 0.4;

function createRadioDriveCurve(): WaveShaperNode["curve"] {
  const curve = new Float32Array(257);
  const amount = RADIO_DRIVE_AMOUNT;
  for (let index = 0; index < curve.length; index += 1) {
    const x = (index * 2) / (curve.length - 1) - 1;
    curve[index] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}

const SPEECH_THRESHOLD = 0.01;

export function speechBoundsMs(samples: Float32Array, sampleRate: number): { startMs: number; endMs: number } {
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]!) < SPEECH_THRESHOLD) start += 1;
  if (start === samples.length) return { startMs: 0, endMs: (samples.length / sampleRate) * 1000 };
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1]!) < SPEECH_THRESHOLD) end -= 1;
  return { startMs: (start / sampleRate) * 1000, endMs: (end / sampleRate) * 1000 };
}

function getSpeechBounds(buffer: AudioBuffer): { startMs: number; endMs: number } {
  const samples = buffer.getChannelData(0);
  return speechBoundsMs(samples, buffer.sampleRate);
}

interface CatalogSegment {
  segmentId: string;
  path: string;
  sha256: string;
  durationMs: number;
}

interface CatalogFullLine {
  lineId: string;
  path: string;
  sha256: string;
  durationMs: number;
}
interface QwenCatalog {
  catalogVersion: string;
  sampleRate: number;
  channels: number;
  joinGapMs?: number;
  clips: CatalogSegment[];
  fullLines: CatalogFullLine[];
}

export type LiveEngineerAudioErrorCode = "audio-blocked" | "asset-missing" | "decode-failed" | "catalog-mismatch";

export class LiveEngineerAudioError extends Error {
  readonly code: LiveEngineerAudioErrorCode;

  constructor(code: LiveEngineerAudioErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface LiveEngineerAudioOptions {
  fetchImpl?: typeof fetch;
  audioContext?: AudioContext;
  radioEffect?: boolean;
}

export class LiveEngineerAudioPlayer {
  private readonly fetchImpl: typeof fetch;
  private readonly context: AudioContext;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private readonly active = new Set<AudioBufferSourceNode>();
  private readonly gainNode: GainNode;
  private readonly highPassNode: BiquadFilterNode;
  private readonly lowPassNode: BiquadFilterNode;
  private readonly compressorNode: DynamicsCompressorNode;
  private readonly driveNode: WaveShaperNode;

  private catalog: Promise<QwenCatalog> | null = null;
  private completion: (() => void) | null = null;
  private stopped = false;

  constructor(options: LiveEngineerAudioOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.context = options.audioContext ?? new AudioContext();
    this.gainNode = this.context.createGain();
    this.highPassNode = this.context.createBiquadFilter();
    this.lowPassNode = this.context.createBiquadFilter();
    this.compressorNode = this.context.createDynamicsCompressor();
    this.driveNode = this.context.createWaveShaper();

    this.highPassNode.type = "highpass";
    this.highPassNode.frequency.value = DEFAULT_RADIO_FILTER.lowCutHz;
    this.lowPassNode.type = "lowpass";
    this.lowPassNode.frequency.value = DEFAULT_RADIO_FILTER.highCutHz;
    this.compressorNode.threshold.value = DEFAULT_RADIO_COMPRESSOR.thresholdDb;
    this.compressorNode.knee.value = 12;
    this.compressorNode.ratio.value = DEFAULT_RADIO_COMPRESSOR.ratio;
    this.compressorNode.attack.value = 0.003;
    this.compressorNode.release.value = 0.12;
    this.driveNode.curve = createRadioDriveCurve();
    this.driveNode.oversample = "2x";

    if (options.radioEffect ?? true) {
      this.gainNode.connect(this.highPassNode);
      this.highPassNode.connect(this.lowPassNode);
      this.lowPassNode.connect(this.compressorNode);
      this.compressorNode.connect(this.driveNode);
      this.driveNode.connect(this.context.destination);
    } else {
      this.gainNode.connect(this.context.destination);
    }
    this.setVolume(0.8);
  }

  setVolume(value: number): void {
    this.gainNode.gain.value = Math.min(1, Math.max(0, value));
  }

  stop(): void {
    this.stopped = true;
    for (const source of this.active) {
      try { source.stop(); } catch {}
    }
    this.active.clear();
    this.completion?.();
    this.completion = null;
  }

  async play(segmentIds: readonly string[], volume = this.gainNode.gain.value): Promise<void> {
    const catalog = await this.loadCatalog();
    const segments = segmentIds.map((id) => {
      const segment = catalog.clips.find((entry) => entry.segmentId === id);
      if (!segment) throw new LiveEngineerAudioError("asset-missing", `Audio segment unavailable: ${id}`);
      return segment;
    });
    return this.playEntries(segments, volume, catalog.joinGapMs ?? DEFAULT_JOIN_GAP_MS);
  }
  async playFullLine(lineId: string, volume = this.gainNode.gain.value): Promise<void> {
    const catalog = await this.loadCatalog();
    const line = catalog.fullLines.find((entry) => entry.lineId === lineId);
    if (!line) throw new LiveEngineerAudioError("asset-missing", `Audio full line unavailable: ${lineId}`);
    return this.playEntries([{ segmentId: line.lineId, path: line.path, sha256: line.sha256, durationMs: line.durationMs }], volume, 0);
  }

  private async playEntries(segments: readonly CatalogSegment[], volume: number, joinGapMs: number): Promise<void> {

    this.stopped = false;
    this.setVolume(volume);
    if (this.context.state === "suspended") {
      try { await this.context.resume(); }
      catch { throw new LiveEngineerAudioError("audio-blocked", "Audio context blocked"); }
    }
    const buffers = await Promise.all(segments.map((segment) => this.load(segment)));
    if (this.stopped) return;

    this.stop();
    this.stopped = false;
    const startTime = this.context.currentTime + 0.1;
    const joinGap = joinGapMs / 1000;
    const speechBounds = buffers.map(getSpeechBounds);
    let previousSpeechEnd = startTime + speechBounds[0]!.endMs / 1000;
    return new Promise<void>((resolve) => {
      this.completion = resolve;
      buffers.forEach((buffer, index) => {
        const bounds = speechBounds[index]!;
        const sourceStart = index === 0
          ? startTime
          : previousSpeechEnd + joinGap + getSegmentPauseMs(segments[index - 1]!.segmentId) - bounds.startMs / 1000;
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode);
        source.start(sourceStart);
        previousSpeechEnd = sourceStart + bounds.endMs / 1000;
        this.active.add(source);
        source.onended = () => {
          this.active.delete(source);
          if (!this.active.size) {
            this.completion?.();
            this.completion = null;
          }
        };
      });
    });
  }

  private loadCatalog(): Promise<QwenCatalog> {
    if (!this.catalog) {
      this.catalog = this.fetchImpl(QWEN_CATALOG_URL).then(async (response) => {
        if (!response.ok) throw new LiveEngineerAudioError("asset-missing", "Qwen audio catalog missing");
        const catalog = await response.json() as QwenCatalog;
        if (catalog.catalogVersion !== QWEN_CATALOG_VERSION || !Array.isArray(catalog.clips)) {
          throw new LiveEngineerAudioError("catalog-mismatch", "Qwen audio catalog mismatch");
        }
        return catalog;
      });
    }
    return this.catalog;
  }

  private load(segment: CatalogSegment): Promise<AudioBuffer> {
    let promise = this.buffers.get(segment.segmentId);
    if (!promise) {
      const url = `/audio/live-engineer/qwen-v2/${segment.path}`;
      promise = this.fetchImpl(url).then(async (response) => {
        if (!response.ok) throw new LiveEngineerAudioError("asset-missing", `Audio asset missing: ${segment.segmentId}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        const actual = [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
        if (actual !== segment.sha256) throw new LiveEngineerAudioError("catalog-mismatch", `Audio asset hash mismatch: ${segment.segmentId}`);
        try { return await this.context.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer); }
        catch { throw new LiveEngineerAudioError("decode-failed", `Unable to decode ${segment.segmentId}`); }
      });
      this.buffers.set(segment.segmentId, promise);
    }
    return promise;
  }
}
