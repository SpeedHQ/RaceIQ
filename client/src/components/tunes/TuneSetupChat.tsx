import { ChatPanel } from "@/components/ai-chat/ChatPanel";
import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";

/**
 * TuneSetupChat — the setup-scoped chat inside a tuning session (plan Phase D).
 *
 * Thin wrapper around the shared `ChatPanel` — keeps only what's specific to
 * this surface: the persisted-history fetch and the version-tree/test-list
 * cache invalidation on `onFinish` (a turn may have applied a change or
 * branched a version server-side inside apply_changes/branch_from_version).
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
async function fetchTuneChatHistory(sessionId: number): Promise<UIMessage[]> {
  const res = await fetch(`/api/tuning-sessions/${sessionId}/chat`);
  if (!res.ok) return [];
  const data = (await res.json()) as { messages?: UIMessage[] };
  return (data.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant");
}

export function TuneSetupChat({
  sessionId,
  headTestId,
}: {
  sessionId: number;
  headTestId: number | null;
}) {
  const queryClient = useQueryClient();

  return (
    <ChatPanel
      api={`/api/tuning-sessions/${sessionId}/chat`}
      fetchHistory={() => fetchTuneChatHistory(sessionId)}
      historyQueryKey={["tuning-session-chat-history", sessionId]}
      remountKey={`${sessionId}:${headTestId ?? "none"}`}
      onFinish={() => {
        queryClient.invalidateQueries({ queryKey: ["tuning-session-tests", sessionId] });
        queryClient.invalidateQueries({ queryKey: ["tuning-session", sessionId] });
      }}
    />
  );
}
