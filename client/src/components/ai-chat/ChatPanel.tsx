import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import { AssistantChatTransport, createResumableSessionStorage, useChatRuntime, useThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import { contextWindowFor } from "@shared/integrations/ai/context-window";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { Maximize2, Minimize2, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Thread, type ThreadProps } from "@/components/assistant-ui/thread";
import { TooltipProvider } from "@/components/ui/tooltip";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useSettings } from "../../hooks/queries";
import { isAiConfigured } from "../../lib/is-ai-configured";
import { useUiStore } from "../../stores/ui";

import { resolvedResumableThreadId, type ChatRunStatus } from "./resumable-chat";
/**
 * (plan: migrate Lap Chat + Compare Chat onto the same modern streaming stack
 * as Setup Engineer chat). Renders via assistant-ui + the AI SDK v5
 * UI-message-stream protocol; the server route wraps a Mastra agent stream
 * with `streamAgentTurnResponse` (server/ai/agent-stream.ts) — assistant-ui's
 * `useChatRuntime` + `AssistantChatTransport` speak that protocol directly.
 *
 * Page-specific tool rendering stays out of this shared shell — pass a
 * `components` prop through to `<Thread/>` for per-page tool UI overrides.
 *
 * Chat generations: `compactThreadId` is always the BASE thread id for a
 * lineage (`lap-42`, `compare-3-7`, `tune-session-5`). A lineage can have
 * multiple generations (`<base>~g2`, `<base>~g3`, ...) created by forking
 * ("New chat" below) — only the newest is writable, older ones are a
 * read-only archive. `GET /api/chats/:threadId/generations` resolves the
 * active (newest) thread id and the full generation list for a base.
 */

// Rough $/1M tokens for a cost estimate (input, output). Chat models are cheap;
// this is a ballpark shown as "≈", not billing.

async function fetchChatRunStatus(threadId: string): Promise<ChatRunStatus> {
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(threadId)}/run`);
    if (!res.ok) return { status: "none" };
    return (await res.json()) as ChatRunStatus;
  } catch {
    return { status: "none" };
  }
}

interface ChatGeneration {
  threadId: string;
  generation: number;
  active: boolean;
}

interface ChatGenerationsResponse {
  activeThreadId: string;
  generations: ChatGeneration[];
}

async function fetchChatGenerations(base: string): Promise<ChatGenerationsResponse> {
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(base)}/generations`);
    if (!res.ok) return { activeThreadId: base, generations: [{ threadId: base, generation: 1, active: true }] };
    return (await res.json()) as ChatGenerationsResponse;
  } catch {
    return { activeThreadId: base, generations: [{ threadId: base, generation: 1, active: true }] };
  }
}

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
 * from the AI SDK stream's message metadata via useThreadTokenUsage; cost is a
 * rough client-side estimate from the configured chat provider's rates. Also
 * renders a context-window usage meter, a generation prev/next switcher, and
 * (when a base thread id is available) a "New chat" button that forks the
 * active generation into a fresh one seeded with a summary. */
