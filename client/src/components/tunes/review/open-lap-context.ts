import type { LapMeta } from "@shared/racing/sessions/types";
import type { TuneIssue } from "@shared/racing/tuning/issues";
import type { ExperimentVersion } from "@/hooks/experiments";

type CornerSnapshot = { tempC?: number; wear?: number; pressure?: number; brakeTemp?: number };
type Range = { n: number; min: number; max: number; avg: number };

/** Build compact context text matching currently rendered lap review. */
export function buildOpenLapContext({
  focusLap,
  sectorTimes,
  laps,
  corners,
  issues,
  ranges,
  metric,
  test,
  cornerKeys,
  temperatureUnit,
}: {
  focusLap?: LapMeta;
  sectorTimes: { times: number[] } | null;
  laps: LapMeta[];
  corners: Record<string, CornerSnapshot> | null;
  issues?: TuneIssue[];
  ranges: { sectors: Record<string, Range>[] } | null;
  metric: { label: string; unit: string };
  test?: Pick<ExperimentVersion, "driverComment" | "notes">;
  cornerKeys: readonly string[];
  temperatureUnit: "C" | "F";
}): string | null {
  const temp = (value: number, delta = false) => `${(temperatureUnit === "F" ? (delta ? value * (9 / 5) : value * (9 / 5) + 32) : value).toFixed(0)}°${temperatureUnit}`;
  if (!focusLap) return null;
  const lines = [
    "CURRENTLY OPEN LAP REVIEW (visible to user):",
    `Lap ${focusLap.lapNumber} — ${focusLap.lapTime.toFixed(3)}s${focusLap.isValid ? "" : ` (INVALID${focusLap.invalidReason ? `: ${focusLap.invalidReason}` : ""})`}${focusLap.experimentExcluded ? " (excluded from tuning aggregate)" : ""}`,
  ];
  if (sectorTimes) {
    const bestOf = (sectorIndex: number) =>
      laps.reduce<number | undefined>((best, lap) => {
        const value = lap.sectorTimes?.[sectorIndex];
        return value == null || value <= 0 || (best != null && value >= best) ? best : value;
      }, undefined);
    lines.push(
      `Sectors: ${sectorTimes.times
        .map((time, index) => {
          if (!(time > 0)) return `S${index + 1} —`;
          const best = bestOf(index);
          const delta = best != null ? time - best : null;
          return `S${index + 1} ${time.toFixed(3)}s${delta == null ? "" : delta <= 0.0005 ? " (best)" : ` (+${delta.toFixed(3)})`}`;
        })
        .join(", ")}`,
    );
  }
  if (corners)
    lines.push(
      `Tyres (end of lap): ${cornerKeys
        .map((corner) => {
          const snapshot = corners[corner];
          return `${corner} temp ${snapshot.tempC === undefined ? "—" : temp(snapshot.tempC)}, wear ${snapshot.wear === undefined ? "—" : `${(snapshot.wear * 100).toFixed(0)}%`}, pressure ${snapshot.pressure === undefined ? "—" : `${snapshot.pressure.toFixed(1)}psi`}, brake ${snapshot.brakeTemp === undefined ? "—" : temp(snapshot.brakeTemp)}`;
        })
        .join("; ")}`,
    );
  if (issues && issues.length > 0) lines.push(`Detected issues: ${issues.map((issue) => `${issue.kind}${issue.corner ? ` ${issue.corner}` : ""} (${issue.severity}) — ${issue.detail}`).join("; ")}`);
  else if (issues) lines.push("Detected issues: none.");
  if (ranges) {
    lines.push(`${metric.label} ranges (min-max, ${metric.label.toLowerCase().includes("temp") ? `°${temperatureUnit}` : metric.unit}) by sector:`);
    ranges.sectors.forEach((sector, index) => {
      lines.push(
        `  S${index + 1}: ${cornerKeys
          .map((corner) => {
            const range = sector[corner];
            return range.n === 0 ? `${corner} —` : `${corner} ${temp(range.min)}-${temp(range.max)} (avg ${temp(range.avg)})`;
          })
          .join(", ")}`,
      );
    });
  }
  if (test?.driverComment) lines.push(`Driver comment: ${test.driverComment}`);
  if (test?.notes) lines.push(`Engineer notes: ${test.notes}`);
  return lines.join("\n");
}
