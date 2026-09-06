/**
 * Static per-model context-window sizes (input tokens). Used by the chat
 * context meter to show "used / limit". Client-side only — provider + model
 * already live in settings, so no server round trip. Unknown providers/models
 * return `undefined` (no meter) rather than a made-up limit.
 *
 * `localContext` — real context length reported by the local server (LM Studio
 * native API, surfaced via /api/ai-models `contextLength`).
 * `localContext` — real context length reported by the local server (LM Studio
 * native API, surfaced via /api/ai-models `contextLength`). Used for the
 * "local" provider; returns `undefined` (unknown) when absent so the UI can
 * hide the meter instead of showing a made-up limit.
 */
export function contextWindowFor(provider: string, model: string, localContext?: number): number | undefined {
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
    case "openai-compatible":
      return localContext && localContext > 0 ? localContext : undefined;
    default:
      return undefined;
  }
}
