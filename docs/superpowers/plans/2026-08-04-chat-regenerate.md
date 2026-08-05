# Chat Regenerate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regenerate any persisted user prompt by deleting its prior response and all later messages, then resubmitting that prompt.

**Architecture:** Add a tested server helper using Mastra Memory `recall()` and `deleteMessages()` to retain the prefix through the selected user message. Expose it through a generic `/api/chats/:threadId/regenerate` route. Extend the shared assistant-ui thread action bar and ChatPanel lifecycle so the client confirms, truncates, refreshes/remounts, and appends the same prompt through the existing transport.

**Tech Stack:** Bun, Hono, TypeScript, Mastra Memory, React, assistant-ui, TanStack Query, Bun test.

## Global Constraints

- Selected message must be a persisted user message ID.
- Selected prompt and all earlier messages remain; selected response and every later message are deleted.
- Archived generations remain read-only.
- Running threads disable regenerate.
- Truncation failure leaves current UI/history unchanged.

---

### Task 1: Add tested thread truncation helper

**Files:**
- Modify: `server/ai/chat-agent.ts`
- Create: `test/chat-regenerate.test.ts`

**Interfaces:**
- Produces `truncateChatAfterUserMessage(threadId: string, messageId: string, mem?: ChatMemory): Promise<{ messages: unknown[]; prompt: string }>`.

- [ ] Write failing tests for retaining prefix and selected user message, deleting later IDs, rejecting missing IDs, and rejecting assistant IDs.
- [ ] Run `bun test test/chat-regenerate.test.ts --timeout 30000`; expect failure because helper is absent.
- [ ] Implement helper with `recall({ threadId, perPage: false })`, locate selected user row, call `deleteMessages()` with rows after selected, and return retained rows plus selected text.
- [ ] Run focused test and verify pass.

### Task 2: Add regenerate API route

**Files:**
- Modify: `server/routes/chats-routes.ts`
- Modify: `test/chat-regenerate.test.ts`

**Interfaces:**
- `POST /api/chats/:threadId/regenerate` accepts `{ messageId }` and returns `{ ok: true, prompt }`; invalid IDs return 400/404; memory errors return 500.

- [ ] Add route test for valid request and invalid selection.
- [ ] Run focused route tests and verify red before implementation.
- [ ] Register route using existing shared `getChatMemory()` and `truncateChatAfterUserMessage()`.
- [ ] Run focused route tests and verify pass.

### Task 3: Add user regenerate action to assistant-ui thread

**Files:**
- Modify: `client/src/components/assistant-ui/thread.tsx`
- Modify: `client/src/components/ai-chat/ChatPanel.tsx`

**Interfaces:**
- `ThreadProps.onRegenerate?: (messageId: string, prompt: string) => void`.
- `ChatPanelThread` receives `onRegenerate` and `regeneratePrompt?: string`.

- [ ] Add a component-level test or existing UI test fixture proving user action emits ID and text; verify it fails before implementation.
- [ ] Add callback context/prop, extract text parts from current user message state, and render `Regenerate` beside `Edit` only when callback exists.
- [ ] Disable action while thread is running/read-only.
- [ ] Run client typecheck/test target and verify pass.

### Task 4: Wire truncate-refresh-resubmit lifecycle

**Files:**
- Modify: `client/src/components/ai-chat/ChatPanel.tsx`
- Modify: `client/src/components/assistant-ui/thread.tsx`

**Interfaces:**
- On confirmed action, POST to `/api/chats/${activeThreadId}/regenerate`, invalidate history query, increment remount key, then append `{ role: "user", content: [{ type: "text", text: prompt }] }` once after the remounted runtime is ready.

- [ ] Add focused test for request payload and one-time resubmit behavior; verify red.
- [ ] Implement confirmation, error handling, pending prompt state, remount, and `aui.thread().append` effect.
- [ ] Run focused test and client validation.

### Task 5: Final verification

**Files:**
- No new files.

- [ ] Run `bun test test/chat-regenerate.test.ts --timeout 30000`.
- [ ] Run `bun run build` or the repository's client typecheck/build command.
- [ ] Exercise the chat UI: select past prompt, confirm regenerate, observe later turns disappear, and verify new streamed response appears.
