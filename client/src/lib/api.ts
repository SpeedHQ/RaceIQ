import type { TelemetryPacket, LapMeta, ComparisonData, Tune, TuneAssignment } from "@shared/types";
import type { CatalogTune } from "../data/tune-catalog";
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
  trackCurbs: (ord: number) => ["track-curbs", ord] as const,
  tracks: ["tracks"] as const,
  carName: (ord: number) => ["car-name", ord] as const,
  gripHistory: ["grip-history"] as const,
  fuelHistory: ["fuel-history"] as const,
  telemetryHistory: ["telemetry-history"] as const,
  userTunes: ["user-tunes"] as const,
  catalogTunes: ["catalog-tunes"] as const,
  tuneAssignments: ["tune-assignments"] as const,
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
  getTrackName: (ord: number) => fetch(`/api/track-name/${ord}`).then((r) => r.ok ? r.text() : ""),
  getTrackSectors: (ord: number) => fetchJson<unknown>(`/api/track-sectors/${ord}`),
  getTrackSectorBoundaries: (ord: number) => fetchJson<unknown>(`/api/track-sector-boundaries/${ord}`),
  getTrackOutline: (ord: number) => fetchJson<unknown>(`/api/track-outline/${ord}`),
  getTrackBoundaries: (ord: number) =>
    fetchJson<{ leftEdge: { x: number; z: number }[]; rightEdge: { x: number; z: number }[]; centerLine: { x: number; z: number }[]; pitLane: { x: number; z: number }[] | null; coordSystem: string }>(`/api/track-boundaries/${ord}`).catch(() => null),
  getTrackCurbs: (ord: number) =>
    fetchJson<{ points: { x: number; z: number }[]; side: "left" | "right" | "both" }[]>(`/api/track-curbs/${ord}`).catch(() => null),
  getTracks: () => fetchJson<unknown[]>("/api/tracks"),
  getCarName: (ord: number) => fetch(`/api/car-name/${ord}`).then((r) => r.ok ? r.text() : ""),
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
  getTrackLeaderboard: (ord: number, profileId?: number | null) =>
    fetchJson<Record<string, unknown[]>>(`/api/tracks/${ord}/leaderboard${profileId != null ? `?profileId=${profileId}` : ""}`),
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

  // ── Tunes ───────────────────────────────────────────────────────────────
  getUserTunes: () => fetchJson<Tune[]>("/api/tunes"),
  getCatalogTunes: () => fetchJson<CatalogTune[]>("/api/catalog/tunes"),
  createTune: (data: Partial<Tune>) =>
    fetch("/api/tunes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
      return r.json() as Promise<Tune>;
    }),
  updateTune: ({ id, ...data }: Partial<Tune> & { id: number }) =>
    fetch(`/api/tunes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
      return r.json() as Promise<Tune>;
    }),
  deleteTune: (id: number) =>
    fetch(`/api/tunes/${id}`, { method: "DELETE" }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
    }),
  cloneCatalogTune: (catalogId: string) =>
    fetch(`/api/tunes/clone/${catalogId}`, { method: "POST" }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
      return r.json() as Promise<Tune>;
    }),

  // ── Tune Assignments ──────────────────────────────────────────────────
  getTuneAssignments: () => fetchJson<TuneAssignment[]>("/api/tune-assignments"),
  setTuneAssignment: (data: { carOrdinal: number; trackOrdinal: number; tuneId: number }) =>
    fetch("/api/tune-assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
      return r.json() as Promise<TuneAssignment>;
    }),
  deleteTuneAssignment: (carOrdinal: number, trackOrdinal: number) =>
    fetch(`/api/tune-assignments/${carOrdinal}/${trackOrdinal}`, { method: "DELETE" }),
};
