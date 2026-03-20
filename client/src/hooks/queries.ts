import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, api } from "../lib/api";
import { DEFAULT_DISPLAY_SETTINGS } from "../stores/telemetry";

// ── Settings ────────────────────────────────────────────────────────────────
export function useSettings() {
  const { data: displaySettings = DEFAULT_DISPLAY_SETTINGS } = useQuery({
    queryKey: queryKeys.settings,
    queryFn: api.getSettings,
  });
  return { displaySettings };
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.saveSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings }),
  });
}

// ── Laps ────────────────────────────────────────────────────────────────────
export function useLaps() {
  return useQuery({ queryKey: queryKeys.laps, queryFn: api.getLaps });
}

export function useLap(id: number | null) {
  return useQuery({
    queryKey: queryKeys.lap(id!),
    queryFn: () => api.getLap(id!),
    enabled: id != null,
  });
}

export function useDeleteLap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteLap,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.laps }),
  });
}

export function useBulkDeleteLaps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.bulkDeleteLaps,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.laps });
      qc.invalidateQueries({ queryKey: queryKeys.tracks });
    },
  });
}

// ── Status ──────────────────────────────────────────────────────────────────
export function useStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: api.getStatus,
    refetchInterval: 2_000,
  });
}

// ── Track info ──────────────────────────────────────────────────────────────
export function useTrackName(ord: number | undefined) {
  return useQuery({
    queryKey: queryKeys.trackName(ord!),
    queryFn: () => api.getTrackName(ord!),
    enabled: ord != null && ord > 0,
  });
}

export function useTrackSectors(ord: number | undefined) {
  return useQuery({
    queryKey: queryKeys.trackSectors(ord!),
    queryFn: () => api.getTrackSectors(ord!),
    enabled: ord != null && ord > 0,
  });
}

export function useTrackSectorBoundaries(ord: number | undefined) {
  return useQuery({
    queryKey: queryKeys.trackSectorBoundaries(ord!),
    queryFn: () => api.getTrackSectorBoundaries(ord!),
    enabled: ord != null && ord > 0,
  });
}

export function useTrackOutline(ord: number | undefined) {
  return useQuery({
    queryKey: queryKeys.trackOutline(ord!),
    queryFn: () => api.getTrackOutline(ord!),
    enabled: ord != null && ord > 0,
  });
}

export function useTracks() {
  return useQuery({ queryKey: queryKeys.tracks, queryFn: api.getTracks });
}

// ── Car info ────────────────────────────────────────────────────────────────
export function useCarName(ord: number | undefined) {
  return useQuery({
    queryKey: queryKeys.carName(ord!),
    queryFn: () => api.getCarName(ord!),
    enabled: ord != null && ord > 0,
  });
}

// ── Live telemetry history ──────────────────────────────────────────────────
export function useGripHistory() {
  return useQuery({
    queryKey: queryKeys.gripHistory,
    queryFn: api.getGripHistory,
    refetchInterval: 1_000,
  });
}

export function useFuelHistory() {
  return useQuery({
    queryKey: queryKeys.fuelHistory,
    queryFn: api.getFuelHistory,
    refetchInterval: 1_000,
  });
}

export function useTelemetryHistory() {
  return useQuery({
    queryKey: queryKeys.telemetryHistory,
    queryFn: api.getTelemetryHistory,
    refetchInterval: 1_000,
  });
}

// ── Export ───────────────────────────────────────────────────────────────────
export function useExportLap() {
  return useMutation({ mutationFn: api.exportLap });
}
