import type { GameId } from "../../games/ids";
import type { ResolvedValue } from "../../telemetry/resolver/contracts";
import type { RaceEngineerEventFamily } from "../../telemetry/live/race-engineer-callout-contract";

const sessions = "test/artifacts/sessions";
export const ENGINEER_REPLAY_PRESETS = [
  { recordingGameId: "fm-2023", id: "fuel-shortage-pit-sequence", backendScenario: "critical-fuel-pit-sequence", label: "Not enough fuel to finish race", detail: "Simulated fuel consumption on a recorded Forza drive. Pit advice follows the next lap crossing.", recordingBin: `${sessions}/fm-2023-2026-09-21T02-02-34-009Z.bin.gz` },
  { recordingGameId: "f1-2025", id: "f1-opponent-lap-pace", backendScenario: "f1-opponent-lap-pace", label: "F1 opponent lap pace", detail: "Replays recorded F1 grid and completed opponent laps through pace callouts.", recordingBin: `${sessions}/f1-2025-2026-04-09T21-34-10-190Z.bin.gz` },
  { recordingGameId: "acc", id: "acc-multi-lap", backendScenario: "recorded-multi-lap", label: "ACC multi-lap stint", detail: "Recorded player laps 1–4.", recordingBin: `${sessions}/acc-2026-04-23T16-42-16-158Z.bin.gz` },
  { recordingGameId: "ac-evo", id: "ac-evo-multi-lap", backendScenario: "recorded-multi-lap", label: "AC Evo multi-lap stint", detail: "Recorded player laps 1–4.", recordingBin: `${sessions}/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz` },
  { recordingGameId: "iracing", id: "iracing-multi-lap", backendScenario: "recorded-multi-lap", label: "iRacing Daytona pit stint", detail: "Recorded player laps 413–418.", recordingBin: `${sessions}/iracing-daytona-am-vantage-gt3-pit.bin.gz` },
  { recordingGameId: "lmu", id: "lmu-multi-lap", backendScenario: "recorded-multi-lap", label: "Le Mans Ultimate multi-lap stint", detail: "Recorded player laps 3–8.", recordingBin: "packages/game-lmu/test/fixtures/laps/lmu-2026-09-19T20-09-44-686Z.bin.gz" },
  { recordingGameId: "ams2", id: "ams2-multi-lap", backendScenario: "recorded-multi-lap", label: "Automobilista 2 race with pit stop", detail: "Recorded player laps 1–6, including the cooldown lap.", recordingBin: `${sessions}/ams2-race-pit-stop.bin.gz` },
] as const satisfies readonly { recordingGameId: GameId; id: string; backendScenario: string; label: string; detail: string; recordingBin: string }[];

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
  family: RaceEngineerEventFamily | "opponent-pace" | "live-spotter";
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
  systemId: `race-engineer:${string}` | "opponent-pace" | "live-spotter";
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
