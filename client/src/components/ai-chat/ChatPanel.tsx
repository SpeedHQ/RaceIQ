import { createResumableSessionStorage } from "@assistant-ui/react-ai-sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { useState } from "react";
import type { ThreadProps } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/settings";
import { isAiConfigured } from "@/lib/is-ai-configured";
import { m } from "@/paraglide/messages";
import { useUiStore } from "@/stores/ui";
import { type ChatGeneration, fetchChatGenerations, fetchChatRunStatus } from "./chat-history";
import { ChatPanelThread } from "./chat-runtime";

export interface ChatPanelProps {
  api: string;
  fetchHistory: (gen?: number) => Promise<UIMessage[]>;
  historyQueryKey: unknown[];
  remountKey?: string;
  onFinish?: () => void;
  components?: ThreadProps["components"];
  /** Disable composing while the owning surface is not ready for chat. */
  inputDisabled?: boolean;
  emptyState?: React.ReactNode;
  className?: string;
  extraBody?: Record<string, unknown>;
  compactThreadId?: string;
}

export function ChatPanel({ api, clearChatApi, fetchHistory, historyQueryKey, remountKey, onFinish, components, emptyState, className, extraBody, compactThreadId, inputDisabled }: ChatPanelProps) {
  const { displaySettings } = useSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const aiConfigured = isAiConfigured(displaySettings);
  const queryClient = useQueryClient();
  const { data: gensData } = useQuery({
    queryKey: ["chat-generations", compactThreadId],
    queryFn: () => fetchChatGenerations(compactThreadId!),
    enabled: !!compactThreadId,
    staleTime: 5_000,
  });
  const generations: ChatGeneration[] = gensData?.generations ?? (compactThreadId ? [{ threadId: compactThreadId, generation: 1, active: true }] : []);
  const activeGen = generations.length ? generations[generations.length - 1].generation : 1;
  const activeThreadId = gensData?.activeThreadId ?? compactThreadId;
  const [viewingGen, setViewingGen] = useState<number | null>(null);
  const effectiveGen = viewingGen ?? activeGen;
  const readOnly = !!compactThreadId && effectiveGen !== activeGen;
  const fullHistoryQueryKey = [...historyQueryKey, effectiveGen];
  const {
    data: history,
    isSuccess,
    isError,
    error: historyError,
  } = useQuery({
    queryKey: fullHistoryQueryKey,
    queryFn: () => fetchHistory(effectiveGen),
  });
  const { data: runStatus, isFetched: runStatusFetched } = useQuery({
    queryKey: ["chat-run-status", activeThreadId],
    queryFn: () => fetchChatRunStatus(activeThreadId!),
    enabled: !!activeThreadId,
    staleTime: 0,
    gcTime: 0,
  });
  const resumableThreadId = resolvedResumableThreadId(activeThreadId, runStatus, runStatusFetched);
  if (resumableThreadId && runStatus?.runId) {
    createResumableSessionStorage({ key: `chat-resume-${resumableThreadId}` }).setStreamId(runStatus.runId);
  }
  if (!aiConfigured) {
    return (
      emptyState ?? (
        <div className="pt-2 space-y-1.5">
          <p className="text-app-compact text-app-text-dim">Add an AI provider key to chat.</p>
          <button type="button" onClick={() => openSettings("ai")} className="w-full px-3 py-1.5 text-xs rounded bg-ai-accent hover:bg-ai-accent-hover text-app-on-filled font-medium">
            Set up AI
          </button>
        </div>
      )
    );
  }
  if (isError) {
    return (
      <div role="alert" className="h-full min-h-0 flex flex-col pt-2 gap-1.5 text-app-compact text-status-danger">
        {historyError instanceof Error ? historyError.message : m.common_error()}
      </div>
    );
  }
  if (!isSuccess || (!!compactThreadId && !runStatusFetched)) {
    return <div className="h-full min-h-0 flex flex-col pt-2 gap-1.5 text-app-compact text-app-text-dim">{m.common_loading()}</div>;
  }
  return (
    <ChatPanelThread
      key={`${remountKey ?? ""}:${effectiveGen}:${history?.length ?? 0}:${clearVersion}:${regenerateVersion}`}
      initialMessages={history ?? []}
      api={api}
      onFinish={onFinish}
      components={components}
      className={className}
      extraBody={extraBody}
      compactThreadId={compactThreadId}
      historyQueryKey={fullHistoryQueryKey}
      generations={generations}
      viewingGen={effectiveGen}
      activeGen={activeGen}
      activeThreadId={activeThreadId}
      onViewGen={setViewingGen}
      onForked={(newGen) => {
        void queryClient.invalidateQueries({ queryKey: historyQueryKey });
        setViewingGen(newGen);
      }}
      onRegenerate={readOnly || !activeThreadId || runStatus?.status === "active" ? undefined : regenerateChat}
      regeneratePrompt={regeneratePrompt}
      onSubmitted={() => setRegeneratePrompt(undefined)}
      readOnly={readOnly}
      inputDisabled={inputDisabled}
      onClearChat={() => void clearChat()}
    />
  );
}
