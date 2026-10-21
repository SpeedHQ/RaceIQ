import { CancelledError, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DriverBindingInput, DriverBindingsSnapshot } from "@raceiq/online/contracts";
import { client } from "@/lib/rpc";
import { isOnlineCommandResult, OnlineTransportFailure, receiveOnlineResponse } from "@/lib/raceiq-online";
import { dashboardQueryKeys } from "./dashboard";
import { useRaceIqOnline } from "./raceiq-online";

/** Candidates are opaque current-source receipts, never editable native identity descriptors. */
export function useDriverBindings() {
  const online = useRaceIqOnline();
  const queryClient = useQueryClient();
  const state = online.state;
  const enabled = !!state && !online.accountHidden && !online.signOutPending;
  const query = useQuery<DriverBindingsSnapshot>({
    queryKey: ["driver-bindings", state?.accountEpoch, state?.revision, online.communityGeneration],
    enabled,
    queryFn: async ({ signal }) => {
      if (!online.isCurrentContext()) throw new CancelledError({ silent: true });
      const response = await client.api["driver-bindings"].$get(undefined, { init: { signal } });
      if (response.status !== 200) throw new OnlineTransportFailure("backend_unreachable");
      const snapshot = await response.json();
      if (signal.aborted || !online.isCurrentContext()) throw new CancelledError({ silent: true });
      return snapshot;
    },
    refetchInterval: 5_000,
    retry: false,
  });
  const confirmation = useMutation({
    mutationFn: async (input: DriverBindingInput) => {
      if (!online.isCurrentContext() || input.accountEpoch !== state?.accountEpoch || input.expectedRevision !== state.revision) throw new CancelledError({ silent: true });
      const response = await client.api["driver-bindings"].$put({ json: input });
      const result = await receiveOnlineResponse(response, isOnlineCommandResult, [200, 400, 401, 403, 409, 429, 500, 503]);
      if (!online.isCurrentContext()) throw new CancelledError({ silent: true });
      return result;
    },
    onSettled: async () => {
      await online.refresh();
      void queryClient.invalidateQueries({ queryKey: ["driver-bindings"] });
      void queryClient.invalidateQueries({ queryKey: ["driver-summary"] });
      void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.all });
    },
    retry: false,
  });
  const currentMutation = confirmation.variables?.accountEpoch === state?.accountEpoch && confirmation.variables?.expectedRevision === state?.revision;
  return {
    ...query,
    data: enabled && !query.isError ? query.data : undefined,
    isPending: online.isPending || enabled && query.isPending,
    online,
    canConfirm: enabled && !online.isCachedState && !online.transportError && !online.isMutating && !confirmation.isPending && !query.isError,
    confirming: confirmation.isPending,
    result: currentMutation ? confirmation.data : undefined,
    confirmationError: currentMutation && !(confirmation.error instanceof CancelledError) ? confirmation.error : null,
    confirm: (candidateId: string) => {
      if (!state || !online.isCurrentContext() || online.isCachedState || online.transportError || online.isMutating || confirmation.isPending || query.isError) return;
      confirmation.mutate({ accountEpoch: state.accountEpoch, expectedRevision: state.revision, candidateId, confirmedByUser: true });
    },
  };
}
