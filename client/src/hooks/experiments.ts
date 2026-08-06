import type { ExperimentFocus, VersionKind } from "@shared/racing/experiments/focus";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { LapMeta } from "../../../shared/racing/sessions/types";
import { client } from "../lib/rpc";
import { errorFromResponse } from "../lib/rpc-error";
import { rpcJson } from "../lib/rpc-json";

export interface Experiment {
  id: number;
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
  headVersionId: number | null;
  focus: ExperimentFocus;
  lapTarget?: number;
}

export interface ExperimentFocusEvent {
  id: number;
  experimentId: number;
  focus: ExperimentFocus;
  fromVersionId: number | null;
  note: string | null;
  createdAt: string;
}

export type ExperimentGameId = "acc" | "ac-evo" | "f1-2025";

export function useExperiments(gameId: ExperimentGameId) {
  return useQuery({
    queryKey: ["experiments", gameId],
    queryFn: async () => rpcJson<Experiment[]>(await (client.api as any).experiments.$get({ query: { gameId } })),
    staleTime: 10_000,
  });
}

export function useCreateExperiment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      gameId: ExperimentGameId;
      name: string;
      carOrdinal?: number | null;
      trackOrdinal?: number | null;
      carName?: string | null;
      trackName?: string | null;
      baseSetupPath?: string | null;
      notes?: string | null;
      focus?: ExperimentFocus;
    }) => {
      const res = await (client.api as any).experiments.$post({ json: data });
      if (!res.ok) throw await errorFromResponse(res);
      const created = (await res.json()) as Experiment;
      // Setup-backed creation must return with its v1 HEAD materialised.
      // Fallback keeps the client correct when talking to an older server
      // that returns the session row before its seed is visible.
      if (data.baseSetupPath && created.headVersionId == null) {
        const seed = await (client.api as any).experiments[":id"].bases.$post({
          param: { id: String(created.id) },
          json: { setupPath: data.baseSetupPath, label: "v1", setHead: true },
        });
        if (!seed.ok) throw await errorFromResponse(seed);
        const seeded = (await seed.json()) as { id: number };
        return { ...created, headVersionId: seeded.id };
      }
      return created;
    },
    onSuccess: (s) => qc.invalidateQueries({ queryKey: ["experiments", s.gameId] }),
  });
}

export function useSetExperimentFocus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, focus, note }: { id: number; focus: ExperimentFocus; note?: string | null }) => {
      const res = await (client.api as any).experiments[":id"].focus.$patch({ param: { id: String(id) }, json: { focus, note: note ?? null } });
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as { experiment: Experiment; event: ExperimentFocusEvent | null; changed: boolean };
    },
    onSuccess: (r, vars) => {
      qc.invalidateQueries({ queryKey: ["experiment", vars.id] });
      qc.invalidateQueries({ queryKey: ["experiment-focus-history", vars.id] });
      qc.invalidateQueries({ queryKey: ["experiments", r.experiment.gameId] });
    },
  });
}

export function useExperimentFocusHistory(id: number | null | undefined) {
  return useQuery({
    queryKey: ["experiment-focus-history", id ?? null],
    queryFn: async () => rpcJson<ExperimentFocusEvent[]>(await (client.api as any).experiments[":id"]["focus-history"].$get({ param: { id: String(id!) } })),
    enabled: id != null,
    staleTime: 10_000,
  });
}

export function useExperiment(id: number | null | undefined) {
  return useQuery({
    queryKey: ["experiment", id ?? null],
    queryFn: async () => rpcJson<Experiment>(await (client.api as any).experiments[":id"].$get({ param: { id: String(id!) } })),
    enabled: id != null,
    staleTime: 10_000,
  });
}

export interface ExperimentVersion {
  id: number;
  experimentId: number;
  version: number;
  label: string;
  setupPath: string | null;
  parentVersionId: number | null;
  appliedChanges: string | null;
  driverComment: string | null;
  notes: string | null;
  engine: string | null;
  setupSnapshot: string | null;
  kind: VersionKind;
  status: string;
  createdAt: string;
  lapCount: number;
  bestLapMs: number | null;
}

export function useExperimentVersions(id: number | null | undefined) {
  return useQuery({
    queryKey: ["experiment-tests", id ?? null],
    queryFn: async () => rpcJson<ExperimentVersion[]>(await client.api.experiments[":id"].versions.$get({ param: { id: String(id!) }, query: {} })),
    enabled: id != null,
    staleTime: 5_000,
  });
}

export interface ExperimentArmComparison {
  metricId: string;
  metricLabel: string;
  unit: string;
  direction: "lower-better" | "higher-better";
  a: { label: string | null; n: number; mean: number | null; min: number | null; max: number | null };
  b: { label: string | null; n: number; mean: number | null; min: number | null; max: number | null };
  deltaMean: number | null;
  ci: [number, number] | null;
  ciReliable: boolean;
  pValue: number | null;
  pValueAdjusted?: number | null;
  effectSize: number | null;
  significance: "significant" | "not-significant" | "inconclusive";
  underpowered: boolean;
  favours: "a" | "b" | null;
  reason: string | null;
}

