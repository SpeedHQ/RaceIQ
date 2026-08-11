import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "../lib/rpc";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { errorFromResponse } from "../lib/rpc-error";
import { queryKeys } from "./query-keys";

export function useSetupFiles(gameId: "acc" | "ac-evo" | null) {
  return useQuery({
    queryKey: ["setup-files", gameId],
    queryFn: async () => {
      const res = await (client.api.tunes as any)["setup-files"].$get({ query: { gameId } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<{
        baseDir: string | null;
        files: { carModel: string; trackName: string; fileName: string; absolutePath: string }[];
        tracks?: string[];
        trackNames?: Record<string, string>;
        trackAliases?: Record<string, string[]>;
        cars?: { model: string; name: string }[];
        error?: string;
      }>;
    },
    enabled: gameId != null,
    staleTime: 30_000,
  });
}

export function useSetupFileContent(gameId: "acc" | "ac-evo" | null, path: string | null) {
  return useQuery({
    queryKey: ["setup-file-content", gameId, path],
    queryFn: async () => {
      const res = await (client.api.tunes as any)["setup-file-content"].$get({ query: { gameId, path } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<{
        fileName: string;
        kind: "json" | "carsetup";
        presetId: string | null;
        formatted: string | null;
        sections: { title: string; rows: { label: string; value: string; num?: number; min?: number; max?: number; fixed?: boolean }[] }[] | null;
        setup: Record<string, unknown> | null;
        error?: string;
      }>;
    },
    enabled: gameId != null && path != null,
    staleTime: 30_000,
  });
}

export function useInspectCarSetup() {
  return useMutation({
    mutationFn: async (contentBase64: string) => {
      const res = await (client.api.tunes as any)["inspect-carsetup"].$post({ json: { contentBase64 } });
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as { presetId: string | null; carModel: string | null; carName: string | null; knownCar: boolean };
    },
  });
}

export function usePlaceSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { gameId: "acc" | "ac-evo"; carName: string; trackName: string; fileName: string; content?: unknown; contentBase64?: string }) => {
      const res = await (client.api.tunes as any)["place-setup"].$post({ json: data });
      if (!res.ok) throw await errorFromResponse(res);
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
      if (!res.ok) throw await errorFromResponse(res);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}
