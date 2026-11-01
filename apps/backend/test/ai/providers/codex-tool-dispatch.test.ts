import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createCodexToolDispatcher } from "../../../src/ai/codex/tool-dispatch";
import { CodexRpcConnection } from "../../../src/ai/codex/rpc";

describe("Codex tool dispatch", () => {
  test("RPC forwards validated tool calls and reuses results across different request IDs", async () => {
    let peer!: ReadableStreamDefaultController<Uint8Array>;
    let notify!: () => void;
    const done = new Promise<void>((resolve) => { notify = resolve; });
    let executions = 0;
    const responses: Array<{ id: number; result: unknown }> = [];
    const dispatcher = createCodexToolDispatcher({ threadId: "t", turnId: () => "u", role: "engineer", tools: { apply_changes: { access: "engineer", input: z.object({ delta: z.number() }).strict(), execute: async () => { executions++; return "saved"; } } } });
    const connection = new CodexRpcConnection({
      stdout: new ReadableStream({ start(controller) { peer = controller; } }),
      write(line) { responses.push(JSON.parse(line)); if (responses.length === 2) notify(); },
      close() { peer.close(); },
    }, { onToolCall: dispatcher });
    const params = { threadId: "t", turnId: "u", callId: "call", tool: "apply_changes", arguments: { delta: 1 } };
    try {
      for (const id of [1, 2]) peer.enqueue(new TextEncoder().encode(JSON.stringify({ id, method: "item/tool/call", params }) + "\n"));
      await done;
      expect(executions).toBe(1);
      expect(responses.map((response) => response.result)).toEqual([
        { success: true, contentItems: [{ type: "inputText", text: "saved" }] },
        { success: true, contentItems: [{ type: "inputText", text: "saved" }] },
      ]);
    } finally { await connection.close(); }
  }, 2000);
  test("chat cannot execute experiment writes even if mistakenly registered", async () => {
    let writes = 0;
    const dispatcher = createCodexToolDispatcher({ threadId: "t", turnId: () => "u", role: "chat", tools: { update_notes: { access: "experiment", input: z.object({}), execute: async () => { writes++; return "done"; } } } });
    expect((await dispatcher({ threadId: "t", turnId: "u", callId: "1", tool: "update_notes", arguments: {} }, new AbortController().signal)).success).toBe(false);
    expect(writes).toBe(0);
  });
  test("binds turn, role and validated arguments; replays a call only once", async () => {
    let calls = 0;
    let finish!: (result: string) => void;
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    const dispatcher = createCodexToolDispatcher({
      threadId: "thread", turnId: () => "turn", role: "engineer",
      tools: {
        apply_changes: { access: "engineer", input: z.object({ value: z.number() }).strict(), execute: async () => { calls++; return pending; } },
        record_drill: { access: "coach", input: z.object({}), execute: async () => { throw new Error("forbidden"); } },
      },
    });
    const signal = new AbortController().signal;
    const call = { threadId: "thread", turnId: "turn", callId: "one", tool: "apply_changes", arguments: { value: 1 } };
    const first = dispatcher(call, signal);
    const duplicate = dispatcher(call, signal);
    expect(calls).toBe(1);
    expect((await dispatcher({ ...call, arguments: { value: 2 } }, signal)).success).toBe(false);
    for (const invalid of [
      { ...call, callId: "two", turnId: "foreign" },
      { ...call, callId: "two", threadId: "foreign" },
      { ...call, callId: "two", namespace: "shell" },
      { ...call, callId: "two", tool: "record_drill", arguments: {} },
      { ...call, callId: "two", tool: "unknown" },
      { ...call, callId: "two", arguments: { value: "wrong" } },
    ]) expect((await dispatcher(invalid, signal)).success).toBe(false);
    finish("Applied once");
    expect(await first).toEqual({ success: true, contentItems: [{ type: "inputText", text: "Applied once" }] });
    expect(await duplicate).toEqual(await first);
    expect(calls).toBe(1);
  });

  test("coach can record a drill but cannot call engineer tool; cancellation suppresses results", async () => {
    const controller = new AbortController();
    let finish!: (result: string) => void;
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    const tool = { input: z.object({}).strict(), execute: async () => pending };
    const dispatcher = createCodexToolDispatcher({ threadId: "t", turnId: () => "u", role: "coach", tools: { apply_changes: { ...tool, access: "engineer" }, record_drill: { ...tool, access: "coach" } } });
    const base = { threadId: "t", turnId: "u", callId: "c", arguments: {} };
    expect((await dispatcher({ ...base, tool: "apply_changes" }, controller.signal)).success).toBe(false);
    const result = dispatcher({ ...base, tool: "record_drill" }, controller.signal);
    controller.abort();
    finish("private");
    expect(await result).toEqual({ success: false, contentItems: [{ type: "inputText", text: "Tool request rejected or failed." }] });
  });
});
