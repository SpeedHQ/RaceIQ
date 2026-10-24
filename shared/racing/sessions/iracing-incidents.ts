export type IRacingEvidenceStatus = "available" | "partial" | "unavailable";

export type IRacingIncidentCoverageReason =
  | "capture-unavailable"
  | "unsupported-capture"
  | "missing-lap-window"
  | "missing-evidence"
  | "capture-gap"
  | "counter-reset"
  | "time-reset"
  | "segment-boundary"
  | "decode-failure";

export interface IRacingIncidentEventBase {
  id: string;
  lapId: number;
  lapNumber: number;
  sessionTimeSec: number;
  replay: { frameIndex: number; lapTimeSec: number | null } | null;
}

export type IRacingIncidentEvent =
  | (IRacingIncidentEventBase & {
      kind: "incident-points";
      points: number;
      previousSessionTimeSec: number;
    })
  | (IRacingIncidentEventBase & {
      kind: "off-track";
      endSessionTimeSec: number;
      observedSeconds: number;
      startObserved: boolean;
      endObserved: boolean;
    });

export interface IRacingIncidentLapSummary {
  lapId: number;
  lapNumber: number;
  incidentStatus: IRacingEvidenceStatus;
  surfaceStatus: IRacingEvidenceStatus;
  observedIncidentPoints: number | null;
  offTrackSpans: number | null;
  observedOffTrackSeconds: number | null;
}

export interface IRacingIncidentReport {
  sessionId: number;
  coverage: {
    scope: "recorded-laps";
    totalLaps: number;
    lapsWithCapture: number;
    incidentStatus: IRacingEvidenceStatus;
    surfaceStatus: IRacingEvidenceStatus;
    reasons: IRacingIncidentCoverageReason[];
  };
  observedIncidentPoints: number | null;
  offTrackSpans: number | null;
  observedOffTrackSeconds: number | null;
  longestCleanLapStreak: number | null;
  laps: IRacingIncidentLapSummary[];
  events: IRacingIncidentEvent[];
}
