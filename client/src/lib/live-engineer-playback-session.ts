import type { LiveEngineerVoiceLineMessageV3, LiveEngineerDeliveryStatusV3, LiveEngineerVoiceRequestV3 } from "../../../shared/racing/live/engineer-contracts";
type Control = LiveEngineerDeliveryStatusV3 | LiveEngineerVoiceRequestV3;
export interface LiveEngineerAudioPort { play(segmentIds: readonly string[]): Promise<void>; stop(): void; setVolume(value: number): void; }
export interface LiveEngineerPlaybackCallbacks { enqueueControl(message: Control): void; finishVoiceLine(deliveryId: string): void; setPlayback(playback: "idle" | "playing" | "failed"): void; }
export class LiveEngineerPlaybackSession {
  private generation = 0;
  private activeDeliveryId: string | null = null;
  private readonly audio: LiveEngineerAudioPort;
  private readonly callbacks: LiveEngineerPlaybackCallbacks;
  private readonly now: () => number;

  constructor(audio: LiveEngineerAudioPort, callbacks: LiveEngineerPlaybackCallbacks, now: () => number = () => Date.now()) {
    this.audio = audio;
    this.callbacks = callbacks;
    this.now = now;
  }

  start(line: LiveEngineerVoiceLineMessageV3, enabled: boolean, volume: number): void {
    this.cancel();
    const generation = ++this.generation;
    this.activeDeliveryId = line.deliveryId;
    this.audio.setVolume(volume);
    if (!enabled) {
      this.callbacks.enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 3, deliveryId: line.deliveryId, status: "muted", reason: "radio-disabled" });
      this.callbacks.finishVoiceLine(line.deliveryId);
      this.activeDeliveryId = null;
      return;
    }
    if (line.expiresSessionTimeMs <= this.now()) {
      this.callbacks.enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 3, deliveryId: line.deliveryId, status: "failed", reason: "expired" });
      this.callbacks.finishVoiceLine(line.deliveryId);
      this.callbacks.setPlayback("failed");
      this.activeDeliveryId = null;
      return;
    }
    this.callbacks.setPlayback("playing");
    this.callbacks.enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 3, deliveryId: line.deliveryId, status: "started" });
    this.audio.play(line.segmentIds).then(() => {
      if (generation !== this.generation || this.activeDeliveryId !== line.deliveryId) return;
      this.callbacks.enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 3, deliveryId: line.deliveryId, status: "completed" });
      this.callbacks.finishVoiceLine(line.deliveryId);
      this.callbacks.setPlayback("idle");
      this.activeDeliveryId = null;
    }).catch((error: unknown) => {
      if (generation !== this.generation || this.activeDeliveryId !== line.deliveryId) return;
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
      const reason = code === "audio-blocked" || code === "asset-missing" || code === "catalog-mismatch" ? code : "decode-failed";
      this.callbacks.enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 3, deliveryId: line.deliveryId, status: "failed", reason });
      this.callbacks.finishVoiceLine(line.deliveryId);
      this.callbacks.setPlayback("failed");
      this.activeDeliveryId = null;
    });
  }

  cancel(): void {
    this.generation += 1;
    if (this.activeDeliveryId !== null) this.audio.stop();
    this.activeDeliveryId = null;
  }

  setVolume(volume: number): void {
    this.audio.setVolume(volume);
  }
}
