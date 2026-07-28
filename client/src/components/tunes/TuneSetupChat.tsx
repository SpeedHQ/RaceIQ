import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { ChatPanel } from "@/components/ai-chat/ChatPanel";

/**
 * TuneSetupChat — the setup-scoped chat inside an experiment (plan Phase D).
 *
 * Thin wrapper around the shared `ChatPanel` — keeps only what's specific to
 * this surface: the persisted-history fetch and the version-tree/test-list
 * cache invalidation on `onFinish` (a turn may have applied a change or
 * branched a version server-side inside apply_changes/branch_from_version).
 *
 * Personalisation: the conversation itself is the feel input. The Setup
 * Engineer is a tool-using agent (docs/setup-engineer-tools-plan.md §3) — it
 * calls `get_setup`/`get_symptoms`/`get_version_history` for context,
 * `preview_change` while discussing options, and `apply_changes` once the
 * driver confirms. "Generate setup from this chat" just sends a confirmation
 * message into the same conversation; the agent decides to call
 * `apply_changes` itself and the server posts the applied-tweaks summary back
 * into this thread, so no separate generate endpoint or reload plumbing is
 * needed — the streamed reply already contains the outcome.
 */
async function fetchTuneChatHistory(sessionId: number, gen?: number): Promise<UIMessage[]> {
  const url = gen && gen > 1 ? `/api/experiments/${sessionId}/chat?gen=${gen}` : `/api/experiments/${sessionId}/chat`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as { messages?: UIMessage[] };
  const msgs = (data.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant");

  // Keep reasoning in history (thinking survives refresh) but dedupe it.
  // Mastra's read-merge can re-attach a turn's reasoning — often as a
  // concatenation of that turn's blocks — onto a later persisted branch-note
  // message, double-showing the thinking. So drop any reasoning part whose
  // text is composed entirely of reasoning already emitted earlier in the
  // thread; genuine first-time reasoning is preserved.
  const seen: string[] = [];
  return msgs.map((m) => {
    if (!m.parts) return m;
    const parts = m.parts.filter((p) => {
      if (p.type !== "reasoning") return true;
      const text = (p as { text?: string }).text ?? "";
      let residual = text;
      for (const s of seen) if (s) residual = residual.split(s).join("");
      if (seen.length && residual.trim() === "") return false; // pure echo/concat of prior reasoning
      seen.push(text);
      return true;
    });
    return { ...m, parts };
  });
}

export function TuneSetupChat({
  sessionId,
  headVersionId,
  extendedContext,
}: {
  sessionId: number;
  headVersionId: number | null;
  /** Compact text summary of whatever lap review is currently open in the
   *  Review Laps dashboard next to this chat (see TuneReviewDashboard's
   *  `onOpenLapContextChange`) — re-read on every message send, so switching
   *  the focused lap updates what the agent sees without needing a new chat
   *  turn or a runtime remount. Omitted/undefined when no review is open. */
  extendedContext?: string | null;
}) {
  const queryClient = useQueryClient();

  return (
    <ChatPanel
      api={`/api/experiments/${sessionId}/chat`}
      fetchHistory={(gen) => fetchTuneChatHistory(sessionId, gen)}
      historyQueryKey={["experiment-chat-history", sessionId]}
      remountKey={`${sessionId}:${headVersionId ?? "none"}`}
      compactThreadId={`tune-session-${sessionId}`}
      extraBody={extendedContext ? { extendedContext } : undefined}
      onFinish={() => {
        queryClient.invalidateQueries({ queryKey: ["experiment-tests", sessionId] });
        queryClient.invalidateQueries({ queryKey: ["experiment", sessionId] });
        // A branching turn changes headVersionId, which is part of ChatPanel's
        // remount key — the runtime remounts and reseeds from persisted
        // history. Refetch that history too, or the remount reseeds from the
        // STALE cache (missing this turn + the server-posted branch notes) and
        // the thread appears to vanish until a manual refresh.
        queryClient.invalidateQueries({ queryKey: ["experiment-chat-history", sessionId] });
      }}
    />
  );
}
