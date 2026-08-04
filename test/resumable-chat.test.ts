import { describe, expect, test } from "bun:test";
import { resolvedResumableThreadId } from "../client/src/components/ai-chat/resumable-chat";

describe("resumable chat selection", () => {
  test("does not resume cleared or finished threads", () => {
    expect(resolvedResumableThreadId("lap-5", undefined, true)).toBeUndefined();
    expect(resolvedResumableThreadId("lap-5", { status: "none" }, true)).toBeUndefined();
    expect(resolvedResumableThreadId("lap-5", { status: "finished", runId: "run-1" }, true)).toBeUndefined();
  });

  test("resumes only a confirmed active run", () => {
    expect(resolvedResumableThreadId("lap-5", { status: "active", runId: "run-1" }, true)).toBe("lap-5");
    expect(resolvedResumableThreadId("lap-5", { status: "active", runId: "run-1" }, false)).toBeUndefined();
  });
});
