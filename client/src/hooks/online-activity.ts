import { CancelledError, useQuery } from "@tanstack/react-query";
import type { DriverSummaryResponse, OnlineProfileResponse, UploadPage } from "@raceiq/online/contracts";
import { client } from "@/lib/rpc";
import { OnlineTransportFailure } from "@/lib/raceiq-online";
import { useRaceIqOnline } from "./raceiq-online";

export class DriverSummaryBuilding extends Error {}

/** Local history remains readable without cloud sign-in; context changes discard late pages. */
export function useOnlineUploads(view: "queue" | "history", cursor: string | null) {
  const online = useRaceIqOnline();
  const state = online.state;
  const query = useQuery<UploadPage>({
    queryKey: ["raceiq-online", "uploads", state?.accountEpoch, state?.revision, online.communityGeneration, view, cursor],
    enabled: !!state && !online.accountHidden && !online.signOutPending,
    queryFn: async ({ signal }) => {
      if (!state || !online.isCurrentContext()) throw new CancelledError({ silent: true });
      const response = await client.api.online.uploads.$get({ query: { view, ...(cursor ? { cursor } : {}), limit: "25", accountEpoch: state.accountEpoch, expectedRevision: String(state.revision) } }, { init: { signal } });
      if (response.status !== 200) throw new OnlineTransportFailure("backend_unreachable");
      const page = await response.json();
      if (signal.aborted || !online.isCurrentContext() || page.accountEpoch !== state.accountEpoch) throw new CancelledError({ silent: true });
      return page;
    },
    refetchInterval: 5_000,
    retry: false,
  });
  return { ...query, isPending: online.isPending || !!state && !online.accountHidden && !online.signOutPending && query.isPending, data: state && !online.accountHidden && !online.signOutPending ? query.data : undefined, online };
}

export function useLocalDriverSummary(input: { gameId: string | null; from: string; to: string }) {
  return useQuery<DriverSummaryResponse>({
    queryKey: ["driver-summary", input.gameId, input.from, input.to],
    queryFn: async ({ signal }) => {
      const response = await client.api["driver-summary"].$get({ query: { from: input.from, to: input.to } }, { headers: input.gameId ? { "X-Game-Id": input.gameId } : {}, init: { signal } });
      if (response.status === 202) throw new DriverSummaryBuilding();
      if (response.status !== 200) throw new OnlineTransportFailure("backend_unreachable");
      return await response.json();
    },
    refetchInterval: (query) => query.state.error instanceof DriverSummaryBuilding ? 2_000 : 30_000,
    retry: false,
  });
}

export function useOnlineProfile() {
  const online = useRaceIqOnline();
  const state = online.state;
  const enabled = !!state && !online.isCachedState && !online.accountHidden && !online.signOutPending;
  const query = useQuery<OnlineProfileResponse>({
    queryKey: ["raceiq-online", "lifetime-profile", state?.accountEpoch, state?.revision, online.communityGeneration],
    enabled,
    queryFn: async ({ signal }) => {
      if (!state || !online.isCurrentContext()) throw new CancelledError({ silent: true });
      const response = await client.api.online.profile.$get({ query: { accountEpoch: state.accountEpoch, expectedRevision: String(state.revision) } }, { init: { signal } });
      if (response.status !== 200 && response.status !== 503) throw new OnlineTransportFailure("backend_unreachable");
      const profile = await response.json();
      if (signal.aborted || !online.isCurrentContext() || profile.accountEpoch !== state.accountEpoch) throw new CancelledError({ silent: true });
      return profile;
    },
    refetchInterval: 10_000,
    retry: false,
  });
  return { ...query, isPending: online.isPending || enabled && query.isPending, data: enabled ? query.data : undefined, online };
}
