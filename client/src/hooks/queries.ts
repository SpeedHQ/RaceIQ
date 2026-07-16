import { tryGetGame } from "@shared/games/registry";
import type { GameId, LapMeta, SessionMeta, SessionRecap, TelemetryPacket, TuneIssue } from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect } from "react";
import type { CatalogTune } from "../data/tune-catalog";
import { client } from "../lib/rpc";
import { useGameId } from "../stores/game";
import { DEFAULT_DISPLAY_SETTINGS } from "../stores/telemetry";
// ── Query Keys ──────────────────────────────────────────────────────────────
export const queryKeys = {
  laps: ["laps"] as const,
  status: ["status"] as const,
  settings: ["settings"] as const,
  trackName: (ord: number) => ["track-name", ord] as const,
  trackSectors: (ord: number) => ["track-sectors", ord] as const,
  trackSectorBoundaries: (ord: number) => ["track-sector-boundaries", ord] as const,
  trackOutline: (ord: number) => ["track-outline", ord] as const,
  trackCurbs: (ord: number) => ["track-curbs", ord] as const,
  sessions: ["sessions"] as const,
  tracks: ["tracks"] as const,
  carName: (ord: number) => ["car-name", ord] as const,
  gripHistory: ["grip-history"] as const,
  fuelHistory: ["fuel-history"] as const,
  telemetryHistory: ["telemetry-history"] as const,
  userTunes: ["user-tunes"] as const,
  catalogTunes: ["catalog-tunes"] as const,
  tuneAssignments: ["tune-assignments"] as const,
};

// ── Helpers ─────────────────────────────────────────────────────────────────
async function rpcJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ── Settings ────────────────────────────────────────────────────────────────
export function useSettings() {
  const { data: displaySettings = DEFAULT_DISPLAY_SETTINGS, isSuccess } = useQuery({
    queryKey: queryKeys.settings,
    queryFn: async () => {
      const res = await client.api.settings.$get();
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    },
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
    refetchOnMount: false,
    refetchOnWindowFocus: true,
  });
  return { displaySettings, settingsLoaded: isSuccess };
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (settings: any) => {
      const res = await client.api.settings.$put({ json: settings });
      if (!res.ok) throw new Error(res.statusText);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

// ── Laps ────────────────────────────────────────────────────────────────────
export function useLaps(options?: { refetchInterval?: number | false }) {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["laps", gameId ?? null],
    queryFn: async () => {
      const res = await client.api.laps.$get({
        query: { gameId: gameId ?? undefined },
      });
      return rpcJson<LapMeta[]>(res);
    },
    ...options,
  });
}

export function useLapTelemetry(lapId: number | null) {
  return useQuery({
    queryKey: ["lap-telemetry", lapId],
    queryFn: async () => {
      const res = await client.api.laps[":id"].$get({ param: { id: String(lapId!) } });
      if (!res.ok) throw new Error(res.statusText);
      return res.json() as Promise<{
        telemetry: TelemetryPacket[];
        isLegacy: boolean;
        sectorTimes: { times: [number, number, number]; s1Idx: number; s2Idx: number; firstDist: number; lapDist: number } | null;
        [key: string]: any;
      }>;
    },
    enabled: lapId != null,
    // A single lap carries 15k–80k packets (~5–50 MB). TanStack Query's
    // default gcTime is 5 minutes — enough to hold a dozen laps in memory
    // and OOM the tab. Release as soon as no component subscribes.
    gcTime: 0,
    staleTime: 0,
  });
}

export function useDeleteLap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await client.api.laps[":id"].$delete({ param: { id: String(id) } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.laps });
      qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

export function useBulkDeleteLaps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: number[]) => {
      await client.api.laps["bulk-delete"].$post({ json: { ids } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.laps });
      qc.invalidateQueries({ queryKey: queryKeys.sessions });
      qc.invalidateQueries({ queryKey: queryKeys.tracks });
    },
  });
}

// ── Status ──────────────────────────────────────────────────────────────────
// Server status is now pushed via WebSocket → useTelemetryStore().serverStatus
// The REST endpoint /api/status still exists for one-off checks.

// ── Track info ──────────────────────────────────────────────────────────────
export function useTrackName(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.trackName(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-name"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId! },
      });
      return res.ok ? res.text() : "";
    },
    enabled: ord != null && gameId != null,
  });
}

