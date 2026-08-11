import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "../lib/rpc";
import { errorFromResponse } from "../lib/rpc-error";
import { rpcJson } from "../lib/rpc-json";
import type { ExperimentVersion } from "./experiments";

export function useDeletedExperimentVersions(id: number | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["experiment-tests", id ?? null, "deleted"],
    queryFn: async () => {
      const res = await client.api.experiments[":id"].versions.$get({ param: { id: String(id!) }, query: { includeDeleted: "1" } });
      const all = await rpcJson<ExperimentVersion[]>(res);
      return all.filter((t) => t.status === "deleted");
    },
    enabled: enabled && id != null,
    staleTime: 5_000,
  });
}

export function useDeleteVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, versionId }: { sessionId: number; versionId: number }) => {
      const res = await client.api.experiments[":id"].versions[":versionId"].delete.$post({ param: { id: String(sessionId), versionId: String(versionId) } });
      if (!res.ok) throw await errorFromResponse(res);
      return await res.json();
    },
    onSuccess: (_data, { sessionId }) => {
      qc.invalidateQueries({ queryKey: ["experiment", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-tests", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-chat-history", sessionId] });
    },
  });
}

export interface ExperimentActionRow {
  id: number;
  experimentId: number;
  kind: string;
  inversePayload: unknown;
  undone: boolean;
  createdAt: string;
}

export function useExperimentHistory(id: number | null | undefined) {
  return useQuery({
    queryKey: ["experiment-actions", id ?? null],
    queryFn: async () => rpcJson<ExperimentActionRow[]>(await (client.api as any).experiments[":id"].actions.$get({ param: { id: String(id!) } })),
    enabled: id != null,
    staleTime: 5_000,
  });
}

export function useUndo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId }: { sessionId: number }) => {
      const res = await (client.api as any).experiments[":id"].undo.$post({ param: { id: String(sessionId) } });
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as { ok: boolean; undone: boolean; kind?: string; warning?: string };
    },
    onSuccess: (_data, { sessionId }) => {
      qc.invalidateQueries({ queryKey: ["experiment", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-tests", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-actions", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-chat-history", sessionId] });
      qc.invalidateQueries({ queryKey: ["laps"] });
    },
  });
}

export function useRestoreVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, versionId }: { sessionId: number; versionId: number }) => {
      const res = await client.api.experiments[":id"].versions[":versionId"].restore.$post({ param: { id: String(sessionId), versionId: String(versionId) } });
      if (!res.ok) throw await errorFromResponse(res);
      return await res.json();
    },
    onSuccess: (_data, { sessionId }) => {
      qc.invalidateQueries({ queryKey: ["experiment", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-tests", sessionId] });
      qc.invalidateQueries({ queryKey: ["experiment-chat-history", sessionId] });
    },
  });
}
