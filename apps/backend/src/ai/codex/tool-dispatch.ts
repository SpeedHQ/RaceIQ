import { z } from "zod";

const Call = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1).max(256),
  tool: z.string().min(1).max(128),
  namespace: z.string().nullish(),
  arguments: z.unknown(),
}).strict();

type ToolResult = { success: boolean; contentItems: Array<{ type: "inputText"; text: string }> };
type Tool = { access: "read" | "experiment" | "engineer" | "coach"; input: z.ZodType; execute(input: unknown, signal: AbortSignal): Promise<string> };
const failure = (): ToolResult => ({ success: false, contentItems: [{ type: "inputText", text: "Tool request rejected or failed." }] });

/** One instance per turn. Domain writes still require their own durable idempotency. */
export function createCodexToolDispatcher(options: {
  threadId: string;
  turnId: () => string | undefined;
  role: "chat" | "engineer" | "coach";
  tools: Readonly<Record<string, Tool>>;
}): (params: unknown, signal: AbortSignal) => Promise<ToolResult> {
  const calls = new Map<string, { fingerprint: string; result: Promise<ToolResult> }>();
  return async (params, signal) => {
    const parsed = Call.safeParse(params);
    if (!parsed.success || signal.aborted || !Object.hasOwn(params as object, "arguments")) return failure();
    const call = parsed.data;
    const currentTurn = options.turnId();
    if (call.threadId !== options.threadId || !currentTurn || call.turnId !== currentTurn || call.namespace != null) return failure();
    if ((call.tool === "apply_changes" && options.role !== "engineer") || (call.tool === "record_drill" && options.role !== "coach")) return failure();
    const tool = Object.hasOwn(options.tools, call.tool) ? options.tools[call.tool] : undefined;
    if (!tool) return failure();
    if ((options.role === "chat" && tool.access !== "read") || (tool.access === "engineer" && options.role !== "engineer") || (tool.access === "coach" && options.role !== "coach")) return failure();
    const input = tool.input.safeParse(call.arguments);
    if (!input.success) return failure();
    const fingerprint = JSON.stringify([call.tool, call.arguments]);
    const existing = calls.get(call.callId);
    if (existing) return existing.fingerprint === fingerprint ? existing.result : failure();
    if (calls.size >= 1024) return failure();
    const result = (async (): Promise<ToolResult> => {
      try {
        if (signal.aborted) return failure();
        const text = await tool.execute(input.data, signal);
        if (signal.aborted || typeof text !== "string" || Buffer.byteLength(text) > 512 * 1024) return failure();
        return { success: true, contentItems: [{ type: "inputText", text }] };
      } catch { return failure(); }
    })();
    calls.set(call.callId, { fingerprint, result });
    return result;
  };
}
