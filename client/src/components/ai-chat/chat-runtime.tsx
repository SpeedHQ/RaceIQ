"use client";

import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import { AssistantChatTransport, createResumableSessionStorage, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { Maximize2, Minimize2, MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { Thread, type ThreadProps } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { downloadResponse } from "@/lib/lap-export";
import { authenticatedFetch, client } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { ChatGeneration } from "./chat-history";
import { TokenUsageFooter } from "./token-usage";

function PendingPromptSubmit({ prompt, onSubmitted }: { prompt?: string; onSubmitted: () => void }) {
  const aui = useAui();
  useEffect(() => {
    if (!prompt) return;
    aui.thread().append({ role: "user", content: [{ type: "text", text: prompt }] });
    onSubmitted();
  }, [aui, onSubmitted, prompt]);
  return null;
}

function ChatActions({ onCopy, onExport, exportDisabled, onClear, onCompact, compacting }: {
  onCopy: () => void;
  onExport: () => void;
  exportDisabled: boolean;
  onClear: () => void;
  onCompact?: () => void;
  compacting: boolean;
}) {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  return (
    <DropdownMenu
      trigger={
        <Button type="button" variant="app-outline" size="icon-xs" title={m.ai_chat_actions()} aria-label={m.ai_chat_actions()}>
          <MoreHorizontal />
        </Button>
      }
      items={[
        { key: "copy", label: m.ai_chat_copy_json(), onClick: onCopy },
        { key: "export", label: m.ai_chat_export_json(), onClick: onExport, disabled: exportDisabled },
        ...(onCompact ? [{ key: "compact", label: m.ai_chat_compact_new_chat(), title: m.ai_chat_compact_title(), onClick: onCompact, disabled: compacting || isRunning }] : []),
        { key: "clear", label: m.ai_chat_clear(), onClick: onClear },
      ]}
    />
  );
}

export function ChatPanelThread({
  api,
  initialMessages,
  onFinish,
  components,
  className,
  extraBody,
  compactThreadId,
  historyQueryKey,
  generations,
  viewingGen,
  activeGen,
  resumableThreadId,
  onViewGen,
  onForked,
  onRegenerate,
  regeneratePrompt,
  onSubmitted,
  readOnly,
  inputDisabled,
  onClearChat,
  imageDisabled,
  imageNotice,
  onRemoveFailedTurn,
}: {
  api: string;
  initialMessages: UIMessage[];
  onFinish?: () => void;
  components?: ThreadProps["components"];
  className?: string;
  extraBody?: Record<string, unknown>;
  compactThreadId?: string;
  historyQueryKey: unknown[];
  generations: ChatGeneration[];
  viewingGen: number;
  activeGen: number;
  resumableThreadId?: string;
  onViewGen: (gen: number) => void;
  onForked: (newGen: number) => void;
  onRegenerate?: (messageId: string, prompt: string) => void;
  regeneratePrompt?: string;
  onSubmitted: () => void;
  readOnly: boolean;
  inputDisabled?: boolean;
  imageDisabled: boolean;
  imageNotice?: string;
  onRemoveFailedTurn: (messageId: string) => Promise<void>;
  onClearChat: () => void;
}) {
  const [requestError, setRequestError] = useState<unknown>(null);
  const fetchChat = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    setRequestError(null);
    const response = await authenticatedFetch(input, init);
    if (response.status === 409 && api.startsWith("/api/experiments/") && api.endsWith("/chat")) {
      const body = await response.clone().json().catch(() => null) as { code?: string } | null;
      if (body?.code === "stale_experiment_head" || body?.code === "experiment_chat_run_branch_conflict") {
        setRequestError("stale-experiment-head");
      }
    }
    return response;
  }, fetch);
  const transport = resumableThreadId
    ? new AssistantChatTransport({
        api,
        body: extraBody,
        fetch: fetchChat,
        resumable: {
          storage: createResumableSessionStorage({ key: `chat-resume-${resumableThreadId}` }),
          resumeApi: () => `/api/chats/${encodeURIComponent(resumableThreadId)}/run/stream`,
        },
      })
    : new AssistantChatTransport({
        api,
        body: extraBody,
        fetch: fetchChat,
      });
  const runtime = useChatRuntime({
    messages: initialMessages,
    transport,
    onFinish,
  });
  const queryClient = useQueryClient();
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);

  const compactChat = async () => {
    if (!compactThreadId || compacting || runtime.thread.getState().isRunning) return;
    setCompacting(true);
    setCompactError(null);
    try {
      const res = await client.api.chats[":threadId"].compact.$post({ param: { threadId: compactThreadId } });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : undefined;
        setCompactError(error ?? m.ai_chat_compact_failed());
        return;
      }
      const body = (await res.json()) as { generation: number };
      await queryClient.invalidateQueries({ queryKey: ["chat-generations", compactThreadId] });
      await queryClient.invalidateQueries({ queryKey: historyQueryKey.slice(0, -1) });
      onForked(body.generation);
    } catch {
      setCompactError(m.ai_chat_compact_failed());
    } finally {
      setCompacting(false);
    }
  };

  const exportChat = async () => {
    if (!compactThreadId || exporting) return;
    setExporting(true);
    setExportError(false);
    try {
      const response = await fetch(`/api/chats/${encodeURIComponent(compactThreadId)}/export`);
      if (!response.ok) throw new Error(m.ai_chat_export_failed());
      await downloadResponse(response, `${compactThreadId}-chat.json`);
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  };

  const copyChat = () => {
    void (async () => {
      try {
        const url = new URL(api, window.location.origin);
        url.searchParams.set("export", "1");
        url.searchParams.set("gen", String(viewingGen));
        const response = await fetch(url);
        if (!response.ok) throw new Error(m.ai_chat_export_failed());
        const data = (await response.json()) as { messages?: unknown[] };
        await navigator.clipboard.writeText(JSON.stringify({ messages: data.messages ?? [] }, null, 2));
      } catch {
        // Clipboard and export failures leave chat state unchanged.
      }
    })();
  };

  const surfaceClassName = "flex min-h-0 flex-col text-app-compact [&_*]:text-app-compact [&_svg]:size-3.5 [&_.aui-composer-input]:text-app-compact";
  const chatSurface = (
    <>
      {requestError === "stale-experiment-head" && (
        <div role="alert" className="shrink-0 border-b border-status-warning/30 bg-status-warning/10 px-2 py-1 text-app-caption text-status-warning">
          {m.ai_chat_experiment_head_stale()}
        </div>
      )}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-app-border/40 px-2 py-1">
        <span className="font-medium text-app-text">{fullscreen ? m.ai_chat_title() : ""}</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="app-outline"
            size="icon-xs"
            onClick={() => setFullscreen((open) => !open)}
            title={fullscreen ? m.ai_chat_close_fullscreen() : m.ai_chat_open_fullscreen()}
            aria-label={fullscreen ? m.ai_chat_close_fullscreen() : m.ai_chat_open_fullscreen()}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <ChatActions
            onCopy={copyChat}
            onExport={() => void exportChat()}
            exportDisabled={!compactThreadId || exporting}
            onClear={onClearChat}
            onCompact={compactThreadId ? () => void compactChat() : undefined}
            compacting={compacting}
          />
        </div>
      </div>
      {exportError && <div role="alert" className="shrink-0 px-2 py-1 text-status-danger">{m.ai_chat_export_failed()}</div>}
      {compacting && <div role="status" className="shrink-0 px-2 py-1 text-app-text-muted">{m.ai_chat_compacting()}</div>}
      {compactError && <div role="alert" className="shrink-0 px-2 py-1 text-status-danger">{compactError}</div>}
      {readOnly && (
        <div className="shrink-0 border-b border-status-warning/30 bg-status-warning/10 px-2 py-1 text-app-caption text-status-warning">
          {m.ai_chat_read_only_notice()}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <PendingPromptSubmit prompt={regeneratePrompt} onSubmitted={onSubmitted} />
        <Thread components={components} inputDisabled={compacting || readOnly || inputDisabled} imageDisabled={imageDisabled} imageNotice={imageNotice} onRegenerate={readOnly ? undefined : onRegenerate} onRemoveFailedTurn={async (messageId) => {
          await onRemoveFailedTurn(messageId);
          await runtime.thread.deleteMessage(messageId);
        }} />
      </div>
      <TokenUsageFooter
        compactThreadId={compactThreadId}
        generations={generations}
        viewingGen={viewingGen}
        activeGen={activeGen}
        onViewGen={onViewGen}
      />
    </>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        {fullscreen ? (
          <Dialog open onOpenChange={setFullscreen}>
            <DialogContent layout="fullscreen" showCloseButton={false} overlayClassName="bg-app-bg/60" className={surfaceClassName}>
              <DialogHeader className="sr-only">
                <DialogTitle>{m.ai_chat_title()}</DialogTitle>
              </DialogHeader>
              {chatSurface}
            </DialogContent>
          </Dialog>
        ) : (
          <div className={cn(surfaceClassName, "h-full", className)}>{chatSurface}</div>
        )}
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}
