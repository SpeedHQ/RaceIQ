import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime, useThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import { useQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { Thread, type ThreadProps } from "@/components/assistant-ui/thread";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSettings } from "../../hooks/queries";
import { isAiConfigured } from "../../lib/is-ai-configured";
import { useUiStore } from "../../stores/ui";

/**
 * ChatPanel — shared assistant-ui chat shell extracted from TuneSetupChat.tsx
 * (plan: migrate Lap Chat + Compare Chat onto the same modern streaming stack
 * as Setup Engineer chat). Renders via assistant-ui + the AI SDK v5
 * UI-message-stream protocol; the server route wraps a Mastra agent stream
 * with `streamAgentTurnResponse` (server/ai/agent-stream.ts) — assistant-ui's
 * `useChatRuntime` + `AssistantChatTransport` speak that protocol directly.
 *
 * Page-specific tool rendering stays out of this shared shell — pass a
 * `components` prop through to `<Thread/>` for per-page tool UI overrides.
 */

// Rough $/1M tokens for a cost estimate (input, output). Chat models are cheap;
// this is a ballpark shown as "≈", not billing.
const RATE_PER_MTOK: Record<string, { in: number; out: number }> = {
  gemini: { in: 0.1, out: 0.4 },
  openai: { in: 0.15, out: 0.6 },
  local: { in: 0, out: 0 },
};

/** Tool/token/cost stats for the latest reply — assistant-ui reads token usage
 *  from the AI SDK stream's message metadata via useThreadTokenUsage; cost is a
 *  rough client-side estimate from the configured chat provider's rates. */
function TokenUsageFooter() {
  const usage = useThreadTokenUsage();
  const { displaySettings } = useSettings();
  if (!usage || (usage.totalTokens ?? 0) === 0) return null;
  const provider = (displaySettings as { aiProvider?: string })?.aiProvider ?? "gemini";
  const rate = RATE_PER_MTOK[provider] ?? RATE_PER_MTOK.gemini;
  const cost = ((usage.inputTokens ?? 0) * rate.in + (usage.outputTokens ?? 0) * rate.out) / 1_000_000;
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-app-border/40 px-2 py-1 text-[9px] text-app-text-muted tabular-nums">
      <span>{usage.totalTokens} tok</span>
      {usage.inputTokens != null && <span>in {usage.inputTokens}</span>}
      {usage.outputTokens != null && <span>out {usage.outputTokens}</span>}
      {/* Reasoning/cached only surface when the provider reports them
          (Gemini/OpenAI reasoning models); hidden for models that don't. */}
      {(usage.reasoningTokens ?? 0) > 0 && <span>think {usage.reasoningTokens}</span>}
      {(usage.cachedInputTokens ?? 0) > 0 && <span>cached {usage.cachedInputTokens}</span>}
      {cost > 0 && <span>≈ ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}</span>}
    </div>
  );
}

export interface ChatPanelProps {
  /** Chat POST/stream endpoint, e.g. `/api/laps/${id}/chat`. */
  api: string;
  /** Fetch persisted thread history as real AI SDK v5 UIMessage[]. */
  fetchHistory: () => Promise<UIMessage[]>;
  /** react-query key for the history fetch. */
  historyQueryKey: unknown[];
  /** Combined with history length to force a runtime remount when the
   *  persisted thread changes underneath the panel (e.g. after a clear). */
  remountKey?: string;
  onFinish?: () => void;
  /** Per-page tool UI passthrough to <Thread/>. */
  components?: ThreadProps["components"];
  emptyState?: React.ReactNode;
  className?: string;
  /** Extra fields merged into every chat POST body (e.g. a live-updating
   *  "what the user currently sees" context string). Re-read on every render,
   *  so a caller can keep this current (via its own state/props) without
   *  forcing a runtime remount — see AssistantChatTransport's `body`, which
   *  AI SDK re-resolves on every message send rather than once at mount. */
  extraBody?: Record<string, unknown>;
}

function ChatPanelThread({
  api,
  initialMessages,
  onFinish,
  components,
  className,
  extraBody,
}: {
  api: string;
  initialMessages: UIMessage[];
  onFinish?: () => void;
  components?: ThreadProps["components"];
  className?: string;
  extraBody?: Record<string, unknown>;
}) {
  const runtime = useChatRuntime({
    messages: initialMessages,
    transport: new AssistantChatTransport({ api, body: extraBody }),
    onFinish,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <div className={className ?? "h-full min-h-0 flex flex-col text-[11px] [&_*]:text-[11px] [&_svg]:size-3.5 [&_.aui-composer-input]:text-[11px]"}>
          <div className="flex-1 min-h-0 flex flex-col">
            <Thread components={components} />
          </div>
          <TokenUsageFooter />
        </div>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

export function ChatPanel({ api, fetchHistory, historyQueryKey, remountKey, onFinish, components, emptyState, className, extraBody }: ChatPanelProps) {
  const { displaySettings } = useSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const aiConfigured = isAiConfigured(displaySettings);
  const { data: history, isSuccess } = useQuery({ queryKey: historyQueryKey, queryFn: fetchHistory });

  if (!aiConfigured) {
    return (
      emptyState ?? (
        <div className="pt-2 space-y-1.5">
          <p className="text-[11px] text-app-text-dim">Add an AI provider key to chat.</p>
          <button type="button" onClick={() => openSettings("ai")} className="w-full px-3 py-1.5 text-xs rounded bg-amber-500 hover:bg-amber-400 text-black font-medium">
            Set up AI
          </button>
        </div>
      )
    );
  }

  // Wait for the persisted-thread fetch before mounting the runtime — useChatRuntime
  // only reads `messages` on first render, so mounting before history resolves would
  // seed an empty thread and silently drop prior turns for the rest of the session.
  if (!isSuccess) {
    return <div className="h-full min-h-0 flex flex-col pt-2 gap-1.5 text-[11px] text-app-text-dim">Loading…</div>;
  }

  return (
    <ChatPanelThread
      key={`${remountKey ?? ""}:${history?.length ?? 0}`}
      api={api}
      initialMessages={history ?? []}
      onFinish={onFinish}
      components={components}
      className={className}
      extraBody={extraBody}
    />
  );
}
