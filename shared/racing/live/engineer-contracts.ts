export const LIVE_ENGINEER_PROTOCOL_VERSION = 1 as const;
export const LIVE_ENGINEER_RENDERING_VERSION = "opponent-pace-v1" as const;

export type OpponentPaceRelationV1 =
  | "fastest-in-class"
  | "setting-race-pace"
  | "within-class-pace"
  | "off-class-pace"
  | "outlier-lap";
export type OpponentPaceTextKeyV1 =
  | "live_engineer_opponent_fastest"
  | "live_engineer_opponent_setting_race_pace"
  | "live_engineer_opponent_within_pace"
  | "live_engineer_opponent_off_pace"
  | "live_engineer_opponent_outlier";
export type LiveEngineerVoiceModeV1 = "automatic" | "exact-response";
export type LiveEngineerPriorityV1 = "high" | "normal" | "low";
export type OpponentPaceBenchmarkKindV1 = "session-best" | "recent-race-pace";

export interface OpponentPaceRenderParametersV1 {
  relation: OpponentPaceRelationV1;
  scope: "class" | "overall";
  playerLapNumber: number;
  playerLapTimeMs: number;
  benchmarkLapTimeMs: number;
  deltaMs: number;
  benchmarkKind: OpponentPaceBenchmarkKindV1;
  benchmarkDriverName?: string;
  className?: string;
}

export interface LiveEngineerCalloutMessageV1 {
  type: "live-engineer-callout";
  protocolVersion: 1;
  deliveryId: string;
  decisionId: string;
  candidateId: string;
  family: "opponent-pace";
  sessionId: string;
  timelineEpoch: number;
  sourceSequence: number;
  priority: LiveEngineerPriorityV1;
  createdSessionTimeMs: number;
  expiresSessionTimeMs: number;
  render: {
    renderingVersion: "opponent-pace-v1";
    textKey: OpponentPaceTextKeyV1;
    parameters: OpponentPaceRenderParametersV1;
    voice: { catalogVersion: string; mode: LiveEngineerVoiceModeV1; segmentIds: readonly string[] };
  };
}

export type LiveEngineerVoiceControlV1 =
  | { type: "live-engineer-voice"; protocolVersion: 1; action: "ready"; deliveryId: string }
  | { type: "live-engineer-voice"; protocolVersion: 1; action: "request-exact-pace"; requestId: string; decisionId: string };

export interface LiveEngineerVoicePermitV1 {
  type: "live-engineer-voice-permit";
  protocolVersion: 1;
  deliveryId: string;
  decisionId: string;
  requestId?: string;
  mode: LiveEngineerVoiceModeV1;
  permitted: boolean;
  reason?: "expired" | "wrong-session" | "benchmark-changed" | "pit-context" | "caution-context" | "unknown-delivery";
  voice?: { catalogVersion: string; segmentIds: readonly string[] };
}

export interface LiveEngineerDeliveryStatusV1 {
  type: "live-engineer-delivery-status";
  protocolVersion: 1;
  deliveryId: string;
  status: "started" | "completed" | "failed" | "muted" | "dismissed" | "cancelled-stale" | "unsupported";
  reason?: "audio-blocked" | "asset-missing" | "decode-failed" | "catalog-mismatch" | "user-dismissed";
}

export interface LiveEngineerCandidateV1 {
  candidateId: string;
  actionKey: "opponent-pace-status";
  cooldownGroup: "opponent-pace";
  sourceFactIds: readonly string[];
  policyVersion: "opponent-pace-v1";
  renderParameters: OpponentPaceRenderParametersV1;
}
export type LiveEngineerDecisionReasonV1 =
  | "selected" | "expired" | "wrong-session" | "ineligible-evidence" | "context-blocked"
  | "semantic-duplicate" | "cooldown-active" | "lower-priority" | "queue-capacity";

const RELATIONS: readonly OpponentPaceRelationV1[] = ["fastest-in-class", "setting-race-pace", "within-class-pace", "off-class-pace", "outlier-lap"];
const TEXT_KEYS: readonly OpponentPaceTextKeyV1[] = ["live_engineer_opponent_fastest", "live_engineer_opponent_setting_race_pace", "live_engineer_opponent_within_pace", "live_engineer_opponent_off_pace", "live_engineer_opponent_outlier"];
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" ? v as Record<string, unknown> : undefined;
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const nonNegativeInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const validParameters = (v: unknown): v is OpponentPaceRenderParametersV1 => {
  const p = record(v);
  return !!p && RELATIONS.includes(p.relation as OpponentPaceRelationV1) && (p.scope === "class" || p.scope === "overall") &&
    positiveInt(p.playerLapNumber) && positiveInt(p.playerLapTimeMs) && positiveInt(p.benchmarkLapTimeMs) &&
    Number.isInteger(p.deltaMs) && p.deltaMs === (p.playerLapTimeMs as number) - (p.benchmarkLapTimeMs as number) &&
    (p.benchmarkKind === "session-best" || p.benchmarkKind === "recent-race-pace") &&
    (p.benchmarkDriverName === undefined || typeof p.benchmarkDriverName === "string") && (p.className === undefined || typeof p.className === "string");
};
export function isOpponentPaceRenderParametersV1(v: unknown): v is OpponentPaceRenderParametersV1 { return validParameters(v); }
export function isLiveEngineerCalloutMessageV1(v: unknown): v is LiveEngineerCalloutMessageV1 {
  const x = record(v), r = record(x?.render), voice = record(r?.voice);
  return !!x && x.type === "live-engineer-callout" && x.protocolVersion === 1 && typeof x.deliveryId === "string" && typeof x.decisionId === "string" && typeof x.candidateId === "string" && x.family === "opponent-pace" && typeof x.sessionId === "string" && nonNegativeInt(x.timelineEpoch) && nonNegativeInt(x.sourceSequence) && ["high", "normal", "low"].includes(x.priority as string) && nonNegativeInt(x.createdSessionTimeMs) && nonNegativeInt(x.expiresSessionTimeMs) && x.expiresSessionTimeMs > x.createdSessionTimeMs && !!r && r.renderingVersion === "opponent-pace-v1" && TEXT_KEYS.includes(r.textKey as OpponentPaceTextKeyV1) && validParameters(r.parameters) && !!voice && typeof voice.catalogVersion === "string" && ["automatic", "exact-response"].includes(voice.mode as string) && Array.isArray(voice.segmentIds) && voice.segmentIds.every((id) => typeof id === "string" && id.length > 0);
}
export function isLiveEngineerVoiceControlV1(v: unknown): v is LiveEngineerVoiceControlV1 {
  const x = record(v);
  return !!x && x.type === "live-engineer-voice" && x.protocolVersion === 1 && typeof x.action === "string" && ((x.action === "ready" && typeof x.deliveryId === "string") || (x.action === "request-exact-pace" && typeof x.requestId === "string" && typeof x.decisionId === "string"));
}
export function isLiveEngineerDeliveryStatusV1(v: unknown): v is LiveEngineerDeliveryStatusV1 {
  const x = record(v); const statuses = ["started", "completed", "failed", "muted", "dismissed", "cancelled-stale", "unsupported"];
  const reasons = ["audio-blocked", "asset-missing", "decode-failed", "catalog-mismatch", "user-dismissed"];
  return !!x && x.type === "live-engineer-delivery-status" && x.protocolVersion === 1 && typeof x.deliveryId === "string" && statuses.includes(x.status as string) && (x.reason === undefined || reasons.includes(x.reason as string));
}
