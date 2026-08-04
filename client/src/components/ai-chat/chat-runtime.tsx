"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, createResumableSessionStorage, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import { useState } from "react";
import { Thread, type ThreadProps } from "@/components/assistant-ui/thread";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatGeneration } from "./chat-history";
import { TokenUsageFooter } from "./token-usage";

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
  activeThreadId,
  onViewGen,
  onForked,
  readOnly,
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
  activeThreadId?: string;
  onViewGen: (gen: number) => void;
  onForked: (newGen: number) => void;
  readOnly: boolean;
}) {
  const transport = activeThreadId
    ? new AssistantChatTransport({
        api,
        body: extraBody,
        resumable: {
          storage: createResumableSessionStorage({ key: `chat-resume-${activeThreadId}` }),
          resumeApi: () => `/api/chats/${encodeURIComponent(activeThreadId)}/run/stream`,
        },
      })
    : new AssistantChatTransport({ api, body: extraBody });

  const runtime = useChatRuntime({ messages: initialMessages, transport, onFinish });
  const [compacting, setCompacting] = useState(false);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <div className={className ?? "h-full min-h-0 flex flex-col text-app-compact [&_*]:text-app-compact [&_svg]:size-3.5 [&_.aui-composer-input]:text-app-compact"}>
          {readOnly && (
            <div className="shrink-0 px-2 py-1 text-app-caption text-status-warning bg-status-warning/10 border-b border-status-warning/30">
              Viewing an earlier chat (read-only). Switch to the latest to continue.
            </div>
          )}
          <div className="flex-1 min-h-0 flex flex-col">
            <Thread components={components} inputDisabled={compacting || readOnly} />
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
        </div>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}
