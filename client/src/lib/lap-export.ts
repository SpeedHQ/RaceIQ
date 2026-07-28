/**
 * Lap/session .zip export + import helpers shared by the Sessions page and
 * Lap Analyse. Exports go through the Hono RPC client; the response is a
 * binary body, so we hand it to the browser as a download.
 */
import type { LapMeta, TelemetryPacket } from "@shared/types";
import { formatLapTime } from "./format";
import { client } from "./rpc";

/** Build a CSV string from lap telemetry and hand it to the browser as a download. */
export function buildExportCsv(telemetry: TelemetryPacket[], carName: string, trackName: string, selectedLap: LapMeta | undefined, selectedLapId: number | null, driverName?: string): string {
  const header = [
    `# Driver: ${driverName || "Unknown"}`,
    `# Car: ${carName || `Ordinal ${telemetry[0].CarOrdinal}`} | CarOrdinal: ${selectedLap?.carOrdinal ?? telemetry[0].CarOrdinal}`,
    `# Track: ${trackName || `Ordinal ${telemetry[0].TrackOrdinal}`} | TrackOrdinal: ${selectedLap?.trackOrdinal ?? telemetry[0].TrackOrdinal}`,
    `# Lap: ${selectedLap?.lapNumber ?? "?"} | LapId: ${selectedLapId} | Time: ${selectedLap ? formatLapTime(selectedLap.lapTime) : "?"} | Session: ${selectedLap?.sessionId ?? "?"} | Game: ${selectedLap?.gameId ?? "?"} | PI: ${selectedLap?.pi ?? "?"} | Valid: ${selectedLap?.isValid ?? "?"}`,
  ].join("\n");
  const csv = [header, Object.keys(telemetry[0]).join(","), ...telemetry.map((p) => Object.values(p).join(","))].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lap-${selectedLapId}-telemetry.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return csv;
}

/** Trigger a browser download for a binary response, honouring Content-Disposition. */
export async function downloadResponse(res: Response, fallbackName: string): Promise<void> {
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const filename = cd.match(/filename="?([^"]+)"?/)?.[1] ?? fallbackName;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Download the given laps and/or whole sessions as a single .zip.
 * Throws with the server's error message so callers can surface it.
 */
export async function exportLapsZip(sel: { lapIds?: number[]; sessionIds?: number[] }): Promise<void> {
  const lapIds = sel.lapIds ?? [];
  const sessionIds = sel.sessionIds ?? [];
  if (lapIds.length === 0 && sessionIds.length === 0) return;

  const res = await client.api.laps["export-zip"].$get({
    query: { ids: lapIds.join(","), sessionIds: sessionIds.join(",") },
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `Export failed (${res.status})`);
  }
  await downloadResponse(res, "raceiq-laps.zip");
}

/** Upload a .zip produced by {@link exportLapsZip}. Returns import counts. */
export async function importLapsZip(file: File): Promise<{ imported: number; skipped: number }> {
  // Multipart upload: the route takes a raw FormData body (no zod form
  // validator), so RPC has no typed shape for it — same as /api/laps/import.
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/laps/import-zip", { method: "POST", body });
  const data = (await res.json().catch(() => null)) as { imported?: number; skipped?: number; error?: string } | null;
  if (!res.ok) throw new Error(data?.error ?? `Import failed (${res.status})`);
  return { imported: data?.imported ?? 0, skipped: data?.skipped ?? 0 };
}
