export interface SetupChange {
  kind: "setup";
  /** Knob name as shown to the driver, e.g. "Front anti-roll bar". */
  component: string;
  /** Every JSON setup path this knob wrote (1 for scalars, 2 for axle pairs). */
  paths: string[];
  from: number;
  to: number;
  /**
   * Optional because pre-v37 rows were written without it. Absent means "no
   * direction word was recorded", not "no direction" — callers fall back to
   * the signed from→to delta. Mirrors TuneDirection in server/ai/schemas.ts.
   */
  direction?: "increase" | "decrease";
  reason: string;
}

export interface DrillChange {
  kind: "drill";
  /** Short imperative name, e.g. "Brake 10m later into T4". */
  title: string;
  /** What the driver actually does, in enough detail to repeat it. */
  instruction: string;
  /** Corner labels the drill targets (e.g. ["T4"]); empty = lap-wide. */
  corners: string[];
  reason: string;
}

export type TestChange = SetupChange | DrillChange;

export type ExperimentVersionKind = TestChange["kind"];

export type ExperimentVersionVerdict =
  | "better"
  | "worse"
  | "neutral"
  | "inconclusive";

export type ExperimentVersionVerdictSource = "auto" | "manual";
