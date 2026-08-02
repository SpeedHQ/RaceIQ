import { describe, expect, test } from "bun:test";
import {
  chatRuntimeKey,
  preserveRuntimeMessages,
  resolveGenerationView,
  type ChatGeneration,
  type GenerationViewSelection,
} from "../client/src/components/ai-chat/ChatPanel";

const generations: ChatGeneration[] = [
  { threadId: "tune-session-2", generation: 1, active: false },
  { threadId: "tune-session-2~g2", generation: 2, active: true },
];
const data = { activeThreadId: "tune-session-2~g2", generations };

const selection = (generation: number, baseThreadId = "tune-session-2"): GenerationViewSelection => ({ baseThreadId, generation });

describe("generation view state", () => {
  test("does not mount a writable runtime while lineage is unresolved", () => {
    expect(resolveGenerationView("tune-session-2", undefined, null, true)).toEqual({ ready: false });
  });

  test("active generation is writable", () => {
    expect(resolveGenerationView("tune-session-2", data, null)).toMatchObject({
      ready: true,
      activeGeneration: 2,
      activeThreadId: "tune-session-2~g2",
      viewingGeneration: 2,
      viewingThreadId: "tune-session-2~g2",
      readOnly: false,
    });
  });

  test("archived generation is read-only", () => {
    expect(resolveGenerationView("tune-session-2", data, selection(1))).toMatchObject({
      ready: true,
      viewingGeneration: 1,
      viewingThreadId: "tune-session-2",
      readOnly: true,
    });
  });

  test("ignores selection from another base and falls back on invalid generation", () => {
    expect(resolveGenerationView("tune-session-2", data, selection(1, "other")).viewingGeneration).toBe(2);
    expect(resolveGenerationView("tune-session-2", data, selection(9)).viewingGeneration).toBe(2);
  });
});

describe("chat runtime identity", () => {
  test("depends only on remount key and viewing thread", () => {
    expect(chatRuntimeKey("session:head", "tune-session-2")).toBe(chatRuntimeKey("session:head", "tune-session-2"));
    expect(chatRuntimeKey("session:head", "tune-session-2")).not.toBe(chatRuntimeKey("other-head", "tune-session-2"));
    expect(chatRuntimeKey("session:head", "tune-session-2")).not.toBe(chatRuntimeKey("session:head", "tune-session-2~g2"));
  });

});

describe("chat runtime messages", () => {
  test("background history refresh cannot replace a mounted live conversation", () => {
    const mounted = [{ id: "user-live", role: "user" as const, parts: [{ type: "text" as const, text: "Live prompt" }] }];
    const refreshed = [{ id: "assistant-stale", role: "assistant" as const, parts: [{ type: "text" as const, text: "Partial persisted reply" }] }];

    expect(preserveRuntimeMessages(undefined, mounted)).toBe(mounted);
    expect(preserveRuntimeMessages(mounted, refreshed)).toBe(mounted);
  });
});

