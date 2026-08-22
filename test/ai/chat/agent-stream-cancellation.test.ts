import { describe, expect, test } from "bun:test";

import {
  persistAssistantTurnToMemory,
  streamAgentTurnResponse,
  type StreamAgentTurnOptions,
} from "../../../server/ai/agent-stream";

type Surface = "lap" | "comparison";

type Memory = StreamAgentTurnOptions["memory"] & {
  saved: unknown[];
};

function makeMemory(): Memory {
  const saved: unknown[] = [];
  return {
    saved,
    recall: async () => ({ messages: [] }),
    saveMessages: async ({ messages }) => {
      saved.push(...messages);
    },
  };
}

function makeAbortableAgentStream(
  signal: AbortSignal,
  onStarted: () => void,
): StreamAgentTurnOptions["agentStream"] {
  let resolveAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  signal.addEventListener("abort", () => resolveAbort?.(), { once: true });
  const stream = new ReadableStream({
    async start(controller) {
      onStarted();
      controller.enqueue({ type: "text-start", payload: { id: "assistant" } });
      controller.enqueue({ type: "text-delta", payload: { id: "assistant", text: "buffered output" } });
      if (!signal.aborted) await aborted;
      controller.close();
    },
  });
  return stream as unknown as StreamAgentTurnOptions["agentStream"];
}

describe("chat stream cancellation", () => {
  for (const surface of ["lap", "comparison"] as const satisfies readonly Surface[]) {
    test(`${surface} chat abort does not publish fenced output or persist memory`, async () => {
      const controller = new AbortController();
      const memory = makeMemory();
      let resolveStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      const response = streamAgentTurnResponse({
        agentStream: makeAbortableAgentStream(controller.signal, () => resolveStarted?.()),
        originalMessages: [],
        memory,
        threadId: `${surface}-thread`,
        turnStartedAt: Date.now(),
        validateReceiptFence: async () => {
          throw new Error("receipt fence must not run after cancellation");
        },
        abortSignal: controller.signal,
      });

      const body = response.body;
      if (!body) throw new Error("Expected chat stream body");
      const read = body.getReader();
      const firstRead = read.read();
      await started;
      controller.abort();
      const result = await firstRead;
      const output = result.done ? "" : new TextDecoder().decode(result.value);
      await read.cancel();

      expect(output).not.toContain("buffered output");
      expect(memory.saved).toHaveLength(0);
    });
    test(`${surface} chat abort skips assistant persistence after recall`, async () => {
      const controller = new AbortController();
      const memory = makeMemory();
      memory.recall = async () => {
        controller.abort();
        return {
          messages: [{
            role: "assistant",
            id: "assistant",
            content: {},
          }],
        };
      };

      await persistAssistantTurnToMemory(
        {
          id: "assistant",
          parts: [{ type: "text", text: "should not persist" }],
        },
        memory,
        `${surface}-thread`,
        Date.now(),
        0,
        undefined,
        controller.signal,
      );

      expect(memory.saved).toHaveLength(0);
    });
  }
});
