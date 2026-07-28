import type { DrillChange, SetupChange, TestChange } from "./types";

/**
 * Parsing for `tuning_tests.applied_changes` (issue #120).
 *
 * The column predates migration v37, when every change was a setup knob edit
 * and the objects had no `kind` field. Rather than rewriting every historical
 * blob in a migration — the JSON is free-form and written by several call
 * sites — legacy shapes are normalised here at read time: a change with no
 * `kind` is a setup change, which is exactly what it meant when it was
 * written.
 *
 * Everything is defensive: this data is user-visible history that must never
 * break a page render, so anything unparseable degrades to an empty list and
 * anything individually malformed is dropped rather than throwing.
 */

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function normalizeSetup(raw: Record<string, unknown>): SetupChange | null {
  const component = raw.component;
  if (typeof component !== "string" || component === "") return null;
  const from = typeof raw.from === "number" ? raw.from : Number.NaN;
  const to = typeof raw.to === "number" ? raw.to : Number.NaN;
  // Pre-v37 rows sometimes carried a single `path` instead of `paths[]`.
  const paths = asStringArray(raw.paths);
  if (paths.length === 0 && typeof raw.path === "string") paths.push(raw.path);
  // Deliberately not synthesised from the delta when absent: callers render
  // the stored word in preference to the numbers, so inventing one here would
  // silently change how every legacy row reads.
  const direction = raw.direction === "increase" || raw.direction === "decrease" ? raw.direction : undefined;
  return {
    kind: "setup",
    component,
    paths,
    from,
    to,
    ...(direction ? { direction } : {}),
    reason: typeof raw.reason === "string" ? raw.reason : "",
  };
}

function normalizeDrill(raw: Record<string, unknown>): DrillChange | null {
  const title = raw.title;
  if (typeof title !== "string" || title === "") return null;
  return {
    kind: "drill",
    title,
    instruction: typeof raw.instruction === "string" ? raw.instruction : "",
    corners: asStringArray(raw.corners),
    reason: typeof raw.reason === "string" ? raw.reason : "",
  };
}

/** Normalise one stored change object, or null if it is unusable. */
export function normalizeTestChange(value: unknown): TestChange | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "drill") return normalizeDrill(raw);
  // Absent or unrecognised `kind` → the historical meaning, a setup change.
  return normalizeSetup(raw);
}

/** Parse the stored applied_changes JSON into typed changes (empty on any issue). */
export function parseTestChanges(json: string | null | undefined): TestChange[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeTestChange).filter((c): c is TestChange => c !== null);
}

/**
 * One-line human summary of a single change, used in collapsed tree rows.
 * Setup changes prefer the stored direction word over the raw delta — this is
 * the precedence the version graph has always used.
 */
export function summarizeTestChange(c: TestChange): string {
  if (c.kind === "drill") return c.title;
  if (c.direction) return `${c.direction} ${c.component}`;
  const delta = c.to - c.from;
  if (Number.isFinite(delta) && delta !== 0) {
    return `${delta > 0 ? "+" : ""}${+delta.toFixed(2)} ${c.component}`;
  }
  return c.component;
}
