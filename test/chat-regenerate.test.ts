import { describe, expect, test } from "bun:test";
import { persistAssistantTurnToMemory, restoreOriginalUserMessage, stripThinkTags } from "../server/ai/agent-stream";
import { truncateChatAfterUserMessage } from "../server/ai/chat-agent";
import { chatsRoutes } from "../server/routes/chats-routes";
type Row = {
  id: string;
  role: "user" | "assistant";
  content: { content: string };
};

function makeMemory(messages: Row[]) {
  const deleted: string[][] = [];
  return {
    deleted,
    async recall() {
      return { messages };
    },
    async deleteMessages(ids: string[]) {
      deleted.push(ids);
    },
  };
}

describe("truncateChatAfterUserMessage", () => {
  test("retains selected prompt and deletes its response plus later turns", async () => {
    const messages: Row[] = [
      { id: "u1", role: "user", content: { content: "first" } },
      { id: "a1", role: "assistant", content: { content: "answer" } },
      { id: "u2", role: "user", content: { content: "retry me" } },
      { id: "a2", role: "assistant", content: { content: "stale" } },
      { id: "u3", role: "user", content: { content: "later" } },
    ];
    const memory = makeMemory(messages);

    const result = await truncateChatAfterUserMessage("thread", "u2", memory);
    expect((result.messages as Row[]).map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
    expect(result.prompt).toBe("retry me");
    expect(memory.deleted).toEqual([["a2", "u3"]]);
  });

  test("rejects missing and non-user message IDs", async () => {
    const messages: Row[] = [{ id: "a1", role: "assistant", content: { content: "answer" } }];
    const memory = makeMemory(messages);

    await expect(truncateChatAfterUserMessage("thread", "missing", memory)).rejects.toThrow("User message not found");
    await expect(truncateChatAfterUserMessage("thread", "a1", memory)).rejects.toThrow("User message not found");
    expect(memory.deleted).toEqual([]);
  });
});

describe("restoreOriginalUserMessage", () => {
  test("restores driver text when persistence assigns a different user ID", async () => {
    const saved: unknown[] = [];
    const memory = {
      async recall() {
        return {
          messages: [
            {
              id: "generated-user-id",
              role: "user",
              createdAt: new Date(2_000),
              content: {
                format: 2,
                parts: [{ type: "text", text: "Internal system context\n\nhi" }],
                content: "Internal system context\n\nhi",
              },
            },
          ],
        };
      },
      async saveMessages(input: { messages: unknown[] }) {
        saved.push(...input.messages);
      },
    };

    await restoreOriginalUserMessage(
      [{ id: "client-user-id", role: "user", parts: [{ type: "text", text: "hi" }] }],
      memory,
      "thread",
      1_000,
    );

    expect(saved).toHaveLength(1);
    expect((saved[0] as any).content.parts).toEqual([{ type: "text", text: "hi" }]);
    expect((saved[0] as any).content.content).toBe("hi");
  });
});

describe("persistAssistantTurnToMemory", () => {
  test("patches streamed reasoning onto the current assistant row", async () => {
    const saved: any[] = [];
    const memory = {
      async recall() {
        return {
          messages: [
            {
              id: "assistant-row",
              role: "assistant",
              createdAt: new Date(2_000),
              content: { format: 2, parts: [{ type: "text", text: "answer" }], content: "answer" },
            },
          ],
        };
      },
      async saveMessages(input: { messages: unknown[] }) {
        saved.push(...input.messages);
      },
    };

    await persistAssistantTurnToMemory(
      {
        id: "assistant-row",
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "tool-call", toolCallId: "call-1", toolName: "get_setup", args: { sessionId: 1 } },
          { type: "tool-result", toolCallId: "call-1", result: { ok: true } },
          { type: "text", text: "answer" },
        ],
      },
      memory,
      "thread",
      1_000,
      42,
      { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    );

    expect(saved[0].content.parts).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "tool-call", toolCallId: "call-1", toolName: "get_setup", args: { sessionId: 1 } },
      { type: "tool-result", toolCallId: "call-1", result: { ok: true } },
      { type: "text", text: "answer" },
    ]);
    expect(saved[0].content.metadata.usage.totalTokens).toBe(5);
    expect(saved[0].content.metadata.reasoning.durationMs).toBe(42);

  });
  test("skips persistence when clear chat aborted the detached turn", async () => {
    let recalled = false;
    const memory = {
      async recall() {
        recalled = true;
        return { messages: [] };
      },
      async saveMessages() {
        throw new Error("save should not run");
      },
    };
    const abortController = new AbortController();
    abortController.abort();

    await persistAssistantTurnToMemory(
      { id: "assistant-row", parts: [{ type: "text", text: "answer" }] },
      memory,
      "thread",
      1_000,
      0,
      undefined,
      abortController.signal,
    );

    expect(recalled).toBe(false);
  });
});

describe("visible chat text sanitization", () => {
  test("removes leaked reasoning tags without changing answer text", () => {
    expect(stripThinkTags("<think>private reasoning</think>Answer")).toBe("private reasoningAnswer");
    expect(stripThinkTags("Answer </think>")).toBe("Answer ");
  });
});

describe("POST /api/chats/:threadId/regenerate", () => {
  test("rejects requests without a message ID", async () => {
    const response = await chatsRoutes.request("/api/chats/thread/regenerate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });
});
