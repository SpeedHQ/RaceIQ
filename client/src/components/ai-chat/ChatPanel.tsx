import { client } from "@/lib/rpc";
import { resolveChatVisionCapability } from "../../../../shared/integrations/ai/chat-vision";
import { createResumableSessionStorage } from "@assistant-ui/react-ai-sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { useState } from "react";
import type { ThreadProps } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/settings";
import { isAiChatConfigured } from "@/lib/is-ai-configured";
import { authenticatedFetch } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { uiStore } from "@/stores/ui";
import { type ChatGeneration, fetchChatGenerations, fetchChatRunStatus } from "./chat-history";
import { ChatPanelThread } from "./chat-runtime";
import { resolvedResumableThreadId } from "./resumable-chat";


export interface ChatPanelProps {
  api: string;
  clearChatApi?: string;
  fetchHistory: (gen?: number) => Promise<UIMessage[]>;
  historyQueryKey: unknown[];
  remountKey?: string;
  onFinish?: () => void;
  components?: ThreadProps["components"];
  inputDisabled?: boolean;
  emptyState?: React.ReactNode;
  className?: string;
  extraBody?: Record<string, unknown>;
  compactThreadId?: string;
}

export function ChatPanel({ api, clearChatApi, fetchHistory, historyQueryKey, remountKey, onFinish, components, emptyState, className, extraBody, compactThreadId, inputDisabled }: ChatPanelProps) {
  const { displaySettings } = useSettings();
  const openSettings = uiStore.actions.openSettings;
  const aiConfigured = isAiChatConfigured(displaySettings);
  const visionCapability = resolveChatVisionCapability(displaySettings.chatProvider, displaySettings.chatModel);
  const queryClient = useQueryClient();
  const [clearVersion, setClearVersion] = useState(0);
  const [regenerateVersion, setRegenerateVersion] = useState(0);
  const [regeneratePrompt, setRegeneratePrompt] = useState<string>();
  const clearChat = async () => {
    try {
      const response = await authenticatedFetch(clearChatApi ?? api, { method: "DELETE" });
      if (!response.ok) throw new Error(m.ai_chat_regenerate_failed());
      await queryClient.invalidateQueries({ queryKey: historyQueryKey });
    } finally {
      setClearVersion((version) => version + 1);
    }
  };

  const removeFailedTurn = async (messageId: string) => {
    const match = /^\/api\/laps\/([^/?]+)\/chat(?:\?.*)?$/.exec(api);
    if (!match) throw new Error(m.ai_chat_remove_failed_turn_error());
    const response = await client.api.laps[":id"].chat.messages[":messageId"].$delete({
      param: { id: decodeURIComponent(match[1]), messageId },
    });
    if (!response.ok) throw new Error(m.ai_chat_remove_failed_turn_error());
    await queryClient.invalidateQueries({ queryKey: historyQueryKey });
  };

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
    queryFn: () => fetchHistory(effectiveGen > 1 ? effectiveGen : undefined),
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

  const regenerateChat = async (messageId: string, prompt: string) => {
    if (!activeThreadId || !prompt || !window.confirm(m.ai_chat_regenerate_confirmation())) return;
    try {
      const res = await authenticatedFetch(`/api/chats/${encodeURIComponent(activeThreadId)}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
      });
      const data = (await res.json().catch(() => null)) as { prompt?: string; error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? m.ai_chat_regenerate_failed());
      await queryClient.invalidateQueries({ queryKey: historyQueryKey });
      setRegeneratePrompt(data?.prompt ?? prompt);
      setRegenerateVersion((version) => version + 1);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : m.ai_chat_regenerate_failed());
    }
  };

  if (!aiConfigured) {
    return (
      emptyState ?? (
        <div className="flex flex-col gap-1.5 pt-2">
          <p className="text-app-compact text-app-text-dim">{m.ai_chat_add_provider_key()}</p>
          <Button type="button" variant="ai-action" size="app-md" onClick={() => openSettings("ai")} className="w-full">
            {m.ai_chat_setup_ai()}
          </Button>
        </div>
      )
    );
  }
  if (isError) {
    return (
      <div role="alert" className="flex h-full min-h-0 flex-col gap-1.5 pt-2 text-app-compact text-status-danger">
        {historyError instanceof Error ? historyError.message : m.common_error()}
      </div>
    );
  }
  if (!isSuccess || (!!compactThreadId && !runStatusFetched)) {
    return <div className="flex h-full min-h-0 flex-col gap-1.5 pt-2 text-app-compact text-app-text-dim">{m.common_loading()}</div>;
  }
  return (
    <ChatPanelThread
      key={`${remountKey ?? ""}:${effectiveGen}:${clearVersion}:${regenerateVersion}`}
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
      resumableThreadId={resumableThreadId}
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
      imageDisabled={visionCapability !== "supported"}
      imageNotice={visionCapability === "unsupported" ? m.ai_chat_image_unsupported() : visionCapability === "unknown" ? m.ai_chat_image_unverified() : undefined}
      onRemoveFailedTurn={removeFailedTurn}
      onClearChat={() => void clearChat()}
    />
  );
}
