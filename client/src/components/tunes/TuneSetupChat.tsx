import { useQuery } from "@tanstack/react-query";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { UIMessage } from "ai";
import { useChatRuntime, AssistantChatTransport, useThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import { useSettings } from "../../hooks/queries";
import { useUiStore } from "../../stores/ui";
import { isAiConfigured } from "../../lib/is-ai-configured";
import { Thread } from "@/components/assistant-ui/thread";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * TuneSetupChat — the setup-scoped chat inside a tuning session (plan Phase D).
 *
 * Renders via assistant-ui + the AI SDK v5 UI-message-stream protocol. The
 * server route (`POST /api/tuning-sessions/:id/chat`) wraps a Mastra Setup
 * Engineer agent stream with `toAISdkStream`/`createUIMessageStreamResponse`
 * (server/routes/tune-routes.ts) — assistant-ui's `useChatRuntime` +
 * `AssistantChatTransport` speak that protocol directly, so no manual NDJSON
 * parsing or message-list state lives in this component anymore.
 *
 * Personalisation: the conversation itself is the feel input. The Setup
 * Engineer is a tool-using agent (docs/setup-engineer-tools-plan.md §3) — it
 * calls `get_current_setup`/`get_symptoms`/`get_version_history` for context,
 * `preview_change` while discussing options, and `apply_changes` once the
 * driver confirms. "Generate setup from this chat" just sends a confirmation
 * message into the same conversation; the agent decides to call
 * `apply_changes` itself and the server posts the applied-tweaks summary back
 * into this thread, so no separate generate endpoint or reload plumbing is
 * needed — the streamed reply already contains the outcome.
 */
/** Persisted thread history (server/routes/tune-routes.ts GET route) now comes
 *  back as real AI SDK v5 `UIMessage[]` — `{ id, role, parts, metadata }` —
 *  converted server-side from Mastra's stored DB messages via `MessageList`.
 *  Passed straight through (no flattening) so tool-invocation parts re-render
 *  as tool groups and `metadata.usage` re-populates the token footer on
 *  reload, same as a live turn. */
function useTuneChatHistory(sessionId: number) {
  return useQuery({
    queryKey: ["tuning-session-chat-history", sessionId],
    queryFn: async (): Promise<UIMessage[]> => {
      const res = await fetch(`/api/tuning-sessions/${sessionId}/chat`);
      if (!res.ok) return [];
      const data = (await res.json()) as { messages?: UIMessage[] };
      return (data.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant");
    },
  });
}

function TuneSetupChatThread({ sessionId, initialMessages }: { sessionId: number; initialMessages: UIMessage[] }) {
  const runtime = useChatRuntime({
    messages: initialMessages,
    transport: new AssistantChatTransport({ api: `/api/tuning-sessions/${sessionId}/chat` }),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        {/* The scaffolded assistant-ui Thread is sized for a full page; this
            panel is compact. Force a small font across the whole subtree — the
            descendant override beats the component's inline text-* utilities. */}
        <div className="h-full min-h-0 flex flex-col text-[11px] [&_*]:text-[11px] [&_svg]:size-3.5 [&_.aui-composer-input]:text-[11px]">
          <div className="flex-1 min-h-0 flex flex-col">
            <Thread />
          </div>
          <TokenUsageFooter />
        </div>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

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
      {cost > 0 && <span>≈ ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}</span>}
    </div>
  );
}

export function TuneSetupChat({
  sessionId,
}: {
  sessionId: number;
}) {
  const { displaySettings } = useSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const aiConfigured = isAiConfigured(displaySettings);
  const { data: history, isSuccess } = useTuneChatHistory(sessionId);

  if (!aiConfigured) {
    return (
      <div className="pt-2 space-y-1.5">
        <p className="text-[11px] text-app-text-dim">
          Add an AI provider key to discuss the setup before generating.
        </p>
        <button
          type="button"
          onClick={() => openSettings("ai")}
          className="w-full px-3 py-1.5 text-xs rounded bg-amber-500 hover:bg-amber-400 text-black font-medium"
        >
          Set up AI
        </button>
      </div>
    );
  }

  // Wait for the persisted-thread fetch before mounting the runtime — useChatRuntime
  // only reads `messages` on first render, so mounting before history resolves would
  // seed an empty thread and silently drop prior turns for the rest of the session.
  if (!isSuccess) {
    return (
      <div className="h-full min-h-0 flex flex-col pt-2 gap-1.5 text-[11px] text-app-text-dim">
        Loading…
      </div>
    );
  }

  return <TuneSetupChatThread key={sessionId} sessionId={sessionId} initialMessages={history ?? []} />;
}
