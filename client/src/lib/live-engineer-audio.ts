const QWEN_CATALOG_URL = "/audio/live-engineer/qwen-v3/manifest.json";
const QWEN_CATALOG_VERSION = "live-engineer-qwen-v3";
export const DEFAULT_JOIN_GAP_MS = 0;
export const DEFAULT_RADIO_FILTER = { lowCutHz: 250, highCutHz: 3000 } as const;
export const DEFAULT_RADIO_COMPRESSOR = { thresholdDb: -24, ratio: 6 } as const;
export const LAP_TIME_MINUTE_PAUSE_MS = 0;
export function getSegmentPauseMs(_segmentId: string): number { return 0; }

const RADIO_DRIVE_AMOUNT = 0.4;
function createRadioDriveCurve(): WaveShaperNode["curve"] { const curve = new Float32Array(257); for (let index = 0; index < curve.length; index += 1) { const x = (index * 2) / (curve.length - 1) - 1; curve[index] = ((1 + RADIO_DRIVE_AMOUNT) * x) / (1 + RADIO_DRIVE_AMOUNT * Math.abs(x)); } return curve; }
export function speechBoundsMs(samples: Float32Array, sampleRate: number): { startMs: number; endMs: number } { let start = 0; while (start < samples.length && Math.abs(samples[start]!) < 0.01) start += 1; if (start === samples.length) return { startMs: 0, endMs: samples.length / sampleRate * 1000 }; let end = samples.length; while (end > start && Math.abs(samples[end - 1]!) < 0.01) end -= 1; return { startMs: start / sampleRate * 1000, endMs: end / sampleRate * 1000 }; }

interface CatalogSegment { segmentId: string; path: string; sha256: string; durationMs: number; }
interface CatalogFullLine { lineId: string; path: string; sha256: string; durationMs: number; }
export interface CatalogOracle { oracleId: string; text: string; path: string; sha256: string; durationMs: number; recipeSegmentIds: readonly string[]; }
interface QwenCatalog { catalogVersion: string; sampleRate: number; channels: number; assembly?: { mode: string; gapMs: number }; approvedForProduction?: boolean; listeningStatus?: string; approvals?: { fixed?: Record<string, string>; recipes?: Array<{ status: string }> }; clips: CatalogSegment[]; fullLines: CatalogFullLine[]; oracles?: CatalogOracle[]; }
export type LiveEngineerAudioErrorCode = "audio-blocked" | "asset-missing" | "decode-failed" | "catalog-mismatch";
export class LiveEngineerAudioError extends Error { readonly code: LiveEngineerAudioErrorCode; constructor(code: LiveEngineerAudioErrorCode, message: string) { super(message); this.code = code; } }
export interface LiveEngineerAudioOptions { fetchImpl?: (...args: Parameters<typeof fetch>) => Promise<Response>; audioContext?: AudioContext; radioEffect?: boolean; catalog?: { url: string; version: string }; allowUnapprovedCatalog?: boolean; }

export class LiveEngineerAudioPlayer {
  private readonly fetchImpl: NonNullable<LiveEngineerAudioOptions["fetchImpl"]>;
  private readonly context: AudioContext;
  private readonly catalogUrl: string;
  private readonly catalogVersion: string;
  private readonly assetBaseUrl: string;
  private readonly allowUnapprovedCatalog: boolean;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private readonly active = new Set<AudioBufferSourceNode>();
  private readonly gainNode: GainNode;
  private readonly highPassNode: BiquadFilterNode;
  private readonly lowPassNode: BiquadFilterNode;
  private readonly compressorNode: DynamicsCompressorNode;
  private readonly driveNode: WaveShaperNode;
  private catalog: Promise<QwenCatalog> | null = null;
  private completion: (() => void) | null = null;
  private generation = 0;
  private abortController = new AbortController();