function TokenUsageFooter({
  compactThreadId,
  historyQueryKey,
  compacting,
  setCompacting,
  generations,
  viewingGen,
  activeGen,
  onViewGen,
  onForked,
}: {
  compactThreadId?: string;
  historyQueryKey: unknown[];
  compacting: boolean;
  setCompacting: (v: boolean) => void;
  generations: ChatGeneration[];
  viewingGen: number;
  activeGen: number;
  onViewGen: (gen: number) => void;
  onForked: (newGen: number) => void;
}) {
  const usage = useThreadTokenUsage();
  const { displaySettings } = useSettings();
  const queryClient = useQueryClient();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [compactMsg, setCompactMsg] = useState<string | null>(null);

  const settings = displaySettings as { aiProvider?: string; aiModel?: string; chatProvider?: string; chatModel?: string };
  const provider = settings.chatProvider ?? settings.aiProvider ?? "gemini";
  const model = settings.chatModel ?? settings.aiModel ?? "";

  // For the local provider, ask the server for LM Studio's real per-model
  // context length (surfaced by /api/ai-models via LM Studio's native API).
  // Falls back to the static default when unavailable (Ollama, server down).
  const { data: localModels } = useQuery({
    queryKey: ["ai-models", "local-context"],
    queryFn: async () => {
      const res = await fetch("/api/ai-models?providers=local");
      if (!res.ok) throw new Error(`ai-models failed (${res.status})`);
      const body = (await res.json()) as { local?: { id: string; contextLength?: number }[] };
      return body.local ?? [];
    },
    enabled: provider === "local",
    staleTime: 60_000,
  });
  const localContext = provider === "local" ? (localModels?.find((m) => m.id === model) ?? (localModels?.length === 1 ? localModels[0] : undefined))?.contextLength : undefined;
  const limit = contextWindowFor(provider, model, localContext);

  // `inputTokens` is the full prompt size the provider billed for this turn —
  // for Gemini/OpenAI (the defaults) cached reads are already folded into it,
  // so we do NOT add `cachedInputTokens` (that would double-count). This is a
  // rough "how full is the window" indicator, not exact accounting.
  //
  // Before any billed usage exists (fresh thread, history persisted without
  // usage, or while the user is typing) fall back to a live client-side
  // estimate: all visible message text plus the composer draft, at ~4 chars
  // per token. Coarse, but it makes the meter move as you type.
  const estimatedTokens = useAuiState((s) => {
    let chars = s.composer.text.length;
    for (const m of s.thread.messages) {
      for (const part of m.content) {
        if (part.type === "text" || part.type === "reasoning") chars += part.text.length;
      }
    }
    return Math.ceil(chars / 4);
  });
  const used = usage?.inputTokens || estimatedTokens;
  const level = meterLevel(used, limit ?? 0);
  const barColor = level === "danger" ? "bg-status-danger" : level === "warn" ? "bg-ai-accent" : "bg-app-border";
  const pct = limit != null && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  const rate = RATE_PER_MTOK[provider] ?? RATE_PER_MTOK.gemini;
  const cost = ((usage?.inputTokens ?? 0) * rate.in + (usage?.outputTokens ?? 0) * rate.out) / 1_000_000;

  async function onNewChat() {
    if (!compactThreadId || compacting || isRunning) return;
    setCompacting(true);
    setCompactMsg(null);
    try {
      const res = await client.api.chats[":threadId"].compact.$post({ param: { threadId: compactThreadId } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setCompactMsg((body as { error?: string }).error ?? "Compact failed");
      } else {
        const body = (await res.json()) as { generation: number };
        await queryClient.invalidateQueries({ queryKey: ["chat-generations", compactThreadId] });
        await queryClient.invalidateQueries({ queryKey: historyQueryKey.slice(0, -1) });
        onForked(body.generation);
      }
    } catch {
      setCompactMsg("Compact failed");
    } finally {
      setCompacting(false);
      setTimeout(() => setCompactMsg(null), 4000);
    }
  }

  const maxGen = generations.length ? generations[generations.length - 1].generation : activeGen;
  const hasUsage = (usage?.totalTokens ?? 0) > 0;

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-app-border/40 px-2 py-1 text-app-micro text-app-text-muted tabular-nums">
      {/* Context meter */}
      <span className="flex items-center gap-1" title={level === "ok" ? undefined : "Context is filling up — consider starting a new chat"}>
        <span>
          {formatTokens(used)} / {limit != null ? formatTokens(limit) : "?"}
        </span>
        {limit != null && (
          <span className="inline-block h-1 w-10 rounded-full bg-app-border/30 overflow-hidden">
            <span className={`block h-full ${barColor}`} style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      {hasUsage && <span>{usage!.totalTokens} tok</span>}
      {hasUsage && usage!.inputTokens != null && <span>in {usage!.inputTokens}</span>}
      {hasUsage && usage!.outputTokens != null && <span>out {usage!.outputTokens}</span>}
      {hasUsage && (usage!.reasoningTokens ?? 0) > 0 && <span>think {usage!.reasoningTokens}</span>}
      {hasUsage && (usage!.cachedInputTokens ?? 0) > 0 && <span>cached {usage!.cachedInputTokens}</span>}
      {hasUsage && cost > 0 && <span>≈ ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}</span>}
      {maxGen > 1 && (
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onViewGen(Math.max(1, viewingGen - 1))}
            disabled={viewingGen <= 1}
            className="px-1 rounded border border-app-border/50 hover:bg-app-surface-hover/20 disabled:opacity-30"
            title="Previous chat generation"
          >
            ‹
          </button>
          <span>
            gen {viewingGen}/{maxGen}
          </span>
          <button
            type="button"
            onClick={() => onViewGen(Math.min(maxGen, viewingGen + 1))}
            disabled={viewingGen >= maxGen}
            className="px-1 rounded border border-app-border/50 hover:bg-app-surface-hover/20 disabled:opacity-30"
            title="Next chat generation"
          >
            ›
          </button>
        </span>
      )}
      {activeThreadId && isRunning && (
        <button
          type="button"
          onClick={() => {
            void fetch(`/api/chats/${encodeURIComponent(activeThreadId)}/run/cancel`, { method: "POST" });
          }}
          className="px-1.5 py-0.5 rounded border border-app-border/50 hover:bg-app-surface-hover/20"
          title="Stop the agent turn on the server (not just this view)"
        >
          Cancel
        </button>
      )}
      {compactThreadId && (
        <button
          type="button"
          onClick={onNewChat}
          disabled={compacting || isRunning}
          className="ml-auto px-1.5 py-0.5 rounded border border-app-border/50 hover:bg-app-surface-hover/20 disabled:opacity-40"
          title="Compact this chat into a summary and continue in a fresh chat (keeps this chat as read-only history)"
        >
          {compacting ? "Compacting…" : "Compact & New chat"}
        </button>
      )}
      {compactMsg && <span className="text-app-text-dim">{compactMsg}</span>}
    </div>
  );
}