export function useTrackSectors(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.trackSectors(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-sectors"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId! },
      });
      return rpcJson(res);
    },
    enabled: ord != null && !!gameId,
  });
}

export function useTrackSectorBoundaries(ord: number | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: [...queryKeys.trackSectorBoundaries(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-sector-boundaries"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId! },
      });
      return rpcJson<{ s1End: number; s2End: number } | null>(res);
    },
    enabled: ord != null && !!gameId,
  });
}

export function useTrackOutline(ord: number | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: [...queryKeys.trackOutline(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-outline"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId! },
      });
      return rpcJson<{ points?: { x: number; z: number }[]; flipX?: boolean } | { x: number; z: number }[]>(res);
    },
    enabled: ord != null && !!gameId,
  });
}

export function useTrackBoundaries(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["track-boundaries", ord!, gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-boundaries"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId ?? undefined },
      });
      return rpcJson(res);
    },
    enabled: ord != null && !!gameId,
  });
}

export function useResolveNames(trackOrdinals: number[], carOrdinals: number[]) {
  const gameId = useGameId();
  const trackKey = trackOrdinals.slice().sort().join(",");
  const carKey = carOrdinals.slice().sort().join(",");
  return useQuery({
    queryKey: ["resolve-names", gameId ?? null, trackKey, carKey],
    queryFn: async () => {
      const res = await client.api["resolve-names"].$get({
        query: {
          gameId: gameId!,
          tracks: trackOrdinals.length > 0 ? trackOrdinals.join(",") : undefined,
          cars: carOrdinals.length > 0 ? carOrdinals.join(",") : undefined,
        },
      });
      return rpcJson<{ trackNames: Record<string, string>; carNames: Record<string, string> }>(res);
    },
    enabled: !!gameId && (trackOrdinals.length > 0 || carOrdinals.length > 0),
  });
}

export function useSessions() {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["sessions", gameId ?? null],
    queryFn: async () => {
      const res = await client.api.sessions.$get({
        query: { gameId: gameId ?? undefined },
      });
      return rpcJson<SessionMeta[]>(res);
    },
  });
}

export function useSessionRecap(sessionId: number | null | undefined, gameId: GameId | null | undefined) {
  return useQuery({
    queryKey: ["session-recap", sessionId ?? null, gameId ?? null],
    queryFn: async () => {
      // Narrowed rather than asserted: `enabled` already gates on both being set,
      // but the queryFn closure can't see that.
      if (sessionId == null || !gameId) throw new Error("useSessionRecap: sessionId and gameId are required");
      const res = await client.api.sessions[":id"].recap.$get({
        param: { id: String(sessionId) },
        query: { gameId },
      });
      return rpcJson<SessionRecap>(res);
    },
    enabled: sessionId != null && !!gameId,
  });
}

export function useTracks() {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["tracks", gameId ?? null],
    queryFn: async () => {
      const res = await client.api.tracks.$get({
        query: { gameId: gameId! },
      });
      return rpcJson(res);
    },
    enabled: !!gameId,
  });
}

// ── Car info ────────────────────────────────────────────────────────────────
export function useCarName(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.carName(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["car-name"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId! },
      });
      return res.ok ? res.text() : "";
    },
    enabled: ord != null && ord > 0 && gameId != null,
  });
}