  constructor(options: LiveEngineerAudioOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis); this.catalogUrl = options.catalog?.url ?? QWEN_CATALOG_URL; this.catalogVersion = options.catalog?.version ?? QWEN_CATALOG_VERSION; this.assetBaseUrl = this.catalogUrl.slice(0, this.catalogUrl.lastIndexOf("/") + 1); this.allowUnapprovedCatalog = options.allowUnapprovedCatalog ?? true; this.context = options.audioContext ?? new AudioContext();
    this.gainNode = this.context.createGain(); this.highPassNode = this.context.createBiquadFilter(); this.lowPassNode = this.context.createBiquadFilter(); this.compressorNode = this.context.createDynamicsCompressor(); this.driveNode = this.context.createWaveShaper();
    this.highPassNode.type = "highpass"; this.highPassNode.frequency.value = DEFAULT_RADIO_FILTER.lowCutHz; this.lowPassNode.type = "lowpass"; this.lowPassNode.frequency.value = DEFAULT_RADIO_FILTER.highCutHz; this.compressorNode.threshold.value = DEFAULT_RADIO_COMPRESSOR.thresholdDb; this.compressorNode.knee.value = 12; this.compressorNode.ratio.value = DEFAULT_RADIO_COMPRESSOR.ratio; this.compressorNode.attack.value = 0.003; this.compressorNode.release.value = 0.12; this.driveNode.curve = createRadioDriveCurve(); this.driveNode.oversample = "2x";
    if (options.radioEffect ?? true) { this.gainNode.connect(this.highPassNode); this.highPassNode.connect(this.lowPassNode); this.lowPassNode.connect(this.compressorNode); this.compressorNode.connect(this.driveNode); this.driveNode.connect(this.context.destination); } else this.gainNode.connect(this.context.destination); this.setVolume(0.8);
  }
  setVolume(value: number): void { this.gainNode.gain.value = Math.min(1, Math.max(0, value)); }
  stop(): void { this.generation += 1; this.abortController.abort(); this.abortController = new AbortController(); this.catalog = null; this.buffers.clear(); for (const source of this.active) { try { source.stop(); } catch {} } this.active.clear(); this.completion?.(); this.completion = null; }
  async play(segmentIds: readonly string[], volume = this.gainNode.gain.value): Promise<void> { const generation = this.generation; const catalog = await this.loadCatalog(); this.assertCurrent(generation); const segments = segmentIds.map((id) => { const segment = catalog.clips.find((entry) => entry.segmentId === id); if (!segment) throw new LiveEngineerAudioError("asset-missing", `Audio segment unavailable: ${id}`); return segment; }); return this.playEntries(segments, volume, catalog.assembly?.gapMs ?? DEFAULT_JOIN_GAP_MS, generation); }
  async playFullLine(lineId: string, volume = this.gainNode.gain.value): Promise<void> { const generation = this.generation; const catalog = await this.loadCatalog(); this.assertCurrent(generation); const line = catalog.fullLines.find((entry) => entry.lineId === lineId); if (!line) throw new LiveEngineerAudioError("asset-missing", `Audio full line unavailable: ${lineId}`); return this.playEntries([{ segmentId: line.lineId, path: line.path, sha256: line.sha256, durationMs: line.durationMs }], volume, 0, generation); }
  async playOracle(oracleId: string, volume = this.gainNode.gain.value): Promise<void> { const generation = this.generation; const catalog = await this.loadCatalog(); this.assertCurrent(generation); const oracle = catalog.oracles?.find((entry) => entry.oracleId === oracleId); if (!oracle) throw new LiveEngineerAudioError("asset-missing", `Audio oracle unavailable: ${oracleId}`); return this.playEntries([{ segmentId: oracle.oracleId, path: oracle.path, sha256: oracle.sha256, durationMs: oracle.durationMs }], volume, 0, generation); }
  private async playEntries(segments: readonly CatalogSegment[], volume: number, joinGapMs: number, generation: number): Promise<void> { this.assertCurrent(generation); this.setVolume(volume); if (this.context.state === "suspended") { try { await this.context.resume(); } catch { throw new LiveEngineerAudioError("audio-blocked", "Audio context blocked"); } } this.assertCurrent(generation); const buffers = await Promise.all(segments.map((segment) => this.load(segment, generation))); this.assertCurrent(generation); this.stop(); const scheduledGeneration = this.generation; this.setVolume(volume); const startTime = this.context.currentTime + 0.1; const gap = joinGapMs / 1000; let previousStart = startTime; let previousDuration = 0; return new Promise<void>((resolve) => { this.completion = resolve; buffers.forEach((buffer, index) => { const sourceStart = index === 0 ? startTime : previousStart + previousDuration + gap; const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gainNode); source.start(sourceStart); previousStart = sourceStart; previousDuration = buffer.duration; this.active.add(source); source.onended = () => { this.active.delete(source); if (scheduledGeneration === this.generation && !this.active.size) { this.completion?.(); this.completion = null; } }; }); }); }
  private assertCurrent(generation: number): void { if (generation !== this.generation || this.abortController.signal.aborted) throw new LiveEngineerAudioError("catalog-mismatch", "Playback superseded"); }
  private loadCatalog(): Promise<QwenCatalog> { if (!this.catalog) { const signal = this.abortController.signal; this.catalog = this.fetchImpl(this.catalogUrl, { signal }).then(async (response) => { if (!response.ok) throw new LiveEngineerAudioError("asset-missing", "Qwen audio catalog missing"); const catalog = await response.json() as QwenCatalog; if (catalog.catalogVersion !== this.catalogVersion || !Array.isArray(catalog.clips)) throw new LiveEngineerAudioError("catalog-mismatch", "Qwen audio catalog mismatch"); if (catalog.catalogVersion === "live-engineer-qwen-v3" && !this.allowUnapprovedCatalog && (catalog.approvedForProduction !== true || catalog.listeningStatus !== "approved" || Object.values(catalog.approvals?.fixed ?? {}).some((status) => status !== "approved") || (catalog.approvals?.recipes ?? []).some((recipe) => recipe.status !== "approved"))) throw new LiveEngineerAudioError("catalog-mismatch", "Qwen audio catalog is not production-approved"); return catalog; }); } return this.catalog; }
  private load(segment: CatalogSegment, generation: number): Promise<AudioBuffer> { let promise = this.buffers.get(segment.segmentId); if (!promise) { const signal = this.abortController.signal; promise = this.fetchImpl(`${this.assetBaseUrl}${segment.path}`, { signal }).then(async (response) => { if (!response.ok) throw new LiveEngineerAudioError("asset-missing", `Audio asset missing: ${segment.segmentId}`); const bytes = new Uint8Array(await response.arrayBuffer()); this.assertCurrent(generation); const hash = await crypto.subtle.digest("SHA-256", bytes); this.assertCurrent(generation); const actual = [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join(""); if (actual !== segment.sha256) throw new LiveEngineerAudioError("catalog-mismatch", `Audio asset hash mismatch: ${segment.segmentId}`); try { const decoded = await this.context.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer); this.assertCurrent(generation); return decoded; } catch { throw new LiveEngineerAudioError("decode-failed", `Unable to decode ${segment.segmentId}`); } }); this.buffers.set(segment.segmentId, promise); } return promise; }
}
