import { classifyLapAttribution, type DriverAttributionStint } from "@raceiq/shared/driver-attribution";

export function dashboardStints(value: unknown): DriverAttributionStint[] {
  if (Array.isArray(value)) return value as DriverAttributionStint[];
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as DriverAttributionStint[] : [];
  } catch { return []; }
}

/** Historical interval evidence is authoritative; a cached Self label alone is not proof. */
export function dashboardLapAttribution(
  lapStints: unknown, sessionStints: unknown, domain: unknown, start: unknown, end: unknown,
): "Self" | "Other" | "Mixed" | "Unknown" {
  const ownStints = dashboardStints(lapStints);
  const stints = ownStints.length ? ownStints : dashboardStints(sessionStints);
  if (typeof domain !== "string" || !domain || start == null || end == null) return "Unknown";
  return classifyLapAttribution(stints, Number(start), Number(end), domain);
}

/** A proven Self interval establishes session eligibility, never its measured duration. */
export function dashboardHasSelfStint(value: unknown): boolean {
  const stints = dashboardStints(value);
  for (const stint of stints) {
    if (stint.attribution !== "Self") continue;
    const end = Math.min(stint.endMs ?? stint.evidenceValidUntilMs, stint.evidenceValidUntilMs);
    if (classifyLapAttribution(stints, stint.startMs, end, stint.clockDomain) === "Self") return true;
  }
  return false;
}

/** Scalar sums on the dashboard duration basis, proven by paired source-clock observations. */
export interface DashboardDurationAttribution {
  selfSeconds: number;
  otherSeconds: number;
  unknownSeconds: number;
  selfObserved: boolean;
  coverage: "complete" | "partial" | "unavailable";
}

export function dashboardDurationAttribution(value: unknown): DashboardDurationAttribution | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.selfObserved !== "boolean"
    || !["complete", "partial", "unavailable"].includes(String(row.coverage))
    || !["selfSeconds", "otherSeconds", "unknownSeconds"].every((key) =>
      typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0)
    || (!row.selfObserved && row.selfSeconds !== 0)
    || (row.coverage === "complete" && row.unknownSeconds !== 0)) return null;
  return { selfSeconds: row.selfSeconds as number, otherSeconds: row.otherSeconds as number,
    unknownSeconds: row.unknownSeconds as number, selfObserved: row.selfObserved,
    coverage: row.coverage as DashboardDurationAttribution["coverage"] };
}
