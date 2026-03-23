import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { LapMeta } from "@shared/types";
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
export function useLaps(activeProfileId?: number | null, options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: ["laps", activeProfileId ?? null],
    queryFn: () => {
      const url = activeProfileId != null
        ? `/api/laps?profileId=${activeProfileId}`
        : `/api/laps`;
      return fetch(url).then((r) => r.json()) as Promise<LapMeta[]>;
    },
    ...options,
  });
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

// ── Tunes ────────────────────────────────────────────────────────────────────
export function useUserTunes() {
  return useQuery({
    queryKey: queryKeys.userTunes,
    queryFn: api.getUserTunes,
  });
}

export function useCatalogTunes() {
  return useQuery({
    queryKey: queryKeys.catalogTunes,
    queryFn: api.getCatalogTunes,
  });
}

export function useCreateTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createTune,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useUpdateTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.updateTune,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useDeleteTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteTune,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useCloneCatalogTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.cloneCatalogTune,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

// ── Tune Assignments ─────────────────────────────────────────────────────────
export function useTuneAssignments() {
  return useQuery({
    queryKey: queryKeys.tuneAssignments,
    queryFn: api.getTuneAssignments,
  });
}

export function useSetTuneAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.setTuneAssignment,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tuneAssignments }),
  });
}

export function useDeleteTuneAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ carOrdinal, trackOrdinal }: { carOrdinal: number; trackOrdinal: number }) =>
      api.deleteTuneAssignment(carOrdinal, trackOrdinal),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tuneAssignments }),
  });
}