export interface ChatPanelProps {
  /** Chat POST/stream endpoint, e.g. `/api/laps/${id}/chat`. */
  api: string;
  /** DELETE endpoint used by chat's Clear action. */
  clearChatApi?: string;
  /** Fetch persisted thread history as real AI SDK v5 UIMessage[]. Optional
   *  `gen` requests a specific (older) generation; omitted/undefined means
   *  "the active generation". */
  fetchHistory: (gen?: number) => Promise<UIMessage[]>;
  /** react-query key for the history fetch (generation is appended internally). */
  historyQueryKey: unknown[];
  /** Combined with history length to force a runtime remount when the
   *  persisted thread changes underneath the panel (e.g. after a clear). */
  remountKey?: string;
  onFinish?: () => void;
  /** Per-page tool UI passthrough to <Thread/>. */
  components?: ThreadProps["components"];
  /** Disable composing while the owning surface is not ready for chat. */
  inputDisabled?: boolean;
  emptyState?: React.ReactNode;
  className?: string;
  /** Extra fields merged into every chat POST body (e.g. a live-updating
   *  "what the user currently sees" context string). Re-read on every render,
   *  so a caller can keep this current (via its own state/props) without
   *  forcing a runtime remount — see AssistantChatTransport's `body`, which
   *  AI SDK re-resolves on every message send rather than once at mount. */
  extraBody?: Record<string, unknown>;
  /** Persisted BASE thread id (lineage id, generation-suffix stripped) — used
   *  to enable the footer's "New chat" button and generation switcher. */
  compactThreadId?: string;
}

