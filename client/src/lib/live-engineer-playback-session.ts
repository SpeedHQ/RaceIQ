import type { LiveEngineerVoiceLineMessageV2, LiveEngineerDeliveryStatusV2, LiveEngineerVoiceRequestV2 } from "../../../shared/racing/live/engineer-contracts";

type Control = LiveEngineerVoiceLineMessageV2 extends never ? never : LiveEngineerDeliveryStatusV2 | LiveEngineerVoiceRequestV2;
export interface LiveEngineerAudioPort {
  play(segmentIds: readonly string[]): Promise<void>;
  stop(): void;
  setVolume(value: number): void;
}
export interface LiveEngineerPlaybackCallbacks {
  enqueueControl(message: Control): void;
  finishVoiceLine(deliveryId: string): void;
  setPlayback(playback: "idle" | "playing" | "failed"): void;
}

export class LiveEngineerPlaybackSession {
  private generation = 0;
  private activeDeliveryId: string | null = null;
  private readonly audio: LiveEngineerAudioPort;
  private readonly callbacks: LiveEngineerPlaybackCallbacks;
  constructor(audio: LiveEngineerAudioPort, callbacks: LiveEngineerPlaybackCallbacks) {
    this.audio = audio;
    this.callbacks = callbacks;
  }

  start(line: LiveEngineerVoiceLineMessageV2, enabled: boolean, volume: number): void {
    this.cancel();
    const generation = ++this.generation;
    this.activeDeliveryId = line.deliveryId;
    this.audio.setVolume(volume);
    if (!enabled) {
      this.callbacks.enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 2, deliveryId: line.deliveryId, status: "muted", reason: "radio-disabled" });
      this.callbacks.finishVoiceLine(line.deliveryId);
      this.activeDeliveryId = null;
      return;
    }
    this.callbacks.setPlayback("playing");
    this.callbacks.enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 2, deliveryId: line.deliveryId, status: "started" });
    this.audio.play(line.segmentIds).then(() => {
      if (generation !== this.generation || this.activeDeliveryId !== line.deliveryId) return;
      this.callbacks.enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 2, deliveryId: line.deliveryId, status: "completed" });
      this.callbacks.finishVoiceLine(line.deliveryId);
      this.callbacks.setPlayback("idle");
      this.activeDeliveryId = null;
    }).catch((error: unknown) => {
      if (generation !== this.generation || this.activeDeliveryId !== line.deliveryId) return;
      const code = (error as { code?: string })?.code;
      const reason = code === "audio-blocked" || code === "asset-missing" || code === "catalog-mismatch" ? code : "decode-failed";
      this.callbacks.enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 2, deliveryId: line.deliveryId, status: "failed", reason });
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
