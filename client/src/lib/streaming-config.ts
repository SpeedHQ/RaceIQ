export const OVERLAY_WIDGETS = ["driving", "inputs", "timing", "standings", "nearby", "damage"] as const;
export type OverlayWidget = (typeof OVERLAY_WIDGETS)[number];
export type OverlayConfig = { widget: OverlayWidget; unit: "metric" | "imperial" };

export function parseOverlayConfig(search: Record<string, unknown>): OverlayConfig {
  const widget = typeof search.widget === "string" && (OVERLAY_WIDGETS as readonly string[]).includes(search.widget)
    ? search.widget as OverlayWidget
    : "driving";
  const unit = search.unit === "imperial" ? "imperial" : "metric";
  return { widget, unit };
}

export function buildOverlayUrl(origin: string, config: OverlayConfig): string {
  const url = new URL("/overlay", origin);
  url.searchParams.set("widget", config.widget);
  url.searchParams.set("unit", config.unit);
  return url.toString();
}
