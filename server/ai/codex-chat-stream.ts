import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { runCodexCli } from "./providers";

export async function createCodexChatResponse(args: {
  systemPrompt: string;
  messages: Array<{ role: string; content: unknown }>;
  model?: string;
}): Promise<Response> {
  const prompt = [
    "SYSTEM:\n" + args.systemPrompt,
    ...args.messages.map((message) => `${message.role.toUpperCase()}:\n${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`),
  ].join("\n\n");
  const result = await runCodexCli(prompt, args.model);
  const messageId = crypto.randomUUID();
  const textId = crypto.randomUUID();
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const write = (chunk: UIMessageChunk) => writer.write(chunk);
      write({ type: "start", messageId });
      write({ type: "text-start", id: textId });
      write({ type: "text-delta", id: textId, delta: result.analysis });
      write({ type: "text-end", id: textId });
      write({ type: "finish", finishReason: "stop" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}
