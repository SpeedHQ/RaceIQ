export type ChatVisionCapability = "supported" | "unsupported" | "unknown";

const GEMINI_VISION_MODELS = [
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  "gemini-1.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
];

const OPENAI_VISION_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4.5-preview",
  "o1",
  "o3",
  "o3-pro",
  "o4-mini",
];

const GEMINI_TEXT_ONLY_MODELS = ["gemini-embedding-001"];
const OPENAI_TEXT_ONLY_MODELS = [
  "o1-mini",
  "o1-preview",
  "o3-mini",
  "gpt-4o-audio-preview",
  "gpt-4o-mini-audio-preview",
  "gpt-4o-realtime-preview",
  "gpt-4o-mini-realtime-preview",
  "gpt-4o-mini-tts",
  "gpt-3.5-turbo",
  "gpt-4-turbo-preview",
  "text-embedding-3-small",
  "text-embedding-3-large",
];

function supportsVerifiedModel(model: string, models: readonly string[]): boolean {
  return models.includes(model) || models.some((id) =>
    model.startsWith(`${id}-`) && /^-\d{4}-\d{2}-\d{2}$/.test(model.slice(id.length)),
  );
}

/** Conservative chat-model image support; analyst provider settings do not apply here. */
export function resolveChatVisionCapability(provider: string | undefined, model: string | undefined): ChatVisionCapability {
  if (!provider || !model) return "unknown";
  const normalized = model.trim().toLowerCase();
  if (provider === "gemini") {
    if (GEMINI_TEXT_ONLY_MODELS.some((id) => normalized === id || normalized.startsWith(`${id}-`))) return "unsupported";
    return supportsVerifiedModel(normalized, GEMINI_VISION_MODELS) ? "supported" : "unknown";
  }
  if (provider === "openai") {
    if (OPENAI_TEXT_ONLY_MODELS.some((id) => normalized === id || normalized.startsWith(`${id}-`))) return "unsupported";
    return supportsVerifiedModel(normalized, OPENAI_VISION_MODELS) ? "supported" : "unknown";
  }
  return "unknown";
}

export function chatRequestHasImage(messages: unknown[]): boolean {
  const hasImagePart = (part: unknown): boolean => {
    if (!part || typeof part !== "object") return false;
    const value = part as Record<string, unknown>;
    if (value.type === "image" || value.type === "image_url") return true;
    if (value.type !== "file") return false;
    const mime = value.mediaType ?? value.mimeType;
    if (typeof mime === "string" && /^image\//i.test(mime.trim())) return true;
    const data = value.url ?? value.data;
    return typeof data === "string" && /^data:image\//i.test(data);
  };
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const value = message as Record<string, unknown>;
    return [value.parts, value.content].some((parts) => Array.isArray(parts) && parts.some(hasImagePart));
  });
}
