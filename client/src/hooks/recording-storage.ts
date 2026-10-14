
import type { RecordingDirectoryMoveStatus } from "@raceiq/backend-core/session-capture/relocate-recordings";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@/lib/rpc";
import { useDashboardAuth } from "@/lib/dashboard-auth";
import { queryKeys } from "@/hooks/query-keys";

export interface RecordingDirectoryPreflight {
  current: string;
  destination: string;
  containsFiles: boolean;
}

export function usePreflightRecordingDirectory() {
  return useMutation({
    mutationKey: [...queryKeys.recordingDirectoryMove, "preflight"],
    mutationFn: async (directory: string): Promise<RecordingDirectoryPreflight> => {
      const response = await client.api.storage["recording-directory"].preflight.$post({ json: { directory } });
      const body: unknown = await response.json();
      if (!response.ok) {
        const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : undefined;
        throw Object.assign(new Error("recording-directory-preflight"), { code });
      }
      if (!body || typeof body !== "object" || !("current" in body) || typeof body.current !== "string" || !("destination" in body) || typeof body.destination !== "string" || !("containsFiles" in body) || typeof body.containsFiles !== "boolean") throw new Error("recording-directory-preflight-response");
      return body as RecordingDirectoryPreflight;
    },
  });
}

export function useSelectRecordingDirectory() {
  return useMutation({
    mutationKey: queryKeys.recordingDirectorySelect,
    mutationFn: async (directory?: string) => {
      const response = await client.api.storage["select-directory"].$post({ json: directory ? { directory } : {} });
      const body: unknown = await response.json();
      if (!response.ok) {
        const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : undefined;
        throw Object.assign(new Error("select-directory"), { code });
      }
      if (!body || typeof body !== "object" || !("directory" in body) || !(typeof body.directory === "string" || body.directory === null)) throw new Error("select-directory-response");
      return { directory: body.directory };
    },
  });
}

export interface RecordingLayoutMigrationStatus {
  directory: string;
  destinationDirectory: string | null;
  fileCount: number;
  sessionCount: number;
  progress: {
    status: "idle" | "running" | "success" | "partial" | "error";
    phase: "organizing" | "relocating" | null;
    done: number;
    total: number;
    migrated: number;
    failed: number;
    error: string | null;
  };
}

export function useRecordingLayoutMigration() {
  const { status } = useDashboardAuth();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.recordingLayoutMigration,
    enabled: !status.pending && status.authenticated,
    queryFn: async (): Promise<RecordingLayoutMigrationStatus> => {
      const response = await client.api.storage["layout-migration"].$get();
      if (!response.ok) throw new Error("layout-migration-status");
      const next: RecordingLayoutMigrationStatus = await response.json();
      const previous = queryClient.getQueryData<RecordingLayoutMigrationStatus>(queryKeys.recordingLayoutMigration);
      if (previous?.progress.status === "running" && ["success", "partial", "error"].includes(next.progress.status)) {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.storageSessions }),
          queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
          queryClient.invalidateQueries({ queryKey: queryKeys.laps }),
          queryClient.invalidateQueries({ queryKey: queryKeys.recordingDirectoryStatus }),
          queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
          queryClient.invalidateQueries({ queryKey: queryKeys.cacheStatus }),
        ]);
      }
      return next;
    },
    refetchInterval: (current) => current.state.data?.progress.status === "running" ? 1000 : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  return query;
}

export function useStartRecordingLayoutMigration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.recordingLayoutMigrationStart,
    mutationFn: async (directory?: string) => {
      const response = await client.api.storage["layout-migration"].$post({ json: directory ? { directory } : {} });
      const body = await response.json();
      if (!response.ok) {
        let code: string | undefined;
        if (body && typeof body === "object" && "code" in body && typeof body.code === "string") code = body.code;
        throw Object.assign(new Error("layout-migration-start"), { code });
      }
      return body;
    },
    onSuccess: (_data, directory) => {
      const current = queryClient.getQueryData<RecordingLayoutMigrationStatus>(queryKeys.recordingLayoutMigration);
      if (current) queryClient.setQueryData<RecordingLayoutMigrationStatus>(queryKeys.recordingLayoutMigration, {
        ...current,
        destinationDirectory: directory ?? current.directory,
        progress: { ...current.progress, status: "running", phase: "organizing", error: null },
      });
      else queryClient.setQueryData<RecordingLayoutMigrationStatus>(queryKeys.recordingLayoutMigration, {
        directory: "", destinationDirectory: directory ?? null, fileCount: 0, sessionCount: 0,
        progress: { status: "running", phase: "organizing", done: 0, total: 0, migrated: 0, failed: 0, error: null },
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordingLayoutMigration });
    },
  });
}


export function useRecordingDirectoryStatus() {
  const { status } = useDashboardAuth();
  const queryClient = useQueryClient();
  return useQuery({ queryKey: queryKeys.recordingDirectoryStatus, enabled: !status.pending && status.authenticated, queryFn: async () => {
    const response = await client.api.storage["recording-directory"].$get();
    if (!response.ok) throw new Error("status");
    const next = await response.json();
    const previous = queryClient.getQueryData<RecordingDirectoryMoveStatus>(queryKeys.recordingDirectoryStatus);
    if (previous?.state === "moving" && next.state !== "moving") {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.recordingLayoutMigration }),
        queryClient.invalidateQueries({ queryKey: queryKeys.storageSessions }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
        queryClient.invalidateQueries({ queryKey: queryKeys.laps }),
        queryClient.invalidateQueries({ queryKey: queryKeys.cacheStatus }),
      ]);
    }
    return next;
  }, refetchInterval: (query) => query.state.data?.state === "moving" ? 500 : false });
}


export function useMoveRecordingDirectory() {
  const queryClient = useQueryClient();
  return useMutation({ mutationKey: queryKeys.recordingDirectoryMove, mutationFn: async (directory: string) => {
    const response = await client.api.storage["recording-directory"].$post({ json: { directory } });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error("move"), { code: (body as { code?: string }).code });
    return body;
  }, onSettled: async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.recordingDirectoryStatus }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
      queryClient.invalidateQueries({ queryKey: queryKeys.recordingLayoutMigration }),
    ]);
  }, onError: async () => {
    await Promise.all([queryClient.refetchQueries({ queryKey: queryKeys.recordingDirectoryStatus }), queryClient.invalidateQueries({ queryKey: queryKeys.settings })]);
  }, onSuccess: async (result) => {
    if ("operationId" in result && !result.noOp) {
      const current = queryClient.getQueryData<RecordingDirectoryMoveStatus>(queryKeys.recordingDirectoryStatus);
      if (current) queryClient.setQueryData<RecordingDirectoryMoveStatus>(queryKeys.recordingDirectoryStatus, {
        ...current, operationId: result.operationId, state: "moving", phase: "copying", completedFiles: 0, totalFiles: 0, code: null, error: null,
      });
    }
    await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.settings }), queryClient.invalidateQueries({ queryKey: queryKeys.storageSessions }), queryClient.invalidateQueries({ queryKey: queryKeys.sessions }), queryClient.invalidateQueries({ queryKey: queryKeys.laps }), queryClient.invalidateQueries({ queryKey: queryKeys.cacheStatus })]);
  } });
}
