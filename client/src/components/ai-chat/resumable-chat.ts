export type ChatRunStatus = {
  status: "none" | "active" | "finished";
  runId?: string;
};

export function resolvedResumableThreadId(threadId: string | undefined, runStatus: ChatRunStatus | undefined, runStatusFetched: boolean): string | undefined {
  if (!threadId || !runStatusFetched || runStatus?.status !== "active" || !runStatus.runId) return undefined;
  return threadId;
}
