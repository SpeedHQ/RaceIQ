import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@/lib/rpc";
import { queryKeys } from "@/hooks/query-keys";

export function useRecordingDirectoryStatus() {
  return useQuery({ queryKey: queryKeys.recordingDirectoryStatus, queryFn: async () => {
    const response = await client.api.storage["recording-directory"].$get();
    if (!response.ok) throw new Error("status");
    return response.json();
  }, refetchInterval: (query) => query.state.data?.state === "moving" ? 500 : false });
}

export function useRecordingDirectories(path: string | undefined, enabled: boolean) {
  return useQuery({ queryKey: [...queryKeys.recordingDirectories, path ?? ""], enabled, queryFn: async () => {
    const response = await client.api.storage.directories.$get({ query: path ? { path } : {} });
    if (!response.ok) throw new Error("browse");
    return response.json();
  } });
}

export function useMoveRecordingDirectory() {
  const queryClient = useQueryClient();
  return useMutation({ mutationKey: queryKeys.recordingDirectoryMove, mutationFn: async (directory: string) => {
    const response = await client.api.storage["recording-directory"].$post({ json: { directory } });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error("move"), { code: (body as { code?: string }).code });
    return body;
  }, onSettled: async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.recordingDirectoryStatus }), queryClient.invalidateQueries({ queryKey: queryKeys.settings })]);
  }, onError: async () => {
    await Promise.all([queryClient.refetchQueries({ queryKey: queryKeys.recordingDirectoryStatus }), queryClient.invalidateQueries({ queryKey: queryKeys.settings })]);
  }, onSuccess: async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.settings }), queryClient.invalidateQueries({ queryKey: queryKeys.storageSessions }), queryClient.invalidateQueries({ queryKey: queryKeys.sessions }), queryClient.invalidateQueries({ queryKey: queryKeys.laps }), queryClient.invalidateQueries({ queryKey: queryKeys.cacheStatus })]);
  } });
}
