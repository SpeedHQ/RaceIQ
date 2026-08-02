import { describe, expect, test } from "bun:test";
import { chatHistoryUrl, clearChatHistory, fetchChatHistory, parseChatHistoryResponse } from "../client/src/lib/chat-history";

describe("chat history", () => {
  test("includes generation 1 when explicitly requested", () => {
    expect(chatHistoryUrl("/api/experiments/2/chat", 1)).toBe("/api/experiments/2/chat?gen=1");
    expect(chatHistoryUrl("/api/chat?x=1", 2)).toBe("/api/chat?x=1&gen=2");
    expect(chatHistoryUrl("/api/chat")).toBe("/api/chat");
  });

  test("preserves accepted AI SDK messages and parts", () => {
    const assistant: UIMessage = {
      id: "a1",
      role: "assistant",
      metadata: { finishReason: "stop" },
      parts: [{ type: "text", text: "Compacted summary" }],
    };
    const user: UIMessage = {
      id: "u1",
      role: "user",
      metadata: { source: "driver" },
      parts: [{ type: "text", text: "Next question" }],
    };
    expect(parseChatHistoryResponse({ messages: [assistant, { role: "system" }, user] })).toEqual([assistant, user]);
  });

  test("rejects malformed responses and non-2xx responses", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ nope: [] }), { status: 200 }), {
        preconnect: originalFetch.preconnect,
      });
      await expect(fetchChatHistory("/api/chat")).rejects.toThrow("Invalid chat history response");
      globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ messages: [] }), { status: 500 }), {
        preconnect: originalFetch.preconnect,
      });
      await expect(fetchChatHistory("/api/chat")).rejects.toThrow("Chat history failed (500)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("clears chat through DELETE and rejects failures", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("DELETE");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }, { preconnect: originalFetch.preconnect });
      await expect(clearChatHistory("/api/experiments/2/chat")).resolves.toBeUndefined();

      globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 }), {
        preconnect: originalFetch.preconnect,
      });
      await expect(clearChatHistory("/api/experiments/2/chat")).rejects.toThrow("Clear chat failed (500)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
