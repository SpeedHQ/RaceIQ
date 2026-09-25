import type { GameId } from "../../games/ids";
import type { ResolvedValue } from "../../telemetry/resolver/contracts";
import type { CrewChiefEventFamily } from "../../telemetry/live/crewchief-callout-contract";

export type LiveEngineerReplayExecutionMode = "production-equivalent" | "diagnostic-all-games";
export type LiveEngineerReplayClockQuality = "captured" | "native-session" | "nominal-100hz";
export type LiveEngineerSystemLifecycle = "unavailable" | "baseline" | "ready";
export type LiveEngineerImplementationStatus = "implemented" | "detector-not-implemented" | "renderer-unavailable" | "no-game-branch";
export type LiveEngineerReplayStage = "trigger" | "candidate" | "decision" | "selected" | "spotter" | "callout" | "voice-line";
export interface OpponentSourceCaptureV1 { source: "acc-broadcast"; status: "captured" | "unavailable" | "malformed"; recordCount: number; }
export interface LiveEngineerReplayFrameV1 {
  frameIndex: number;
  sourceSequence: number;
  rawSourceTimestampMs: number | null;
  rawSourceTimestampDomain: "wall-clock" | "session" | "monotonic" | null;
  timelineMs: number;
  triggerContext: Readonly<Record<string, boolean | null>>;
  values: Readonly<Record<string, number | string | boolean | null | readonly (number | string | boolean | null)[]>>;
  states: Readonly<Record<string, ResolvedValue<unknown>["state"]>>;
  freshness: Readonly<Record<string, ResolvedValue<unknown>["freshness"]>>;
  opponentSource: import("../../telemetry/live/contracts").OpponentSourceStatusV1 | null;
}

export interface LiveEngineerReplayLapV1 {
  lapId: number | null;
  lapNumber: number | null;
  startFrameIndex: number | null;
  endFrameIndex: number | null;
  metadata: Readonly<Record<string, unknown>>;
}

export interface LiveEngineerReplayAnnotationV1 {
  id: string;
  frameIndex: number;
  timelineMs: number;
  lapNumber: number | null;
  position: { x: number; z: number } | null;
  stage: LiveEngineerReplayStage;
  family: CrewChiefEventFamily | "opponent-pace" | "live-spotter";
  action: string;
  candidateId: string | null;
  decisionId: string | null;
  priority: string | null;
  reason: string | null;
  payload: unknown;
  evidence: readonly string[];
  renderedText: string | null;
  segmentIds: readonly string[];
  audioLineId?: string;
}

export interface LiveEngineerDependencyEvidenceV1 {
  semanticId: string;
  state: ResolvedValue<unknown>["state"] | "not-requested";
  freshness: ResolvedValue<unknown>["freshness"] | "unknown";
  mappingStatus: string | null;
  limitations: readonly string[];
  shape: "scalar" | "array" | "missing" | "invalid";
  aligned: boolean | null;
}

export interface LiveEngineerAvailabilityTransitionV1 {
  frameIndex: number;
  lifecycle: LiveEngineerSystemLifecycle;
  reasonCode: string;
  dependencies: readonly LiveEngineerDependencyEvidenceV1[];
}

export interface LiveEngineerCalloutSystemV1 {
  systemId: `crewchief:${string}` | "opponent-pace" | "live-spotter";
  implementationStatus: LiveEngineerImplementationStatus;
  productionEligible: boolean;
  diagnosticEligible: boolean;
  lifecycle: LiveEngineerSystemLifecycle;
  transitions: readonly LiveEngineerAvailabilityTransitionV1[];
  requiredSemanticIds: readonly string[];
  optionalSemanticIds: readonly string[];
}

export interface LiveEngineerReplaySourceProfileV1 {
  gameId: GameId;
  captureKind: string;
  limitations: readonly string[];
  sourceClockCaptured: boolean;
  opponentSourceCapture: OpponentSourceCaptureV1 | null;
  segmentCount: number;
  skippedMalformedFrames: number;
  nativeSessionInfo: boolean;
  retainedPrefix: boolean;
}

export interface LiveEngineerSessionReplayV1 {
  sessionId: number;
  gameId: GameId;
  car: Readonly<Record<string, unknown>>;
  track: Readonly<Record<string, unknown>>;
  executionMode: LiveEngineerReplayExecutionMode;
  sourceProfile: LiveEngineerReplaySourceProfileV1;
  clockQuality: LiveEngineerReplayClockQuality;
  frames: readonly LiveEngineerReplayFrameV1[];
  laps: readonly LiveEngineerReplayLapV1[];
  annotations: readonly LiveEngineerReplayAnnotationV1[];
  systems: readonly LiveEngineerCalloutSystemV1[];
  warnings: readonly string[];
  sourceCounts: Readonly<Record<string, number>>;
}
