/**
 * Static per-model context-window sizes (input tokens). Used by the chat
 * context meter to show "used / limit". Client-side only — provider + model
 * already live in settings, so no server round trip. Conservative 32k fallback
 * for anything unmapped (local models, new/unknown ids).
 */
const DEFAULT_WINDOW = 32_000;

export function contextWindowFor(provider: string, model: string): number {
  const m = (model || "").toLowerCase();
  switch (provider) {
    case "gemini":
      // Flash and Pro are both ≥1M on current Gemini.
      return 1_000_000;
    case "openai":
      // 4o / 4o-mini / 4.1 family are 128k.
      if (m.includes("gpt-3.5")) return 16_000;
      return 128_000;
    case "claude-cli":
    case "anthropic":
      return 200_000;
    case "local":
      return DEFAULT_WINDOW;
    default:
      return DEFAULT_WINDOW;
  }
}
