import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { client } from "../lib/rpc";
import { DEFAULT_DISPLAY_SETTINGS, type DisplaySettings } from "../stores/telemetry";
import { queryKeys } from "./query-keys";

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
      return settings;
    },
    onSuccess: (savedSettings) => {
      qc.setQueryData(queryKeys.settings, (current: DisplaySettings | undefined) => ({ ...current, ...savedSettings }));
      void qc.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}
