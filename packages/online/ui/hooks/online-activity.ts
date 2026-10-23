import { CancelledError, useQuery } from "@tanstack/react-query";
import type { DriverSummaryResponse, OnlineProfileResponse, UploadPage } from "@raceiq/online/contracts";
import { useOnlineHost, useRaceIqOnline } from "./raceiq-online";

export class DriverSummaryBuilding extends Error {}

/** Local history remains readable without cloud sign-in; context changes discard late pages. */
export function useOnlineUploads(view: "queue" | "history", cursor: string | null) {
  const host = useOnlineHost();
  const online = useRaceIqOnline();
  const state = online.state;
  const query = useQuery<UploadPage>({
    queryKey: ["raceiq-online", "uploads", state?.accountEpoch, state?.revision, online.communityGeneration, view, cursor],
    enabled: !!state && !online.accountHidden && !online.signOutPending,
    queryFn: async ({ signal }) => {
      if (!state || !online.isCurrentContext()) throw new CancelledError({ silent: true });
      const page = await host.getUploads(view, cursor, { accountEpoch: state.accountEpoch, expectedRevision: state.revision }, signal);
      if (signal.aborted || !online.isCurrentContext() || page.accountEpoch !== state.accountEpoch) throw new CancelledError({ silent: true });
      return page;
    },
    refetchInterval: 5_000,
    retry: false,
  });
  return { ...query, isPending: online.isPending || !!state && !online.accountHidden && !online.signOutPending && query.isPending, data: state && !online.accountHidden && !online.signOutPending ? query.data : undefined, online };
}

export function useLocalDriverSummary(input: { gameId: string | null; from: string; to: string }) {
  const host = useOnlineHost();
  return useQuery<DriverSummaryResponse>({
    queryKey: ["driver-summary", input.gameId, input.from, input.to],
    queryFn: async ({ signal }) => {
      return await host.getDriverSummary(input, signal);
    },
    refetchInterval: (query) => query.state.error instanceof DriverSummaryBuilding ? 2_000 : 30_000,
    retry: false,
  });
}

export function useOnlineProfile() {
  const host = useOnlineHost();
  const online = useRaceIqOnline();
  const state = online.state;
  const enabled = !!state && !online.isCachedState && !online.accountHidden && !online.signOutPending;
  const query = useQuery<OnlineProfileResponse>({
    queryKey: ["raceiq-online", "lifetime-profile", state?.accountEpoch, state?.revision, online.communityGeneration],
    enabled,
    queryFn: async ({ signal }) => {
      if (!state || !online.isCurrentContext()) throw new CancelledError({ silent: true });
      const profile = await host.getOnlineProfile({ accountEpoch: state.accountEpoch, expectedRevision: state.revision }, signal);
      if (signal.aborted || !online.isCurrentContext() || profile.accountEpoch !== state.accountEpoch) throw new CancelledError({ silent: true });
      return profile;
    },
    refetchInterval: 10_000,
    retry: false,
  });
  return { ...query, isPending: online.isPending || enabled && query.isPending, data: enabled ? query.data : undefined, online };
}
