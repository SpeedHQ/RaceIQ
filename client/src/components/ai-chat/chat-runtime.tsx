"use client";

import { AssistantRuntimeProvider, useAui } from "@assistant-ui/react";
import { AssistantChatTransport, createResumableSessionStorage, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import { Maximize2, Minimize2, MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { Thread, type ThreadProps } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
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
  onClearChat: () => void;
}) {
  const transport = resumableThreadId
    ? new AssistantChatTransport({
        api,
        body: extraBody,
        resumable: {
          storage: createResumableSessionStorage({ key: `chat-resume-${resumableThreadId}` }),
          resumeApi: () => `/api/chats/${encodeURIComponent(resumableThreadId)}/run/stream`,
        },
      })
    : new AssistantChatTransport({ api, body: extraBody });
  const runtime = useChatRuntime({ messages: initialMessages, transport, onFinish });
  const [compacting, setCompacting] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const copyChat = () => {
    void (async () => {
      try {
        const url = new URL(api, window.location.origin);
        url.searchParams.set("export", "1");
        url.searchParams.set("gen", String(viewingGen));
        const response = await fetch(url);
        if (!response.ok) throw new Error("Could not load chat export");
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
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-app-border/40 px-2 py-1">
        <span className="font-medium text-app-text">{fullscreen ? "AI chat" : ""}</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="app-outline"
            size="icon-xs"
            onClick={() => setFullscreen((open) => !open)}
            title={fullscreen ? "Close full screen chat" : "Open full screen chat"}
            aria-label={fullscreen ? "Close full screen chat" : "Open full screen chat"}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <DropdownMenu
            trigger={
              <Button type="button" variant="app-outline" size="icon-xs" title="Chat actions" aria-label="Chat actions">
                <MoreHorizontal />
              </Button>
            }
            items={[
              { key: "copy", label: "Copy chat JSON", onClick: copyChat },
              { key: "clear", label: "Clear chat", onClick: onClearChat },
            ]}
          />
        </div>
      </div>
      {readOnly && (
        <div className="shrink-0 border-b border-status-warning/30 bg-status-warning/10 px-2 py-1 text-app-caption text-status-warning">
          Viewing an earlier chat (read-only). Switch to the latest to continue.
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <PendingPromptSubmit prompt={regeneratePrompt} onSubmitted={onSubmitted} />
        <Thread components={components} inputDisabled={compacting || readOnly || inputDisabled} onRegenerate={readOnly ? undefined : onRegenerate} />
      </div>
      <TokenUsageFooter
        compactThreadId={compactThreadId}
        historyQueryKey={historyQueryKey}
        compacting={compacting}
        setCompacting={setCompacting}
        generations={generations}
        viewingGen={viewingGen}
        activeGen={activeGen}
        onViewGen={onViewGen}
        onForked={onForked}
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
                <DialogTitle>AI chat</DialogTitle>
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