// ── ACC car class (server-resolved) ─────────────────────────────────────────
export function useAccCarClass(ordinal: number | undefined) {
  return useQuery({
    queryKey: ["acc-car-class", ordinal],
    queryFn: async () => {
      const res = await client.api.acc.cars[":ordinal"].class.$get({
        param: { ordinal: String(ordinal!) },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { class: string | null };
      return body.class;
    },
    enabled: ordinal != null && ordinal >= 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// Kunos' published hot-pressure windows by ACC class. Kept client-side —
// the class itself is the server-authoritative fact, the mapping rule isn't.
const ACC_PRESSURE_BY_CLASS: Record<string, { min: number; max: number }> = {
  GT3: { min: 26.0, max: 27.2 },
  GT2: { min: 26.0, max: 27.2 },
  GTC: { min: 26.0, max: 27.2 },
  CHL: { min: 26.0, max: 27.2 },
  GT4: { min: 26.5, max: 27.5 },
  TCX: { min: 30.0, max: 32.0 },
};

/** Universal tire pressure window resolver. ACC is class-aware (fetches car
 *  class server-side), other games fall back to the static adapter value. */
export function useTirePressureOptimal(gameId: GameId, ordinal: number | undefined): { min: number; max: number } | undefined {
  const { data: accClass } = useAccCarClass(gameId === "acc" ? ordinal : undefined);
  if (gameId === "acc") {
    return accClass ? ACC_PRESSURE_BY_CLASS[accClass] : undefined;
  }
  return tryGetGame(gameId)?.tirePressureOptimal;
}

// ── Live telemetry history ──────────────────────────────────────────────────
export function useGripHistory() {
  return useQuery({
    queryKey: queryKeys.gripHistory,
    queryFn: async () => rpcJson(await client.api["grip-history"].$get()),
    refetchInterval: 1_000,
  });
}

export function useFuelHistory() {
  return useQuery({
    queryKey: queryKeys.fuelHistory,
    queryFn: async () => rpcJson(await client.api["fuel-history"].$get()),
    refetchInterval: 1_000,
  });
}

export function useTelemetryHistory() {
  return useQuery({
    queryKey: queryKeys.telemetryHistory,
    queryFn: async () => rpcJson(await client.api["telemetry-history"].$get()),
    refetchInterval: 1_000,
  });
}

// ── Export ───────────────────────────────────────────────────────────────────
export function useExportLap() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await client.api.laps[":id"].export.$get({ param: { id: String(id) } });
      return res.blob();
    },
  });
}

// ── Tunes ────────────────────────────────────────────────────────────────────
export function useUserTunes(gameId?: GameId) {
  return useQuery({
    queryKey: [...queryKeys.userTunes, gameId ?? null],
    queryFn: async () => rpcJson<any[]>(await client.api.tunes.$get({ query: gameId ? { gameId } : {} })),
  });
}

export function useCatalogTunes() {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.catalogTunes, gameId ?? null],
    queryFn: async () => rpcJson<CatalogTune[]>(await client.api.catalog.tunes.$get({ query: {} }, { headers: gameId ? { "X-Game-Id": gameId } : undefined })),
  });
}

export interface LaptimeEntry {
  track: string;
  carClass: string;
  car: string;
  driver: string;
  laptime: string;
}

export function useLaptimes() {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["laptimes", gameId ?? null],
    queryFn: async () => rpcJson<LaptimeEntry[]>(await client.api.laptimes.$get({}, { headers: gameId ? { "X-Game-Id": gameId } : undefined })),
    staleTime: 1000 * 60 * 30,
  });
}

export function useRefreshCommunityTunes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await client.api.tunes.community.refresh.$post();
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return res.json() as Promise<{ synced: boolean; count: number; version: string | null }>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.catalogTunes }),
  });
}

export function useCreateTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: any) => {
      const res = await client.api.tunes.$post({ json: data });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useUpdateTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: any) => {
      const res = await client.api.tunes[":id"].$put({ param: { id: String(id) }, json: data } as any);
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useDeleteTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await client.api.tunes[":id"].$delete({ param: { id: String(id) } });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useCloneCatalogTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (catalogId: string) => {
      const res = await client.api.tunes.clone[":catalogId"].$post({ param: { catalogId } });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useDuplicateTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await client.api.tunes[":id"].duplicate.$post({ param: { id: String(id) } });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useSetupFiles(gameId: "acc" | "ac-evo" | null) {
  return useQuery({
    queryKey: ["setup-files", gameId],
    queryFn: async () => {
      const res = await (client.api.tunes as any)["setup-files"].$get({ query: { gameId } });
      return rpcJson<{ baseDir: string | null; files: { carModel: string; trackName: string; fileName: string; absolutePath: string }[]; tracks?: string[]; error?: string }>(res);
    },
    enabled: gameId != null,
    staleTime: 30_000,
  });
}

/** Place a dropped setup into the user's Setups folder (Setups/<car>/<track>/file)
 *  so it becomes a usable base — instead of rejecting files not saved in-game. */
export function usePlaceSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      gameId: "acc" | "ac-evo";
      carName: string;
      trackName: string;
      fileName: string;
      content: unknown;
    }) => {
      const res = await (client.api.tunes as any)["place-setup"].$post({ json: data });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return (await res.json()) as { absolutePath: string; carModel: string; trackName: string; fileName: string; placed: boolean };
    },
    onSuccess: (_r, vars) => qc.invalidateQueries({ queryKey: ["setup-files", vars.gameId] }),
  });
}

