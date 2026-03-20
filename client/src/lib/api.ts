import type { TelemetryPacket, LapMeta, ComparisonData } from "@shared/types";
import type { DisplaySettings } from "../stores/telemetry";

// ── Query Keys ──────────────────────────────────────────────────────────────
export const queryKeys = {
  laps: ["laps"] as const,
  lap: (id: number) => ["laps", id] as const,
  status: ["status"] as const,
  settings: ["settings"] as const,
  trackName: (ord: number) => ["track-name", ord] as const,
  trackSectors: (ord: number) => ["track-sectors", ord] as const,
  trackSectorBoundaries: (ord: number) => ["track-sector-boundaries", ord] as const,
  trackOutline: (ord: number) => ["track-outline", ord] as const,
  tracks: ["tracks"] as const,
  carName: (ord: number) => ["car-name", ord] as const,
  gripHistory: ["grip-history"] as const,
  fuelHistory: ["fuel-history"] as const,
  telemetryHistory: ["telemetry-history"] as const,
};

// ── Fetch Helpers ───────────────────────────────────────────────────────────
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── Query Functions ─────────────────────────────────────────────────────────
export const api = {
  getLaps: () => fetchJson<LapMeta[]>("/api/laps"),
  getLap: (id: number) => fetchJson<{ telemetry: TelemetryPacket[] }>(`/api/laps/${id}`),
  getStatus: () => fetchJson<{ trackOrdinal?: number; carOrdinal?: number }>("/api/status"),
  getSettings: () => fetchJson<DisplaySettings>("/api/settings"),
  getTrackName: (ord: number) => fetchJson<{ name: string }>(`/api/track-name/${ord}`).then((d) => d.name),
  getTrackSectors: (ord: number) => fetchJson<unknown>(`/api/track-sectors/${ord}`),
  getTrackSectorBoundaries: (ord: number) => fetchJson<unknown>(`/api/track-sector-boundaries/${ord}`),
  getTrackOutline: (ord: number) => fetchJson<unknown>(`/api/track-outline/${ord}`),
  getTracks: () => fetchJson<unknown[]>("/api/tracks"),
  getCarName: (ord: number) => fetchJson<{ name: string }>(`/api/car-name/${ord}`).then((d) => d.name),
  getGripHistory: () => fetchJson<unknown>("/api/grip-history"),
  getFuelHistory: () => fetchJson<unknown>("/api/fuel-history"),
  getTelemetryHistory: () => fetchJson<unknown>("/api/telemetry-history"),

  // ── Mutations ───────────────────────────────────────────────────────────
  deleteLap: (id: number) => fetch(`/api/laps/${id}`, { method: "DELETE" }),
  bulkDeleteLaps: (ids: number[]) =>
    fetch("/api/laps/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
  saveSettings: (settings: Partial<DisplaySettings>) =>
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }),
  exportLap: (id: number) => fetch(`/api/laps/${id}/export`).then((r) => r.blob()),
  compareLaps: (lapAId: number, lapBId: number) =>
    fetchJson<ComparisonData>(`/api/laps/${lapAId}/compare/${lapBId}`),
  deleteTrackOutline: (ord: number) =>
    fetch(`/api/track-outline/${ord}`, { method: "DELETE" }),
  getTrackLeaderboard: (ord: number) =>
    fetchJson<Record<string, unknown[]>>(`/api/tracks/${ord}/leaderboard`),
  saveTrackSegments: (ord: number, segments: unknown[]) =>
    fetch(`/api/tracks/${ord}/segments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments }),
    }),
  saveTrackSectorBoundaries: (ord: number, s1End: number, s2End: number) =>
    fetch(`/api/track-sector-boundaries/${ord}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ s1End, s2End }),
    }),
};
