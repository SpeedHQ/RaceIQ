import { describe, expect, test } from "bun:test";
import {
  CHAT_TURN_CONTEXT_KEY,
  FINDING_RECEIPT_FENCE_CONTEXT_KEY,
  compareChatToolChoice,
  getChatTurnContext,
  getFindingReceiptFence,
  sanitizeChatHistoryMessages,
  type FindingReceiptFence,
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

  test("reads receipt fence bound to server request context", () => {
    const fence: FindingReceiptFence = {
      kind: "comparison",
      gameId: "acc",
      cacheKey: "sha256:comparison",
      laps: [
        { lapId: 11, generationId: "gen-a", contentHash: "sha256:a" },
        { lapId: 12, generationId: "gen-b", contentHash: "sha256:b" },
      ],
    };
    const requestContext = {
      get(key: string) {
        return key === FINDING_RECEIPT_FENCE_CONTEXT_KEY ? fence : undefined;
      },
    };
    expect(getFindingReceiptFence(requestContext)).toEqual(fence);
    expect(getFindingReceiptFence({ get: () => ({ ...fence, cacheKey: "" }) }) === undefined).toBe(true);
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
