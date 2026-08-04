export type ChatTurnMessage = {
  role?: string;
  parts?: unknown[];
  content?: unknown;
  [key: string]: unknown;
};

/**
 * Add dynamic turn context without introducing a second system message.
 * Agent instructions already become the provider's system message; local
 * OpenAI-compatible engines reject later system messages in the transcript.
 */
export function prependChatTurnContext<T extends ChatTurnMessage>(
  messages: readonly T[],
  context: string,
): T[] {
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  if (lastUserIndex < 0 || !context.trim()) return [...messages];

  return messages.map((message, index) => {
    if (index !== lastUserIndex) return message;

    if (Array.isArray(message.parts)) {
      return {
        ...message,
        parts: [{ type: "text", text: context }, ...message.parts],
      } as T;
    }

    if (typeof message.content === "string") {
      return {
        ...message,
        content: `${context}\n\n--- DRIVER MESSAGE ---\n${message.content}`,
      } as T;
    }

    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: [{ type: "text", text: context }, ...message.content],
      } as T;
    }

    return {
      ...message,
      content: context,
    } as T;
  });
}
