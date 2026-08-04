# Chat Regenerate Design

## Goal
Allow users to regenerate a response from any persisted user prompt while removing that prompt's previous response and every later message.

## Behavior
- A past user message exposes `Regenerate` alongside existing `Edit`.
- Regenerate targets the selected user message by persisted message ID.
- Confirmation is required because persisted later turns are destructive.
- On confirmation, the server deletes the selected user message's existing response and all later messages, while retaining the selected user prompt and all earlier messages.
- The client remounts from the truncated history, then submits the retained prompt through the existing chat transport.
- Active generations remain active; archived generations remain read-only.
- Running chats disable regeneration. Failed truncation leaves current UI/history unchanged and reports an error.

## Architecture
Add a chat-memory helper that recalls the full thread, identifies the selected user message, and deletes all messages after it. Add a route per chat surface's existing POST endpoint using a shared regenerate path or shared helper. Extend the assistant-ui user action bar with a callback supplied by `ChatPanel`; the panel performs confirmation, calls the endpoint, invalidates history, remounts, and resubmits the selected text.

## Testing
Server tests cover retaining prefix plus selected user message, deleting response/later messages, rejecting unknown/non-user IDs, and preserving order. Client tests cover action availability and the regenerate request/refresh/resubmit sequence where existing component test infrastructure permits.
