import { isSpotterRenderParametersV1, type SpotterRenderParametersV1 } from "./spotter-contracts";
import { CREWCHIEF_AUTOMATIC_EVENTS, CREWCHIEF_REFERENCE, type CrewChiefEventFamily, type CrewChiefSourceRef } from "../../telemetry/live/crewchief-callout-contract";
export const LIVE_ENGINEER_AUDIO_CATALOG_VERSION = "live-engineer-qwen-v2" as const;
export const LIVE_ENGINEER_PROTOCOL_VERSION = 3 as const;
export const LIVE_ENGINEER_RENDERING_VERSION = "opponent-pace-v1" as const;
export const SPOTTER_RENDERING_VERSION = "spotter-v1" as const;
export type OpponentPaceRelationV1 = "fastest-in-class" | "setting-race-pace" | "within-class-pace" | "off-class-pace" | "outlier-lap";
export type OpponentPaceTextKeyV1 = "live_engineer_opponent_fastest" | "live_engineer_opponent_setting_race_pace" | "live_engineer_opponent_within_pace" | "live_engineer_opponent_off_pace" | "live_engineer_opponent_outlier";
export type SpotterTextKeyV1 = "live_engineer_spotter_car_left" | "live_engineer_spotter_car_right" | "live_engineer_spotter_still_there" | "live_engineer_spotter_three_wide_left" | "live_engineer_spotter_three_wide_right" | "live_engineer_spotter_clear_left" | "live_engineer_spotter_clear_right";
export type LiveEngineerPriorityV1 = "high" | "normal" | "low";
export interface OpponentPaceRenderParametersV1 { relation: OpponentPaceRelationV1; scope: "class" | "overall"; playerLapNumber: number; playerLapTimeMs: number; benchmarkLapTimeMs: number; deltaMs: number; benchmarkKind: "session-best" | "recent-race-pace"; benchmarkDriverName?: string; className?: string; }
interface LiveEngineerCalloutCommonV3 { type: "live-engineer-callout"; protocolVersion: 3; decisionId: string; candidateId: string; sessionId: string; timelineEpoch: number; sourceSequence: number; priority: LiveEngineerPriorityV1; createdSessionTimeMs: number; expiresSessionTimeMs: number; }
export interface OpponentPaceCalloutMessageV3 extends LiveEngineerCalloutCommonV3 { family: "opponent-pace"; render: { renderingVersion: "opponent-pace-v1"; textKey: OpponentPaceTextKeyV1; parameters: OpponentPaceRenderParametersV1 }; }
export interface SpotterCalloutMessageV3 extends LiveEngineerCalloutCommonV3 { family: "spotter"; render: { renderingVersion: "spotter-v1"; textKey: SpotterTextKeyV1; parameters: SpotterRenderParametersV1 }; }
export type LiveEngineerCalloutMessageV3 = OpponentPaceCalloutMessageV3 | SpotterCalloutMessageV3 | RaceEngineerCalloutMessageV3;
export type LiveEngineerVoiceModeV1 = "automatic" | "exact-response";
export type LiveEngineerDecisionReasonV1 = "selected" | "expired" | "wrong-session" | "semantic-duplicate" | "cooldown-active" | "queue-capacity" | "context-blocked";
export interface LiveEngineerCandidateV1 {
  candidateId: string;
  actionKey: string;
  cooldownGroup: string;
  sourceFactIds: readonly string[];
  policyVersion: string;
  renderParameters: OpponentPaceRenderParametersV1 | {
    triggerFamily: CrewChiefEventFamily;
    eventKey: string;
    payload: Readonly<Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>>;
    source: CrewChiefSourceRef;
  };
}
export interface RaceEngineerCalloutMessageV3 extends LiveEngineerCalloutCommonV3 {
  family: "race-engineer";
  render: { renderingVersion: "crewchief-v1"; text: string; textKey: string; parameters: {
    triggerFamily: CrewChiefEventFamily;
    eventKey: string;
    payload: Readonly<Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>>;
    source: CrewChiefSourceRef;
  }};
}
export type LiveEngineerVoiceLineOptions = { mode: "automatic" } | { mode: "exact-response"; requestId: string };
export interface LiveEngineerVoiceLineMessageV3 { type: "live-engineer-voice-line"; protocolVersion: 3; deliveryId: string; decisionId: string; requestId?: string; family: "opponent-pace" | "spotter" | "race-engineer"; mode: "automatic" | "exact-response"; priority: LiveEngineerPriorityV1; sourceSequence: number; sessionId: string; timelineEpoch: number; createdSessionTimeMs: number; expiresSessionTimeMs: number; catalogVersion: string; segmentIds: readonly string[]; }
export interface LiveEngineerVoiceRequestV3 { type: "live-engineer-voice-request"; protocolVersion: 3; action: "exact-pace"; requestId: string; decisionId: string; }
export interface LiveEngineerDeliveryStatusV3 { type: "live-engineer-delivery-status"; protocolVersion: 3; deliveryId: string; status: "started" | "completed" | "failed" | "muted" | "preempted" | "unsupported"; reason?: "radio-disabled" | "audio-blocked" | "asset-missing" | "decode-failed" | "catalog-mismatch" | "superseded" | "expired"; }
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" ? v as Record<string, unknown> : undefined;
const nonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const wireScalar = (v: unknown): v is string | number | boolean | null =>
  v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v);
