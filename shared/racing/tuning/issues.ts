import type { RaceEventId } from "../events/contracts";

export type TuneIssueKind =
  | "understeer"
  | "oversteer"
  | "brake-lockup"
  | "bottoming"
  | "tyre-pressure"
  | "tyre-temp";

export type TuneIssueSeverity = "info" | "warn" | "critical";

export interface TuneIssue {
  kind: TuneIssueKind;
  severity: TuneIssueSeverity;
  /** Corner label when corner-scoped (e.g. "T4"); omitted for lap-wide issues. */
  corner?: string;
  /** Distance fraction 0..1 for track-map placement; omitted when not applicable. */
  distanceFrac?: number;
  /** Human-readable one-liner, e.g. "FL locking under braking (-0.22 slip)". */
  detail: string;
  /** Present on per-lap issues; absent on live transients. */
  lapNumber?: number;
  /** Canonical timeline facts supporting this finding. Optional for legacy JSON. */
  eventIds?: RaceEventId[];
}
