export interface AnalysisHighlight {
  startFrac: number;
  endFrac: number;
  color: "good" | "warning" | "critical";
  label: string;
}

export interface PaceItem {
  label: string;
  value: string;
  assessment: "good" | "warning" | "critical";
  detail: string;
}

export interface HandlingItem {
  label: string;
  value: string;
  assessment: "good" | "warning" | "critical";
  detail: string;
}

export interface CornerItem {
  name: string;
  issue: string;
  fix: string;
  severity: "minor" | "moderate" | "major";
}

export interface CornerBrakingItem {
  corner: string;
  assessment: "good" | "warning" | "critical";
  brakePoint: string;
  detail: string;
}

export interface CornerThrottleItem {
  corner: string;
  assessment: "good" | "warning" | "critical";
  throttlePoint: string;
  detail: string;
}

export interface CoachingItem {
  tip: string;
  detail: string;
}

export interface SetupItem {
  component: string;
  symptom: string;
  fix: string;
  current: string;
  target: string;
  direction: "increase" | "decrease" | "adjust";
}

export interface AnalysisData {
  verdict: string;
  pace: PaceItem[];
  handling: HandlingItem[];
  corners: CornerItem[];
  braking: CornerBrakingItem[];
  throttle: CornerThrottleItem[];
  coaching: CoachingItem[];
  setup: SetupItem[];
}

export interface Segment {
  type: string;
  name: string;
  startFrac: number;
  endFrac: number;
}

export interface AnalysisUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
}
