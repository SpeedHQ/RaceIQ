import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { m } from "@/paraglide/messages";

type ProviderId = "gemini" | "openai" | "local";
export type ModelsResponse = {
  gemini: { id: string; name: string }[];
  openai: { id: string; name: string }[];
  local: { id: string; name: string }[];
  _errors?: Partial<Record<ProviderId, string | null>>;
};

export type AiModelData = {
  aiProviders?: { id: string; name: string }[];
  aiModels?: ModelsResponse;
  aiModelsFetching: boolean;
  aiModelsError: boolean;
  modelsRefreshing: boolean;
  refreshModels: { mutate: () => void; isPending: boolean; isError: boolean };
};

export function isAiProvider(value: string): value is ProviderId {
  return value === "gemini" || value === "openai" || value === "local";
}

export function useAiModelData(selectedProviders: ProviderId[], keyStatus: Record<string, boolean>): AiModelData {
  const qc = useQueryClient();
  const selectedProvidersForFetch = selectedProviders.filter((provider) => provider === "local" || provider === "openai" || Boolean(keyStatus[provider]));
  const selectedProvidersCsv = selectedProvidersForFetch.join(",");
  const { data: aiProviders } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: async () => {
      const response = await fetch("/api/ai-providers");
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json() as Promise<{ id: string; name: string }[]>;
    },
  });
  const {
    data: aiModels,
    isFetching: aiModelsFetching,
    isError: aiModelsError,
  } = useQuery({
    queryKey: ["ai-models", selectedProvidersCsv],
    queryFn: async () => {
      const url = `/api/ai-models?providers=${encodeURIComponent(selectedProvidersCsv)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json() as Promise<ModelsResponse>;
    },
    enabled: selectedProvidersForFetch.length > 0,
    placeholderData: (previousData) => previousData,
  });
  const refreshModelsMutation = useMutation({
    mutationFn: async () => {
      if (!selectedProvidersCsv) return { gemini: [], openai: [], local: [], _errors: { gemini: null, openai: null, local: null } } as ModelsResponse;
      const base = `/api/ai-models?providers=${encodeURIComponent(selectedProvidersCsv)}&refresh=1`;
      const response = await fetch(base);
      console.info(`[AI] GET ${base} -> ${response.status} ${response.statusText}`);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.warn(`[AI] ${base} error body: ${text || "<empty>"}`);
      }
      if (!response.ok) throw new Error(m.ai_refresh_models_failed());
      return response.json() as Promise<ModelsResponse>;
    },
    onSuccess: (data) => {
      qc.setQueryData(["ai-models", selectedProvidersCsv], data);
    },
  });
  return {
    aiProviders,
    aiModels,
    aiModelsFetching,
    aiModelsError,
    modelsRefreshing: refreshModelsMutation.isPending,
    refreshModels: {
      mutate: () => refreshModelsMutation.mutate(),
      isPending: refreshModelsMutation.isPending,
      isError: refreshModelsMutation.isError,
    },
  };
}
