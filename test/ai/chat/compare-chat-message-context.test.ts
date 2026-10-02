import { describe, expect, test } from "bun:test";
import {
  CHAT_TURN_CONTEXT_KEY,
  compareChatToolChoice,
  getChatTurnContext,
  sanitizeChatHistoryMessages,
} from "../../../server/ai/chat-message-context";

describe("compare chat turn context", () => {
  test("reads only server-set context from request context", () => {
    const requestContext = {
      get(key: string) {
        return key === CHAT_TURN_CONTEXT_KEY ? "server context" : "client override";
      },
    };

    expect(getChatTurnContext(requestContext)).toBe("server context");
    expect(getChatTurnContext()).toBe("");
  });

  test("removes identifiable generated context from legacy user history", () => {
    const messages = [
      {
        id: "u2",
        role: "user",
        parts: [
          { type: "text", text: "Internal instructions\n--- LAPS UNDER COMPARISON ---\nLap A..." },
          { type: "text", text: "braking zone" },
        ],
      },
    ];

    expect(sanitizeChatHistoryMessages(messages)).toEqual([
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "braking zone" }],
      },
    ]);
  });

  test("always lets the model choose whether to call tools", () => {
    expect(compareChatToolChoice([{ role: "user" }])).toBe("auto");
    expect(compareChatToolChoice([{ role: "user" }, { role: "assistant" }])).toBe("auto");
  });
});