export function useImportTuneFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { gameId: "acc" | "ac-evo"; filePath: string; name?: string; author?: string; carOrdinal: number; category?: string }) => {
      const res = await (client.api.tunes as any)["import-file"].$post({ json: data });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export interface TuneIntentDto {
  component: string;
  direction: "increase" | "decrease";
  magnitude: "small" | "medium" | "large";
  reason: string;
}

export interface AutoTuneResult {
  symptoms: any;
  intents: TuneIntentDto[];
  /** Deterministic (LLM-free) recommendation, included as a second opinion when
   *  engine is "llm". Null in rules mode (intents already are the rules result). */
  rulesIntents: TuneIntentDto[] | null;
  applied: { component: string; path: string; from: number; to: number; direction: string; reason: string }[];
  skipped: { component: string; reason: string }[];
  model: string;
  written: { path: string } | null;
  preview: boolean;
  /** False when no setup file was supplied — intents are advisory only. */
  hasSetup?: boolean;
}

export function useAutoTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      gameId: "acc" | "ac-evo";
      stintId: number;
      filePath?: string;
      trackName?: string;
      preview?: boolean;
      saveAsName?: string;
      overwrite?: boolean;
      /** "rules" (default, deterministic) or "llm" (opt-in). */
      engine?: "rules" | "llm";
      /** Free-text driver feel; biases the deterministic engine. */
      driverNotes?: string;
    }) => {
      const res = await (client.api.tunes as any).auto.$post({ json: data });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return (await res.json()) as AutoTuneResult;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["setup-files"] }),
  });
}

// ── Live Tuning Dashboard ────────────────────────────────────────────────────
/** Per-lap tune issue feed (Phase 2). Derived server-side the same way as
 *  useAutoTune's symptoms step, but doesn't require a setup file. */
export function useLapIssues(lapId: number | null) {
  return useQuery({
    queryKey: ["lap-issues", lapId],
    queryFn: async () => {
      const res = await (client.api.laps as any)[":id"].issues.$get({ param: { id: String(lapId!) } });
      return rpcJson<TuneIssue[]>(res);
    },
    enabled: lapId != null,
    staleTime: 30_000,
  });
}

/** Toggles the pipeline's live transient issue detector (Phase 4) on mount,
 *  and switches it off again on unmount/when `enabled` flips false — nothing
 *  else in the app needs the detector running, so scope it to the live
 *  dashboard's lifetime rather than a global setting. */
export function useLiveAnalysisToggle(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    void (client.api as any)["live-analysis"].$post({ json: { enabled: true } });
    return () => {
      void (client.api as any)["live-analysis"].$post({ json: { enabled: false } });
    };
  }, [enabled]);
}

// ── Tune Assignments ─────────────────────────────────────────────────────────
export function useTuneAssignments() {
  return useQuery({
    queryKey: queryKeys.tuneAssignments,
    queryFn: async () => rpcJson<any[]>(await client.api["tune-assignments"].$get({ query: {} })),
  });
}

export function useSetTuneAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { gameId: GameId; carOrdinal: number; trackOrdinal: number; tuneId: number }) => {
      const res = await client.api["tune-assignments"].$put({ json: data });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tuneAssignments }),
  });
}

export function useDeleteTuneAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ gameId, carOrdinal, trackOrdinal }: { gameId: GameId; carOrdinal: number; trackOrdinal: number }) => {
      await client.api["tune-assignments"][":carOrdinal"][":trackOrdinal"].$delete({
        param: { carOrdinal: String(carOrdinal), trackOrdinal: String(trackOrdinal) },
        query: { gameId },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tuneAssignments }),
  });
}

// ── Tuning sessions (Setup Engineer front door, plan §6a) ─────────────────────
export interface TuningSession {
  id: number;
  /** Per-game display number from 1 (independent of the raw id and races). */
  seq: number;
  gameId: string;
  name: string;
  carOrdinal: number | null;
  trackOrdinal: number | null;
  carName: string | null;
  trackName: string | null;
  baseSetupPath: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  headTestId: number | null;
}

export function useTuningSessions(gameId: "acc" | "ac-evo") {
  return useQuery({
    queryKey: ["tuning-sessions", gameId],
    queryFn: async () => {
      const res = await (client.api as any)["tuning-sessions"].$get({ query: { gameId } });
      return rpcJson<TuningSession[]>(res);
    },
    staleTime: 10_000,
  });
}

