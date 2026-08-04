export type ChatTurnMessage = {
  role?: string;
  parts?: unknown[];
  content?: unknown;
};


export const CHAT_TURN_CONTEXT_KEY = "raceiq.chatTurnContext";

export function getChatTurnContext(requestContext?: { get: (key: string) => unknown }): string {
  if (!requestContext) return "";
  const value = requestContext.get(CHAT_TURN_CONTEXT_KEY);
  return typeof value === "string" ? value : "";
}

export function compareChatToolChoice(_messages: readonly Pick<ChatTurnMessage, "role">[]): "auto" {
  return "auto";
}

export function lapChatToolChoice(stepNumber: number): "auto" | "required" {
  return stepNumber === 0 ? "required" : "auto";
}

const GENERATED_CONTEXT_MARKER = /--- (?:LAPS UNDER COMPARISON|LAP CONTEXT|TELEMETRY DATA|CURRENT SETUP VALUES|SYMPTOM REPORT) ---/;

export function sanitizeChatHistoryMessages<T extends ChatTurnMessage>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    if (message.role !== "user") return message;

    if (Array.isArray(message.parts)) {
      const firstPart = message.parts[0] as { type?: string; text?: unknown } | undefined;
      if (firstPart?.type === "text" && typeof firstPart.text === "string" && GENERATED_CONTEXT_MARKER.test(firstPart.text)) {
        return { ...message, parts: message.parts.slice(1) } as T;
      }
    }

    if (typeof message.content === "string") {
      const driverMarker = "\n\n--- DRIVER MESSAGE ---\n";
      const markerIndex = message.content.indexOf(driverMarker);
      if (markerIndex >= 0) {
        return { ...message, content: message.content.slice(markerIndex + driverMarker.length) } as T;
      }
    }

    if (Array.isArray(message.content)) {
      const firstPart = message.content[0] as { type?: string; text?: unknown } | undefined;
      if (firstPart?.type === "text" && typeof firstPart.text === "string" && GENERATED_CONTEXT_MARKER.test(firstPart.text)) {
        return { ...message, content: message.content.slice(1) } as T;
      }
    }

    return message;
  });
}
