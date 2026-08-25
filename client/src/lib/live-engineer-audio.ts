const QWEN_CATALOG_URL = "/audio/live-engineer/qwen-v1/manifest.json";
const QWEN_CATALOG_VERSION = "live-engineer-qwen-v1";

interface CatalogSegment {
  segmentId: string;
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
}

export class LiveEngineerAudioPlayer {
  private readonly fetchImpl: typeof fetch;
  private readonly context: AudioContext;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private readonly active = new Set<AudioBufferSourceNode>();
  private readonly gainNode: GainNode;
  private catalog: Promise<QwenCatalog> | null = null;
  private completion: (() => void) | null = null;
  private stopped = false;

  constructor(options: LiveEngineerAudioOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.context = options.audioContext ?? new AudioContext();
    this.gainNode = this.context.createGain();
    this.gainNode.connect(this.context.destination);
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
    this.stopped = false;
    this.setVolume(volume);
    if (this.context.state === "suspended") {
      try { await this.context.resume(); }
      catch { throw new LiveEngineerAudioError("audio-blocked", "Audio context blocked"); }
    }
    const catalog = await this.loadCatalog();
    const segments = segmentIds.map((id) => {
      const segment = catalog.clips.find((entry) => entry.segmentId === id);
      if (!segment) throw new LiveEngineerAudioError("asset-missing", `Audio segment unavailable: ${id}`);
      return segment;
    });
    const buffers = await Promise.all(segments.map((segment) => this.load(segment)));
    if (this.stopped) return;

    this.stop();
    this.stopped = false;
    let sourceStart = this.context.currentTime + 0.1;
    const joinGap = (catalog.joinGapMs ?? -500) / 1000;
    return new Promise<void>((resolve) => {
      this.completion = resolve;
      buffers.forEach((buffer, index) => {
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode);
        source.start(sourceStart);
        sourceStart += segments[index].durationMs / 1000 + joinGap;
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
      const url = `/audio/live-engineer/qwen-v1/${segment.path}`;
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
