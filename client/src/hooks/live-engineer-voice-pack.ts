import { useQuery } from "@tanstack/react-query";
import type { LiveEngineerVoicePackStatus } from "@raceiq/live-engineer/audio-package";
import { client } from "../lib/rpc";

export const liveEngineerVoicePackQueryKey = ["live-engineer-voice-pack"] as const;

export function useLiveEngineerVoicePackStatus() {
  return useQuery<LiveEngineerVoicePackStatus>({
    queryKey: liveEngineerVoicePackQueryKey,
    queryFn: async () => {
      const response = await client.api["live-engineer"]["voice-pack"].$get();
      if (!response.ok) throw new Error(`Voice pack status failed (${response.status})`);
      return await response.json() as LiveEngineerVoicePackStatus;
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
