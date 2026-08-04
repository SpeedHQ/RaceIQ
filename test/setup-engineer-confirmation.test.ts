import { describe, expect, test } from "bun:test";
import { hasExplicitChangeConfirmation } from "../server/ai/chat-message-context";

type Change = { component: string; direction: "increase" | "decrease"; magnitude: "small" | "medium" | "large" };

const change: Change = { component: "Front Wing", direction: "increase", magnitude: "medium" };

function textMessage(role: "user" | "assistant", text: string) {
  return { role, parts: [{ type: "text", text }] };
}

describe("setup engineer change confirmation", () => {
  test("does not treat a new change request as confirmation in same turn", () => {
    const messages = [
      textMessage("assistant", "Should I create a version with Front Wing decreased by medium?"),
      textMessage("user", "I want you to increase the front downforce"),
    ];

    expect(hasExplicitChangeConfirmation(messages, change)).toBe(false);
  });

  test("requires an explicit confirmation after a matching proposal", () => {
    const messages = [
      textMessage("assistant", "Preview: Front Wing increase medium, 4 → 6. Should I apply it?"),
      textMessage("user", "Yes, apply that change."),
    ];

    expect(hasExplicitChangeConfirmation(messages, change)).toBe(true);
  });
});
