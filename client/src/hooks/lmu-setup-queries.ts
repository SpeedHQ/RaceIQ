import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { client } from "../lib/rpc";
import { errorFromResponse } from "../lib/rpc-error";

export type LmuSetupListing = InferResponseType<typeof client.api.lmu.setups.$get, 200>;
export type LmuSetupContent = InferResponseType<typeof client.api.lmu["setup-content"]["$get"], 200>;
export type SaveLmuSetupRequest = InferRequestType<typeof client.api.lmu["save-setup"]["$post"]>["json"];
export type SavedLmuSetup = InferResponseType<typeof client.api.lmu["save-setup"]["$post"], 201>;

export function useLmuSetupFiles() {
  return useQuery({
    queryKey: ["lmu-setup-files"],
    queryFn: async () => {
      const response = await client.api.lmu.setups.$get();
      if (!response.ok) throw await errorFromResponse(response);
      return response.json();
    },
    staleTime: 30_000,
  });
}

export function useLmuSetupContent(path: string | null) {
  return useQuery({
    queryKey: ["lmu-setup-content", path],
    queryFn: async () => {
      const response = await client.api.lmu["setup-content"].$get({ query: { path: path! } });
      if (!response.ok) throw await errorFromResponse(response);
      const content = await response.json();
      if ("error" in content) throw new Error(typeof content.error === "string" ? content.error : response.statusText);
      return content;
    },
    enabled: path !== null,
    staleTime: 30_000,
  });
}

export function useSaveLmuSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: SaveLmuSetupRequest) => {
      const response = await client.api.lmu["save-setup"].$post({ json: data });
      if (!response.ok) throw await errorFromResponse(response);
      const saved = await response.json();
      if ("error" in saved) throw new Error(typeof saved.error === "string" ? saved.error : response.statusText);
      return saved;
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(["lmu-setup-content", saved.path], saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["lmu-setup-files"] }),
        queryClient.invalidateQueries({ queryKey: ["lmu-setup-content", saved.path] }),
      ]);
    },
  });
}
