import { expect, test } from "bun:test";
import { reserveChatRun } from "@raceiq/backend-core/ai/chat-run-registry";
import { startDetachedCodexTurn } from "../../../src/ai/codex/chat-stream";
import { CodexRuntimeError } from "../../../src/ai/codex/runtime";

const result = {
  text: "Hello from Codex",
  model: "gpt-6-luna",
  runtimeVersion: "0.164.0",
  latencyMs: 1234,
  firstContentMs: 120,
  budget: { requestedOutputTokens: 32768, effectiveOutputTokens: null, supported: false },
  usage: { inputTokens: 40, cachedInputTokens: 10, outputTokens: 12, reasoningOutputTokens: 3, costUsd: null },
} as const;

function messages() {
  return [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Hi" }] }];
}

test("Codex detached stream persists user and assistant in canonical memory with nullable diagnostics", async () => {
  const writes: unknown[][] = [];
  const { run } = reserveChatRun(`codex-chat-${crypto.randomUUID()}`);
  const finished = new Promise<void>((resolve) => run.finishListeners.add(resolve));
  await startDetachedCodexTurn({
    run,
    originalMessages: messages(),
    memory: { saveMessages: async ({ messages: saved }) => { writes.push(saved); } },
    threadId: run.threadId,
    operation: "lap-chat.stream",
    generate: async (onTextDelta) => { onTextDelta("Hello "); onTextDelta("from Codex"); return result; },
  });
  await finished;
  expect(writes).toHaveLength(2);
  expect(writes[0]?.[0]).toMatchObject({ role: "user", id: "user-1", content: { content: "Hi" } });
  expect(writes[1]?.[0]).toMatchObject({
    role: "assistant",
    content: {
      content: "Hello from Codex",
      metadata: {
        usage: { inputTokens: 40, cachedInputTokens: 10, outputTokens: 12, totalTokens: 52, reasoningTokens: 3 },
        codex: { model: "gpt-6-luna", runtimeVersion: "0.164.0", latencyMs: 1234, budget: { effectiveOutputTokens: null, supported: false } },
      },
    },
  });
  expect(run.chunks.some((chunk) => chunk.type === "text-delta" && chunk.delta === "Hello ")).toBe(true);
  expect(run.chunks.some((chunk) => chunk.type === "finish")).toBe(true);
});

test("failed Codex generation preserves user input, omits assistant completion, and exposes usage-limit message", async () => {
  const writes: unknown[][] = [];
  const { run } = reserveChatRun(`codex-chat-${crypto.randomUUID()}`);
  const finished = new Promise<void>((resolve) => run.finishListeners.add(resolve));
  await startDetachedCodexTurn({
    run,
    originalMessages: messages(),
    memory: { saveMessages: async ({ messages: saved }) => { writes.push(saved); } },
    threadId: run.threadId,
    operation: "lap-chat.stream",
    generate: async () => { throw new CodexRuntimeError("usage-limit", "Codex usage limit reached. Check your ChatGPT usage and try again when usage is available."); },
  });
  await finished;
  expect(writes).toHaveLength(1);
  expect(run.chunks.some((chunk) => chunk.type === "error" && chunk.errorText.includes("Codex usage limit reached"))).toBe(true);
});
