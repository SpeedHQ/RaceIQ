import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LiveEngineerVoicePackStatus } from "@raceiq/live-engineer/audio-package";
import { client } from "../lib/rpc";

export const liveEngineerVoicePackQueryKey = ["live-engineer-voice-pack"] as const;
export const liveEngineerVoicePackInstallKey = ["live-engineer-voice-pack-install"] as const;

export function useLiveEngineerVoicePackStatus(enabled = true) {
  return useQuery<LiveEngineerVoicePackStatus>({
    queryKey: liveEngineerVoicePackQueryKey,
    queryFn: async () => {
      const response = await client.api["live-engineer"]["voice-pack"].$get();
      if (!response.ok) throw new Error(`Voice pack status failed (${response.status})`);
      return await response.json() as LiveEngineerVoicePackStatus;
    },
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useLiveEngineerVoicePackMutation(action: "check" | "install") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: action === "install" ? liveEngineerVoicePackInstallKey : ["live-engineer-voice-pack-check"],
    mutationFn: async () => {
      const response = await client.api["live-engineer"]["voice-pack"][action].$post();
      if (!response.ok) throw new Error(`Voice pack ${action} failed (${response.status})`);
      return await response.json() as LiveEngineerVoicePackStatus;
    },
    onSuccess: (status) => queryClient.setQueryData(liveEngineerVoicePackQueryKey, status),
    onSettled: () => queryClient.invalidateQueries({ queryKey: liveEngineerVoicePackQueryKey }),
  });
}