export function useExperimentArmComparison(sessionId: number | null | undefined, a: number | null | undefined, b: number | null | undefined, metric: "lapTimeSec" = "lapTimeSec") {
  return useQuery({
    queryKey: ["experiment-arm-comparison", sessionId ?? null, a ?? null, b ?? null, metric],
    queryFn: async () =>
      rpcJson<ExperimentArmComparison>(await client.api.experiments[":id"]["arm-comparison"].$get({ param: { id: String(sessionId!) }, query: { a: String(a!), b: String(b!), metric } })),
    enabled: sessionId != null && a != null && b != null && a !== b,
    staleTime: 5_000,
  });
}

export interface CornerLineSpread {
  corner: string;
  lateralSpreadM: number;
  lowTrust: boolean;
}
export interface LineSpreadTrace {
  fracs: number[];
  spreadM: number[];
  perCorner: CornerLineSpread[];
  lowTrust: boolean;
  consistencyScore: number;
  overallSpreadM: number;
  lapCount: number;
  lapLines: { lapId: number; x: number[]; z: number[]; brake: number[]; throttle: number[]; frac: number[] }[];
}

export function useLineSpread(sessionId: number | null | undefined) {
  return useQuery({
    queryKey: ["experiment-line-spread", sessionId ?? null],
    queryFn: async () => rpcJson<LineSpreadTrace>(await client.api.experiments[":id"]["line-spread"].$get({ param: { id: String(sessionId!) } })),
    enabled: sessionId != null,
    staleTime: 10_000,
  });
}

export function useSetTestNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, versionId, driverComment }: { sessionId: number; versionId: number; driverComment: string | null }) => {
      const res = await client.api.experiments[":id"].versions[":versionId"].$patch({ param: { id: String(sessionId), versionId: String(versionId) }, json: { driverComment } });
      if (!res.ok) throw await errorFromResponse(res);
      return await res.json();
    },
    onSuccess: (_t, { sessionId }) => qc.invalidateQueries({ queryKey: ["experiment-tests", sessionId] }),
  });
}

export function useSetHead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, versionId }: { sessionId: number; versionId: number }) => {
      const res = await (client.api as any).experiments[":id"].head.$post({ param: { id: String(sessionId) }, json: { versionId } });
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as { ok: true; headVersionId: number; label: string };
    },
    onSuccess: (_data, { sessionId }) => {
      qc.invalidateQueries({ queryKey: ["experiment", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-tests", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-chat-history", sessionId] });
    },
  });
}

export function useCaptureSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: number) => {
      const res = await (client.api as any).experiments[":id"]["capture-setup"].$post({ param: { id: String(sessionId) } });
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as ExperimentVersion;
    },
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["experiment", t.experimentId] });
      qc.invalidateQueries({ queryKey: ["experiment-tests", t.experimentId] });
      qc.invalidateQueries({ queryKey: ["experiment-chat-history", t.experimentId] });
    },
  });
}

export function useAddBase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, setupPath, label, setHead }: { sessionId: number; setupPath: string; label?: string; setHead?: boolean }) => {
      const res = await (client.api as any).experiments[":id"].bases.$post({ param: { id: String(sessionId) }, json: { setupPath, label, setHead } });
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as ExperimentVersion;
    },
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["experiment", t.experimentId] });
      qc.invalidateQueries({ queryKey: ["experiment-tests", t.experimentId] });
      qc.invalidateQueries({ queryKey: ["experiment-chat-history", t.experimentId] });
    },
  });
}

export type ImportableLap = LapMeta & { setupFingerprint?: string | null; setupSummary?: string | null };

export function useImportableLaps(sessionId: number | null | undefined) {
  return useQuery({
    queryKey: ["experiment-importable-laps", sessionId ?? null],
    queryFn: async () => rpcJson<ImportableLap[]>(await (client.api as any).experiments[":id"]["importable-laps"].$get({ param: { id: String(sessionId!) } })),
    enabled: sessionId != null,
    staleTime: 5_000,
  });
}

export function useImportLaps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, lapIds, experimentVersionId }: { sessionId: number; lapIds: number[]; experimentVersionId?: number | null }) => {
      const res = await (client.api as any).experiments[":id"]["import-laps"].$post({ param: { id: String(sessionId) }, json: { lapIds, experimentVersionId } });
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as { importedIds: number[] };
    },
    onSuccess: (_data, { sessionId }) => {
      qc.invalidateQueries({ queryKey: ["experiment", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-tests", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-importable-laps", sessionId] });
      qc.invalidateQueries({ queryKey: ["laps"] });
      qc.invalidateQueries({ queryKey: ["experiment-lap-metrics", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-chat-history", sessionId] });
    },
  });
}

export interface ExperimentLapMetric {
  lapId: number;
  fuelPerLap?: number;
  tyreWear?: number;
}

export function useExperimentLapMetrics(id: number | null | undefined) {
  return useQuery({
    queryKey: ["experiment-lap-metrics", id ?? null],
    queryFn: async () => rpcJson<ExperimentLapMetric[]>(await (client.api as any).experiments[":id"]["lap-metrics"].$get({ param: { id: String(id!) } })),
    enabled: id != null,
    staleTime: 5_000,
  });
}