function PendingPromptSubmit({ prompt, onSubmitted }: { prompt?: string; onSubmitted: () => void }) {
  const aui = useAui();
  useEffect(() => {
    if (!prompt) return;
    aui.thread().append({ role: "user", content: [{ type: "text", text: prompt }] });
    onSubmitted();
  }, [aui, onSubmitted, prompt]);
  return null;
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
  // Resumable wiring: survives client unmount/refresh by re-attaching to the
  // server-side detached run (server/ai/chat-run-registry.ts) instead of
  // aborting it. `resumeApi` ignores the AI SDK's own stream-id argument —
  // our registry is keyed by threadId, not per-stream id, and the reconnect
  // endpoint is the same replay-then-live-tail stream regardless — so this is
  // a no-op (no header ever set, storage never primed) for chat surfaces that
  // don't yet start detached runs (lap chat, compare chat).
  //
  // Keyed on `activeThreadId`, NOT the base `compactThreadId` — detached runs
  // register under the active generation's thread id server-side, so once a
  // lineage has been forked (base !== active), keying resume/cancel on the
  // base would silently stop finding the live run. Constructed fresh every
  // render like the plain transport below it (not memoized) — the AI SDK
  // re-resolves `body` per send, and `useChatRuntime`'s internal
  // `useDynamicChatTransport` already re-points at whichever transport
  // instance was passed on the latest render via a ref, so a fresh instance
  // per render is the existing, working pattern here.
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

  const runtime = useChatRuntime({
    messages: initialMessages,
    transport,
    onFinish,
  });
  const [compacting, setCompacting] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    const handler = (event: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(event.target as Node)) {
        setActionsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [actionsOpen]);
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [fullscreen]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        {fullscreen && <div className="fixed inset-0 z-[99] bg-app-bg/60" aria-hidden="true" />}
        <div
          role="dialog"
          aria-modal={fullscreen}
          aria-label="AI chat"
          className={
            fullscreen
              ? "fixed inset-2 sm:inset-4 z-[100] flex min-h-0 flex-col rounded-lg border border-app-border bg-app-bg shadow-2xl text-app-compact [&_*]:text-app-compact [&_svg]:size-3.5 [&_.aui-composer-input]:text-app-compact"
              : (className ?? "h-full min-h-0 flex flex-col text-app-compact [&_*]:text-app-compact [&_svg]:size-3.5 [&_.aui-composer-input]:text-app-compact")
          }
        >
          <div className="shrink-0 flex items-center justify-between gap-2 px-2 py-1 border-b border-app-border/40">
            <span className="text-app-text font-medium">{fullscreen ? "AI chat" : ""}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setFullscreen((open) => !open)}
                className="rounded border border-app-border/50 p-1 text-app-text-muted hover:bg-app-surface-hover/30 hover:text-app-text"
                title={fullscreen ? "Close full screen chat" : "Open full screen chat"}
                aria-label={fullscreen ? "Close full screen chat" : "Open full screen chat"}
              >
                {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </button>
              <div ref={actionsRef} className="relative">
                <button
                  type="button"
                  onClick={() => setActionsOpen((open) => !open)}
                  className="rounded border border-app-border/50 p-1 text-app-text-muted hover:bg-app-surface-hover/30 hover:text-app-text"
                  title="Chat actions"
                  aria-label="Chat actions"
                  aria-expanded={actionsOpen}
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
                {actionsOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 min-w-[150px] rounded-lg border border-app-border-input bg-app-surface py-1 shadow-xl">
                    <button
                      type="button"
                      className="w-full px-3 py-1.5 text-left text-app-compact text-app-text-secondary hover:bg-app-surface-hover hover:text-app-text"
                      onClick={async () => {
                        try {
                          const url = new URL(api, window.location.origin);
                          url.searchParams.set("export", "1");
                          if (viewingGen > 1) url.searchParams.set("gen", String(viewingGen));
                          const res = await fetch(url);
                          if (!res.ok) throw new Error("Could not load chat export");
                          const data = (await res.json()) as { messages?: unknown[] };
                          await navigator.clipboard.writeText(JSON.stringify({ messages: data.messages ?? [] }, null, 2));
                        } catch {
                          /* ignore */
                        }
                        setActionsOpen(false);
                      }}
                    >
                      Copy chat JSON
                    </button>
                    <button
                      type="button"
                      className="w-full px-3 py-1.5 text-left text-app-compact text-status-danger hover:bg-app-surface-hover hover:text-status-danger/80"
                      onClick={() => {
                        onClearChat();
                        setActionsOpen(false);
                      }}
                    >
                      Clear chat
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          {readOnly && (
            <div className="shrink-0 px-2 py-1 text-app-caption text-ai-accent bg-ai-accent/10 border-b border-ai-accent/30">Viewing an earlier chat (read-only). Switch to the latest to continue.</div>
          )}
          <div className="flex-1 min-h-0 flex flex-col">
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
        </div>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

export function ChatPanel({ api, clearChatApi, fetchHistory, historyQueryKey, remountKey, onFinish, components, emptyState, className, extraBody, compactThreadId, inputDisabled }: ChatPanelProps) {
  const { displaySettings } = useSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const aiConfigured = isAiConfigured(displaySettings);
  const queryClient = useQueryClient();
  const [clearVersion, setClearVersion] = useState(0);
  const [regenerateVersion, setRegenerateVersion] = useState(0);
  const [regeneratePrompt, setRegeneratePrompt] = useState<string>();
  const clearChat = async () => {
    try {
      await fetch(clearChatApi ?? api, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: historyQueryKey });
    } finally {
      setClearVersion((version) => version + 1);
    }
  };

  const { data: gensData } = useQuery({
    queryKey: ["chat-generations", compactThreadId],
    queryFn: () => fetchChatGenerations(compactThreadId!),
    enabled: !!compactThreadId,
    staleTime: 5_000,
  });
  const generations = gensData?.generations ?? (compactThreadId ? [{ threadId: compactThreadId, generation: 1, active: true }] : []);
  const activeGen = generations.length ? generations[generations.length - 1].generation : 1;
  const activeThreadId = gensData?.activeThreadId ?? compactThreadId;

  // Defaults to the active generation; explicit selection (switcher, or right
  // after a fork) overrides until cleared by a base-id change.
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

  // True live resume: on mount, ask the server whether a detached run is
  // still active for the ACTIVE thread (server/routes/chat-run-routes.ts) —
  // covers the case where the client's own sessionStorage-primed stream id
  // (set by AssistantChatTransport's `resumable` wiring on the original POST)
  // never got set, e.g. a different tab/session, or storage was cleared. When
  // active, prime the same sessionStorage slot ChatPanelThread's transport
  // reads on mount so `useChatRuntime`'s built-in resume effect (which only
  // fires when a stream id is already present) fires and tails the run live.
  // Must happen synchronously during THIS render, before ChatPanelThread
  // mounts below — child effects run before parent effects, so priming this
  // from an effect here would fire too late.
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
    if (!activeThreadId || !prompt || !window.confirm("Regenerate this response? Later messages will be removed.")) return;
    try {
      const res = await fetch(`/api/chats/${encodeURIComponent(activeThreadId)}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
      });
      const data = (await res.json().catch(() => null)) as { prompt?: string; error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "Could not regenerate chat");
      await queryClient.invalidateQueries({ queryKey: historyQueryKey });
      setRegeneratePrompt(data?.prompt ?? prompt);
      setRegenerateVersion((version) => version + 1);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not regenerate chat");
    }
  };

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

  // Wait for the persisted-thread fetch before mounting the runtime — useChatRuntime
  // only reads `messages` on first render, so mounting before history resolves would
  // seed an empty thread and silently drop prior turns for the rest of the session.
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
      resumableThreadId={resumableThreadId}
      onViewGen={(gen) => setViewingGen(gen)}
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
