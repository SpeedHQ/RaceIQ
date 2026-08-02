import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { runCodexCli } from "./providers";

export function messageContent(message: { content?: unknown; parts?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : [];
  const text = parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown; reasoning?: unknown };
      if (value.type === "text" || value.type === "reasoning") return typeof value.text === "string" ? value.text : typeof value.reasoning === "string" ? value.reasoning : "";
      return "";
    })
    .filter(Boolean)
    .join("");
  return text || (message.content == null ? "" : JSON.stringify(message.content));
}

export async function createCodexChatResponse(args: {
  systemPrompt: string;
  messages: Array<{ role: string; content?: unknown; parts?: unknown }>;
  model?: string;
  onAssistantResponse?: (text: string) => void | Promise<void>;
}): Promise<Response> {
  const prompt = [
    "SYSTEM:\n" + args.systemPrompt,
    ...args.messages.map((message) => `${message.role.toUpperCase()}:\n${messageContent(message)}`),
  ].join("\n\n");
  const result = await runCodexCli(prompt, args.model);
  await args.onAssistantResponse?.(result.analysis);
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
