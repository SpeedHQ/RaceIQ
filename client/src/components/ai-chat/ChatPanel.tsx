import { AssistantRuntimeProvider, useAuiState } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime, useThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import { contextWindowFor } from "@shared/ai/context-window";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { useState } from "react";
import { Thread, type ThreadProps } from "@/components/assistant-ui/thread";
import { TooltipProvider } from "@/components/ui/tooltip";
import { client } from "@/lib/rpc";
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

export function meterLevel(used: number, limit: number): "ok" | "warn" | "danger" {
  if (limit <= 0) return "ok";
  const frac = used / limit;
  if (frac >= 0.9) return "danger";
  if (frac >= 0.7) return "warn";
  return "ok";
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return String(n);
}

/** Tool/token/cost stats for the latest reply — assistant-ui reads token usage
 *  from the AI SDK stream's message metadata via useThreadTokenUsage; cost is a
 *  rough client-side estimate from the configured chat provider's rates. Also
 *  renders a context-window usage meter and, when a thread id is available, a
 *  Compact button that summarizes and replaces older messages server-side. */
function TokenUsageFooter({ compactThreadId, historyQueryKey }: { compactThreadId?: string; historyQueryKey: unknown[] }) {
  const usage = useThreadTokenUsage();
  const { displaySettings } = useSettings();
  const queryClient = useQueryClient();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [compacting, setCompacting] = useState(false);
  const [compactMsg, setCompactMsg] = useState<string | null>(null);

  const settings = displaySettings as { aiProvider?: string; aiModel?: string; chatProvider?: string; chatModel?: string };
  const provider = settings.chatProvider ?? settings.aiProvider ?? "gemini";
  const model = settings.chatModel ?? settings.aiModel ?? "";
  const limit = contextWindowFor(provider, model);

  const used = (usage?.inputTokens ?? 0) + (usage?.cachedInputTokens ?? 0);
  const level = meterLevel(used, limit);
  const barColor = level === "danger" ? "bg-red-500" : level === "warn" ? "bg-amber-500" : "bg-app-border";
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  const rate = RATE_PER_MTOK[provider] ?? RATE_PER_MTOK.gemini;
  const cost = ((usage?.inputTokens ?? 0) * rate.in + (usage?.outputTokens ?? 0) * rate.out) / 1_000_000;

  async function onCompact() {
    if (!compactThreadId || compacting || isRunning) return;
    setCompacting(true);
    setCompactMsg(null);
    try {
      const res = await client.api.chats[":threadId"].compact.$post({ param: { threadId: compactThreadId } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setCompactMsg((body as { error?: string }).error ?? "Compact failed");
      } else {
        const body = (await res.json()) as { before: number; after: number };
        setCompactMsg(`Compacted ${body.before}→${body.after}`);
        queryClient.invalidateQueries({ queryKey: historyQueryKey });
      }
    } catch {
      setCompactMsg("Compact failed");
    } finally {
      setCompacting(false);
      setTimeout(() => setCompactMsg(null), 4000);
    }
  }

  const hasUsage = (usage?.totalTokens ?? 0) > 0;

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-app-border/40 px-2 py-1 text-[9px] text-app-text-muted tabular-nums">
      {/* Context meter */}
      <span className="flex items-center gap-1" title={level === "ok" ? undefined : "Context is filling up — consider compacting"}>
        <span>
          {formatTokens(used)} / {formatTokens(limit)}
        </span>
        <span className="inline-block h-1 w-10 rounded-full bg-app-border/30 overflow-hidden">
          <span className={`block h-full ${barColor}`} style={{ width: `${pct}%` }} />
        </span>
      </span>
      {hasUsage && <span>{usage!.totalTokens} tok</span>}
      {hasUsage && usage!.inputTokens != null && <span>in {usage!.inputTokens}</span>}
      {hasUsage && usage!.outputTokens != null && <span>out {usage!.outputTokens}</span>}
      {hasUsage && (usage!.reasoningTokens ?? 0) > 0 && <span>think {usage!.reasoningTokens}</span>}
      {hasUsage && (usage!.cachedInputTokens ?? 0) > 0 && <span>cached {usage!.cachedInputTokens}</span>}
      {hasUsage && cost > 0 && <span>≈ ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}</span>}
      {compactThreadId && (
        <button
          type="button"
          onClick={onCompact}
          disabled={compacting || isRunning}
          className="ml-auto px-1.5 py-0.5 rounded border border-app-border/50 hover:bg-app-border/20 disabled:opacity-40"
          title="Summarize the conversation and replace old messages to free up context"
        >
          {compacting ? "Compacting…" : "Compact"}
        </button>
      )}
      {compactMsg && <span className="text-app-text-dim">{compactMsg}</span>}
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
  /** Persisted thread id to enable the footer's Compact button. */
  compactThreadId?: string;
}

function ChatPanelThread({
  api,
  initialMessages,
  onFinish,
  components,
  className,
  extraBody,
  compactThreadId,
  historyQueryKey,
}: {
  api: string;
  initialMessages: UIMessage[];
  onFinish?: () => void;
  components?: ThreadProps["components"];
  className?: string;
  extraBody?: Record<string, unknown>;
  compactThreadId?: string;
  historyQueryKey: unknown[];
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
          <TokenUsageFooter compactThreadId={compactThreadId} historyQueryKey={historyQueryKey} />
        </div>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

export function ChatPanel({ api, fetchHistory, historyQueryKey, remountKey, onFinish, components, emptyState, className, extraBody, compactThreadId }: ChatPanelProps) {
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
      compactThreadId={compactThreadId}
      historyQueryKey={historyQueryKey}
    />
  );
}
