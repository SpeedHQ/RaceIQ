import type { UIMessage } from "ai";

export function chatHistoryUrl(api: string, generation?: number): string {
  if (generation === undefined) return api;
  const separator = api.includes("?") ? "&" : "?";
  return `${api}${separator}gen=${generation}`;
}

export function parseChatHistoryResponse(value: unknown): UIMessage[] {
  if (!value || typeof value !== "object" || !("messages" in value) || !Array.isArray(value.messages)) {
    throw new Error("Invalid chat history response");
  }
  return value.messages.filter((message): message is UIMessage => {
    if (!message || typeof message !== "object" || !("role" in message)) return false;
    return message.role === "user" || message.role === "assistant";
  });
}

export async function fetchChatHistory(api: string, generation?: number): Promise<UIMessage[]> {
  const response = await fetch(chatHistoryUrl(api, generation));
  if (!response.ok) throw new Error(`Chat history failed (${response.status})`);
  return parseChatHistoryResponse(await response.json());
}

export async function clearChatHistory(api: string): Promise<void> {
  const response = await fetch(api, { method: "DELETE" });
  if (!response.ok) throw new Error(`Clear chat failed (${response.status})`);
}