export function useCreateTuningSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      gameId: "acc" | "ac-evo";
      name: string;
      carOrdinal?: number | null;
      trackOrdinal?: number | null;
      carName?: string | null;
      trackName?: string | null;
      baseSetupPath?: string | null;
      notes?: string | null;
    }) => {
      const res = await (client.api as any)["tuning-sessions"].$post({ json: data });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return (await res.json()) as TuningSession;
    },
    onSuccess: (s) => qc.invalidateQueries({ queryKey: ["tuning-sessions", s.gameId] }),
  });
}

/** One tuning session by id — the workspace opened via ?tuningSession=<id>. */
export function useTuningSession(id: number | null | undefined) {
  return useQuery({
    queryKey: ["tuning-session", id ?? null],
    queryFn: async () => {
      const res = await (client.api as any)["tuning-sessions"][":id"].$get({ param: { id: String(id!) } });
      return rpcJson<TuningSession>(res);
    },
    enabled: id != null,
    staleTime: 10_000,
  });
}

// ── Tuning tests (setup versions under evaluation, plan §2) ───────────────────
export interface TuningTest {
  id: number;
  tuningSessionId: number;
  version: number;
  label: string;
  setupPath: string | null;
  parentTestId: number | null;
  /** JSON string of AppliedChange[] (null for a base/un-applied version). */
  appliedChanges: string | null;
  driverComment: string | null;
  engine: string | null;
  status: string;
  createdAt: string;
  /** Laps driven on this exact version (grouped by tuning_test_id). */
  lapCount: number;
  /** Best (min positive) lap time in ms on this version, or null. */
  bestLapMs: number | null;
}

export function useTuningSessionTests(id: number | null | undefined) {
  return useQuery({
    queryKey: ["tuning-session-tests", id ?? null],
    queryFn: async () => {
      const res = await (client.api as any)["tuning-sessions"][":id"].tests.$get({ param: { id: String(id!) } });
      return rpcJson<TuningTest[]>(res);
    },
    enabled: id != null,
    staleTime: 5_000,
  });
}

export function useCreateTuningTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sessionId,
      ...body
    }: {
      sessionId: number;
      label: string;
      setupPath?: string | null;
      parentTestId?: number | null;
      appliedChanges?: unknown[] | null;
      driverComment?: string | null;
      engine?: "rules" | "llm" | null;
    }) => {
      const res = await (client.api as any)["tuning-sessions"][":id"].tests.$post({ param: { id: String(sessionId) }, json: body });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return (await res.json()) as TuningTest;
    },
    onSuccess: (t) => qc.invalidateQueries({ queryKey: ["tuning-session-tests", t.tuningSessionId] }),
  });
}

export function useSetHead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, testId }: { sessionId: number; testId: number }) => {
      const res = await (client.api as any)["tuning-sessions"][":id"].head.$post({
        param: { id: String(sessionId) },
        json: { testId },
      });
      if (!res.ok) throw new Error(((await res.json()) as any).error ?? res.statusText);
      return (await res.json()) as { ok: true; headTestId: number; label: string };
    },
    onSuccess: (_data, { sessionId }) => {
      qc.invalidateQueries({ queryKey: ["tuning-session", sessionId] });
      qc.invalidateQueries({ queryKey: ["tuning-session-tests", sessionId] });
      // Chat thread gained the deterministic checkout ack — refetch it.
      qc.invalidateQueries({ queryKey: ["tuning-session-chat-history", sessionId] });
    },
  });
}

// ── Per-lap tuning metrics (fuel/tyre, plan §2 Phase C) ───────────────────────
export interface TuningLapMetric {
  lapId: number;
  /** Litres consumed over the lap; absent when the channel is unavailable. */
  fuelPerLap?: number;
  /** Tyre wear per lap; absent — no genuine ACC/AC-Evo wear channel exists. */
  tyreWear?: number;
}

export function useTuningSessionLapMetrics(id: number | null | undefined) {
  return useQuery({
    queryKey: ["tuning-session-lap-metrics", id ?? null],
    queryFn: async () => {
      const res = await (client.api as any)["tuning-sessions"][":id"]["lap-metrics"].$get({ param: { id: String(id!) } });
      return rpcJson<TuningLapMetric[]>(res);
    },
    enabled: id != null,
    staleTime: 5_000,
  });
}
