import { GameIdSchema, type GameId } from "../../shared/games/ids";

export type ChatTurnMessage = {
  role?: string;
  parts?: unknown[];
  content?: unknown;
};

export const CHAT_TURN_CONTEXT_KEY = "raceiq.chatTurnContext";
export const CHAT_TURN_MESSAGES_KEY = "raceiq.chatTurnMessages";
export const FINDING_RECEIPT_FENCE_CONTEXT_KEY = "raceiq.findingReceiptFence";

export type FindingReceiptFence = {
  kind: "lap" | "comparison";
  gameId: GameId;
  cacheKey: string;
  laps: readonly {
    lapId: number;
    generationId: string;
    contentHash: string;
  }[];
};

export function getChatTurnContext(requestContext?: { get: (key: string) => unknown }): string {
  if (!requestContext) return "";
  const value = requestContext.get(CHAT_TURN_CONTEXT_KEY);
  return typeof value === "string" ? value : "";
}

export function getFindingReceiptFence(requestContext?: { get: (key: string) => unknown }): FindingReceiptFence | undefined {
  const value = requestContext?.get(FINDING_RECEIPT_FENCE_CONTEXT_KEY);
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { kind?: unknown; gameId?: unknown; cacheKey?: unknown; laps?: unknown };
  if (
    (candidate.kind !== "lap" && candidate.kind !== "comparison") ||
    typeof candidate.cacheKey !== "string" ||
    candidate.cacheKey.length === 0 ||
    !Array.isArray(candidate.laps) ||
    candidate.laps.length < 1
  ) return undefined;
  const gameId = GameIdSchema.safeParse(candidate.gameId);
  if (!gameId.success) return undefined;
  const laps = candidate.laps.filter((lap: unknown): lap is { lapId: number; generationId: string; contentHash: string } => {
    if (!lap || typeof lap !== "object") return false;
    const record = lap as Record<string, unknown>;
    return Number.isSafeInteger(record.lapId) && typeof record.generationId === "string" && typeof record.contentHash === "string";
  });
  const kind = candidate.kind === "lap" ? "lap" : "comparison";
  return laps.length === candidate.laps.length
    ? { kind, gameId: gameId.data, cacheKey: candidate.cacheKey, laps }
    : undefined;
}
export type ConfirmableChange = {
  component: string;
  direction: "increase" | "decrease";
  magnitude: "small" | "medium" | "large";
};

function messageText(message: ChatTurnMessage): string {
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part) => (part as { type?: string; text?: unknown })?.type === "text" ? String((part as { text?: unknown }).text ?? "") : "")
      .join(" ");
  }
  return typeof message.content === "string" ? message.content : "";
}

/** Require a later user approval of a matching assistant proposal. */
export function hasExplicitChangeConfirmation(messages: readonly ChatTurnMessage[], change: ConfirmableChange): boolean {
  const current = [...messages].reverse().find((message) => message.role === "user");
  if (!current) return false;
  const currentText = messageText(current).trim().toLowerCase();
  if (!/^(?:yes|yeah|yep|ok(?:ay)?|apply|go ahead|do it|let['’]?s try|change it|confirm(?:ed)?)\b/.test(currentText)) return false;

  const currentIndex = messages.lastIndexOf(current);
  const proposal = [...messages.slice(0, currentIndex)].reverse().find((message) => message.role === "assistant");
  if (!proposal) return false;
  const proposalText = messageText(proposal).toLowerCase();
  return proposalText.includes(change.component.toLowerCase()) && proposalText.includes(`${change.direction.slice(0, -1)}`);
}


export function compareChatToolChoice(_messages: readonly Pick<ChatTurnMessage, "role">[]): "auto" {
  return "auto";
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
