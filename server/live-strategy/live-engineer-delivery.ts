import type { LiveEngineerCalloutMessageV1, LiveEngineerDeliveryStatusV1, LiveEngineerVoiceControlV1, LiveEngineerVoicePermitV1 } from "../../shared/racing/live/engineer-contracts";

export interface LiveEngineerDeliveryContext {
  sessionId: string;
  timelineEpoch: number;
  sessionTimeMs: number;
  inPit: boolean;
  caution: boolean;
  benchmarkCurrent: (message: LiveEngineerCalloutMessageV1) => boolean;
}
export class LiveEngineerDeliveryService {
  private readonly deliveries = new Map<string, LiveEngineerCalloutMessageV1>();
  private readonly statuses = new Map<string, LiveEngineerDeliveryStatusV1["status"]>();
  private readonly context: () => LiveEngineerDeliveryContext;
  constructor(context: () => LiveEngineerDeliveryContext) { this.context = context; }
  register(message: LiveEngineerCalloutMessageV1): void { this.deliveries.set(message.deliveryId, message); }
  handle(control: LiveEngineerVoiceControlV1, context = this.context()): LiveEngineerVoicePermitV1 {
    const source = control.action === "ready" ? this.deliveries.get(control.deliveryId) : this.findDelivery(control.decisionId);
    if (!source) {
      return { type: "live-engineer-voice-permit", protocolVersion: 1, deliveryId: control.action === "ready" ? control.deliveryId : "", decisionId: control.action === "ready" ? "" : control.decisionId, mode: control.action === "ready" ? "automatic" : "exact-response", permitted: false, reason: "unknown-delivery" };
    }
    const exact = control.action === "request-exact-pace";
    const deliveryId = exact ? `${source.decisionId}/exact/${control.requestId}` : source.deliveryId;
    const message: LiveEngineerCalloutMessageV1 = exact ? { ...source, deliveryId, render: { ...source.render, voice: { ...source.render.voice, mode: "exact-response" } } } : source;
    if (exact) this.deliveries.set(deliveryId, message);
    const permit = (permitted: boolean, reason?: LiveEngineerVoicePermitV1["reason"]): LiveEngineerVoicePermitV1 => ({ type: "live-engineer-voice-permit", protocolVersion: 1, deliveryId, decisionId: source.decisionId, ...(exact ? { requestId: control.requestId } : {}), mode: exact ? "exact-response" : "automatic", permitted, ...(reason ? { reason } : {}), ...(permitted ? { voice: message.render.voice } : {}) });
    if (context.sessionId !== message.sessionId || context.timelineEpoch !== message.timelineEpoch) return permit(false, "wrong-session");
    if (context.sessionTimeMs >= message.expiresSessionTimeMs) return permit(false, "expired");
    if (!context.benchmarkCurrent(message)) return permit(false, "benchmark-changed");
    if (context.inPit) return permit(false, "pit-context");
    if (context.caution) return permit(false, "caution-context");
    return permit(true);
  }
  recordStatus(status: LiveEngineerDeliveryStatusV1): boolean {
    const previous = this.statuses.get(status.deliveryId);
    if (previous && ["completed", "failed", "muted", "dismissed", "cancelled-stale", "unsupported"].includes(previous)) return previous === status.status;
    this.statuses.set(status.deliveryId, status.status); return true;
  }
  private findDelivery(decisionId: string): LiveEngineerCalloutMessageV1 | undefined { return [...this.deliveries.values()].find((message) => message.decisionId === decisionId); }
}
