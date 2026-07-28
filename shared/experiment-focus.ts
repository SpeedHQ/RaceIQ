import { z } from "zod";

/**
 * What an experiment is currently varying: the car, or the driver.
 *
 * Focus is a MODE, not a type. A driver who finds a balance problem tunes the
 * car, then says "right, now let's work on my braking" — same car, same track,
 * same experiment, different thing being varied. So focus is a mutable column
 * on `experiments` that steers what the workspace offers and what kind the next
 * arm gets, and every switch is appended to `experiment_focus_events` so the
 * session's history reads as what it actually was.
 *
 * ⚠️ The values are 'car'/'driver' and NOT 'setup'/'drill' on purpose. Three
 * levels of this feature carry a discriminator, and they must not share words:
 *
 *   experiments.focus        'car' | 'driver'    — what is being varied (mode)
 *   experiment_versions.kind 'setup' | 'drill'   — what an arm was
 *   TestChange.kind          'setup' | 'drill'   — one entry in appliedChanges
 *
 * An earlier cut named the mode 'setup' | 'driving', which made "setup" mean a
 * mode, an arm AND a knob edit while its opposite was "driving" at one level
 * and "drill" at the others. Each level now has its own noun-space, so
 * `versionKindForFocus` reads as a relationship between two things rather than
 * papering over a near-miss in naming.
 *
 * What focus is NOT: the identity of an arm. `experiment_versions.kind` records
 * what a given arm actually varied and never changes afterwards — switching
 * focus to the driver does not retroactively make v1–v3 drills. That split is
 * why a mixed experiment can be reviewed honestly: each arm is judged on its
 * own terms (see `headlineMetricForVersionKind`).
 */

export const EXPERIMENT_FOCUSES = ["car", "driver"] as const;
export type ExperimentFocus = (typeof EXPERIMENT_FOCUSES)[number];

export const ExperimentFocusSchema = z.enum(EXPERIMENT_FOCUSES);

/** What an individual arm varied. Mirrors `experiment_versions.kind`. */
export const VERSION_KINDS = ["setup", "drill"] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

export const VersionKindSchema = z.enum(VERSION_KINDS);

export const DEFAULT_EXPERIMENT_FOCUS: ExperimentFocus = "car";

export const EXPERIMENT_FOCUS_LABELS: Record<ExperimentFocus, string> = {
  car: "Car",
  driver: "Driver",
};

/** One line on what changes when this focus is active — for the switcher UI. */
export const EXPERIMENT_FOCUS_HINTS: Record<ExperimentFocus, string> = {
  car: "Vary the car. New arms are setup versions judged on best lap.",
  driver: "Vary the driver. New arms are drills judged on consistency.",
};

/**
 * The agent's role while this focus is active. Same agent either way — naming
 * it after the focus is the difference between "why is the setup engineer
 * talking about my braking" and an obvious mode.
 *
 * These are the real paddock roles rather than the feature's internal name:
 * a race engineer owns the car, a driver coach owns the driver. "Setup
 * engineer" was the old product name for the whole feature, which made it read
 * as a fixed panel title instead of the mode it now is.
 */
export const EXPERIMENT_FOCUS_AGENT_LABELS: Record<ExperimentFocus, string> = {
  car: "Race engineer",
  driver: "Driver coach",
};

/** The arm kind a new version gets while this focus is active. */
export function versionKindForFocus(focus: ExperimentFocus): VersionKind {
  return focus === "driver" ? "drill" : "setup";
}

/** The focus an existing arm was created under — the inverse mapping. */
export function focusForVersionKind(kind: VersionKind): ExperimentFocus {
  return kind === "drill" ? "driver" : "car";
}

/**
 * How an arm is judged.
 *
 * A setup change is meant to move outright pace, so best lap is the read. A
 * driving drill is meant to make the driver repeatable — its whole point can be
 * a smaller spread at the same best lap, which a best-lap read scores as "no
 * change". Judging every arm on best lap is exactly the blind spot the driving
 * stories in ExperimentFlow expose.
 */
export const HEADLINE_METRICS = ["best_lap", "consistency"] as const;
export type HeadlineMetric = (typeof HEADLINE_METRICS)[number];

export function headlineMetricForVersionKind(kind: VersionKind): HeadlineMetric {
  return kind === "drill" ? "consistency" : "best_lap";
}

export const HEADLINE_METRIC_LABELS: Record<HeadlineMetric, string> = {
  best_lap: "Best lap",
  consistency: "Lap-time spread",
};

/** Lower is better for spread; lower is also better for lap time. Kept explicit
 *  so a delta's sign can be coloured without each call site re-deciding. */
export const HEADLINE_METRIC_LOWER_IS_BETTER: Record<HeadlineMetric, boolean> = {
  best_lap: true,
  consistency: true,
};
