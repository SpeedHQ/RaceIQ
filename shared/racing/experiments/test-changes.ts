import type { DrillChange, SetupChange, TestChange } from "./types";

/**
 * Parsing for `experiment_versions.applied_changes` (issue #120).
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
  const paths = asStringArray(raw.paths);
  if (paths.length === 0 && typeof raw.path === "string") paths.push(raw.path);
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

/** One-line human summary of a single change, used in collapsed tree rows. */
export function summarizeTestChange(c: TestChange): string {
  if (c.kind === "drill") return c.title;
  if (c.direction) return `${c.direction} ${c.component}`;
  const delta = c.to - c.from;
  if (Number.isFinite(delta) && delta !== 0) {
    return `${delta > 0 ? "+" : ""}${+delta.toFixed(2)} ${c.component}`;
  }
  return c.component;
}
