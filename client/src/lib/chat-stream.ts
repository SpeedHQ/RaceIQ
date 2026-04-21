/**
 * NDJSON parser for the chat streaming protocol emitted by
 * `server/ai/chat-stream.ts`.
 *
 * Usage:
 *   const res = await fetch(...);
 *   await readChatStream(res, (event) => { ... });
 */

export type ChatStreamEvent =
  | { type: "status"; state: "thinking" | "generating" }
  | { type: "tool"; state: "start" | "end"; name: string }
  | { type: "text"; delta: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number; durationMs?: number; model?: string; toolCalls?: number }
  | { type: "ping" }
  | { type: "error"; message: string }
  | { type: "done" }
  // Open-ended tail so analyse-specific events ("meta", "result") and any
  // future additions flow through without needing to widen the union here.
  | { type: string; [key: string]: unknown };

export async function readChatStream(
  res: Response,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buf = "";
  // Stream the body, split on \n, parse each complete line as a JSON event.
  // Partial lines buffer until the next read resolves them.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as ChatStreamEvent);
      } catch {
        // Skip malformed lines — protocol is best-effort; keep the reader
        // alive so later well-formed events still arrive.
      }
    }
  }
  // Flush any trailing line (no \n) — rare, usually the `done` already fired.
  const tail = buf.trim();
  if (tail) {
    try { onEvent(JSON.parse(tail) as ChatStreamEvent); } catch { /* ignore */ }
  }
}
