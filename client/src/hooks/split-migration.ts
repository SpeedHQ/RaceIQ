import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/query-keys";
import { useDashboardAuth } from "@/lib/dashboard-auth";
import { client } from "@/lib/rpc";

export interface SplitMigrationStatus {
  sessionCount: number;
  progress: {
    status: "idle" | "running" | "success" | "partial" | "error";
    done: number;
    total: number;
    migrated: number;
    failed: number;
    error: string | null;
  };
}

export function useSplitMigration() {
  const { status } = useDashboardAuth();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.splitMigration,
    enabled: !status.pending && status.authenticated,
    queryFn: async (): Promise<SplitMigrationStatus> => {
      const response = await client.api.storage["split-migration"].$get();
      if (!response.ok) throw new Error("split-migration-status");
      const next: SplitMigrationStatus = await response.json();
      const previous = queryClient.getQueryData<SplitMigrationStatus>(queryKeys.splitMigration);
      if (previous?.progress.status === "running" && next.progress.status !== "running") {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
          queryClient.invalidateQueries({ queryKey: queryKeys.laps }),
        ]);
      }
      return next;
    },
    refetchInterval: (query) => query.state.data?.progress.status === "running" ? 1000 : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useStartSplitMigration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.splitMigrationStart,
    mutationFn: async () => {
      const response = await client.api.storage["split-migration"].$post({ json: {} });
      const body: unknown = await response.json();
      if (!response.ok) {
        const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : undefined;
        throw Object.assign(new Error("split-migration-start"), { code });
      }
      return body as SplitMigrationStatus;
    },
    onSuccess: (snapshot) => {
      queryClient.setQueryData(queryKeys.splitMigration, snapshot);
      void queryClient.invalidateQueries({ queryKey: queryKeys.splitMigration });
    },
  });
}
