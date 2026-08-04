import { describe, expect, test } from "bun:test";
import { prependChatTurnContext } from "../server/ai/chat-message-context";

describe("compare chat turn context", () => {
  test("keeps agent as sole system message and prepends context to latest user turn", () => {
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Earlier" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Answer" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "Why was lap B faster?" }] },
    ];

    const result = prependChatTurnContext(messages, "Comparison context");

    expect(result).toHaveLength(3);
    expect(result.some((message) => message.role === "system")).toBe(false);
    expect(result[2]).toEqual({
      id: "u2",
      role: "user",
      parts: [
        { type: "text", text: "Comparison context" },
        { type: "text", text: "Why was lap B faster?" },
      ],
    });
  });
});