const wirePayload = (v: unknown): boolean => {
  const payload = record(v);
  return !!payload && Object.values(payload).every((value) => wireScalar(value) || Array.isArray(value) && value.every(wireScalar));
};
const crewChiefSource = (v: unknown): boolean => {
  const source = record(v);
  return !!source &&
    source.host === CREWCHIEF_REFERENCE.host &&
    source.project === CREWCHIEF_REFERENCE.project &&
    source.commit === CREWCHIEF_REFERENCE.commit &&
    typeof source.path === "string" && source.path.length > 0 &&
    Array.isArray(source.symbols) && source.symbols.length > 0 && source.symbols.every((symbol) => typeof symbol === "string" && symbol.length > 0);
};
const relations: readonly OpponentPaceRelationV1[] = ["fastest-in-class", "setting-race-pace", "within-class-pace", "off-class-pace", "outlier-lap"];
const textKeys: readonly OpponentPaceTextKeyV1[] = ["live_engineer_opponent_fastest", "live_engineer_opponent_setting_race_pace", "live_engineer_opponent_within_pace", "live_engineer_opponent_off_pace", "live_engineer_opponent_outlier"];
const spotterKeys: readonly SpotterTextKeyV1[] = ["live_engineer_spotter_car_left", "live_engineer_spotter_car_right", "live_engineer_spotter_still_there", "live_engineer_spotter_three_wide_left", "live_engineer_spotter_three_wide_right", "live_engineer_spotter_clear_left", "live_engineer_spotter_clear_right"];
export function isOpponentPaceRenderParametersV1(v: unknown): v is OpponentPaceRenderParametersV1 { const p = record(v); return !!p && relations.includes(p.relation as OpponentPaceRelationV1) && (p.scope === "class" || p.scope === "overall") && nonNegative(p.playerLapNumber) && nonNegative(p.playerLapTimeMs) && nonNegative(p.benchmarkLapTimeMs) && Number.isInteger(p.deltaMs) && p.deltaMs === (p.playerLapTimeMs as number) - (p.benchmarkLapTimeMs as number) && (p.benchmarkKind === "session-best" || p.benchmarkKind === "recent-race-pace"); }
export function isLiveEngineerCalloutMessageV3(v: unknown): v is LiveEngineerCalloutMessageV3 {
  const x = record(v), r = record(x?.render), p = record(r?.parameters);
  if (!x || x.type !== "live-engineer-callout" || x.protocolVersion !== 3 || typeof x.decisionId !== "string" || typeof x.candidateId !== "string" || typeof x.sessionId !== "string" || !nonNegative(x.timelineEpoch) || !nonNegative(x.sourceSequence) || !["high", "normal", "low"].includes(x.priority as string) || !nonNegative(x.createdSessionTimeMs) || !nonNegative(x.expiresSessionTimeMs) || x.expiresSessionTimeMs <= x.createdSessionTimeMs || !r) return false;
  if (x.family === "opponent-pace") return r.renderingVersion === "opponent-pace-v1" && textKeys.includes(r.textKey as OpponentPaceTextKeyV1) && isOpponentPaceRenderParametersV1(r.parameters);
  if (x.family === "spotter") return r.renderingVersion === "spotter-v1" && spotterKeys.includes(r.textKey as SpotterTextKeyV1) && isSpotterRenderParametersV1(r.parameters);
  return x.family === "race-engineer" &&
    r.renderingVersion === "crewchief-v1" &&
    typeof r.text === "string" && r.text.length > 0 &&
    typeof r.textKey === "string" && r.textKey.length > 0 &&
    !!p && typeof p.triggerFamily === "string" && CREWCHIEF_AUTOMATIC_EVENTS.includes(p.triggerFamily as CrewChiefEventFamily & (typeof CREWCHIEF_AUTOMATIC_EVENTS)[number]) &&
    typeof p.eventKey === "string" && p.eventKey.length > 0 &&
    wirePayload(p.payload) &&
    crewChiefSource(p.source);
}
export function isLiveEngineerVoiceLineMessageV3(v: unknown): v is LiveEngineerVoiceLineMessageV3 { const x = record(v); return !!x && x.type === "live-engineer-voice-line" && x.protocolVersion === 3 && typeof x.deliveryId === "string" && typeof x.decisionId === "string" && typeof x.sessionId === "string" && nonNegative(x.timelineEpoch) && nonNegative(x.createdSessionTimeMs) && nonNegative(x.expiresSessionTimeMs) && x.expiresSessionTimeMs > x.createdSessionTimeMs && ["opponent-pace", "spotter", "race-engineer"].includes(x.family as string) && ["automatic", "exact-response"].includes(x.mode as string) && ["high", "normal", "low"].includes(x.priority as string) && nonNegative(x.sourceSequence) && typeof x.catalogVersion === "string" && Array.isArray(x.segmentIds) && x.segmentIds.length > 0 && x.segmentIds.every((id) => typeof id === "string" && id.length > 0); }
export function isLiveEngineerVoiceRequestV3(v: unknown): v is LiveEngineerVoiceRequestV3 { const x = record(v); return !!x && x.type === "live-engineer-voice-request" && x.protocolVersion === 3 && x.action === "exact-pace" && typeof x.requestId === "string" && typeof x.decisionId === "string"; }
export function isLiveEngineerDeliveryStatusV3(v: unknown): v is LiveEngineerDeliveryStatusV3 { const x = record(v); return !!x && x.type === "live-engineer-delivery-status" && x.protocolVersion === 3 && typeof x.deliveryId === "string" && ["started", "completed", "failed", "muted", "preempted", "unsupported"].includes(x.status as string); }
export function createLiveEngineerVoiceLine(callout: LiveEngineerCalloutMessageV3, segmentIds: readonly string[], options: LiveEngineerVoiceLineOptions): LiveEngineerVoiceLineMessageV3 { if (!segmentIds.length || segmentIds.some((id) => !id.length)) throw new Error("Unknown or empty audio segments"); return { type: "live-engineer-voice-line", protocolVersion: 3, deliveryId: options.mode === "automatic" ? `${callout.decisionId}/automatic` : `${callout.decisionId}/exact/${options.requestId}`, decisionId: callout.decisionId, ...(options.mode === "exact-response" ? { requestId: options.requestId } : {}), family: callout.family, mode: options.mode, priority: callout.priority, sourceSequence: callout.sourceSequence, sessionId: callout.sessionId, timelineEpoch: callout.timelineEpoch, createdSessionTimeMs: callout.createdSessionTimeMs, expiresSessionTimeMs: callout.expiresSessionTimeMs, catalogVersion: LIVE_ENGINEER_AUDIO_CATALOG_VERSION, segmentIds: [...segmentIds] }; }
