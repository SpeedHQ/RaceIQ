import { LIVE_ENGINEER_AUDIO_CATALOG, LIVE_ENGINEER_AUDIO_CATALOG_VERSION } from "../../../shared/racing/live/engineer-audio-catalog.generated";

interface CatalogSegment { segmentId: string; url: string; sha256: string; durationMs: number; }
export interface LiveEngineerAudioOptions { fetchImpl?: typeof fetch; audioContext?: AudioContext; }

export class LiveEngineerAudioPlayer {
  private readonly fetchImpl: typeof fetch;
  private readonly context: AudioContext;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private readonly active = new Set<AudioBufferSourceNode>();
  private readonly gainNode: GainNode;
  private cursor = 0;
  constructor(options: LiveEngineerAudioOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.context = options.audioContext ?? new AudioContext();
    this.gainNode = this.context.createGain(); this.gainNode.connect(this.context.destination); this.setVolume(0.8);
  }
  setVolume(value: number): void { this.gainNode.gain.value = Math.min(1, Math.max(0, value)); }
  stop(): void { for (const source of this.active) { try { source.stop(); } catch {} } this.active.clear(); this.cursor = 0; }
  async play(segmentIds: readonly string[], volume = this.gainNode.gain.value): Promise<void> {
    this.setVolume(volume); if (this.context.state === "suspended") await this.context.resume();
    const segments = segmentIds.map((id) => this.find(id));
    const buffers = await Promise.all(segments.map((segment) => this.load(segment)));
    this.stop(); this.cursor = this.context.currentTime;
    buffers.forEach((buffer) => { const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gainNode); source.start(this.cursor); this.cursor += buffer.duration + LIVE_ENGINEER_AUDIO_CATALOG.joinGapMs / 1000; this.active.add(source); source.onended = () => this.active.delete(source); });
  }
  private find(id: string): CatalogSegment { const segment = (LIVE_ENGINEER_AUDIO_CATALOG.segments as readonly CatalogSegment[]).find((entry) => entry.segmentId === id); if (!segment || LIVE_ENGINEER_AUDIO_CATALOG.catalogVersion !== LIVE_ENGINEER_AUDIO_CATALOG_VERSION) throw new Error(`audio segment unavailable: ${id}`); return segment; }
  private load(segment: CatalogSegment): Promise<AudioBuffer> { let promise = this.buffers.get(segment.segmentId); if (!promise) { promise = this.fetchImpl(segment.url).then(async (response) => { if (!response.ok) throw new Error(`audio asset missing: ${segment.segmentId}`); const bytes = new Uint8Array(await response.arrayBuffer()); const hash = await crypto.subtle.digest("SHA-256", bytes); const actual = [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join(""); if (actual !== segment.sha256) throw new Error(`audio asset hash mismatch: ${segment.segmentId}`); return this.context.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer); }); this.buffers.set(segment.segmentId, promise); } return promise; }
}
