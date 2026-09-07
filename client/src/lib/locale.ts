import { isLocale, setLocale } from "@/paraglide/runtime";
import { uiStore, } from "@/stores/ui";

/**
 * Switch the app language without a full page reload.
 *
 * Paraglide's `setLocale` reloads the page by default because `m.*()` reads a
 * module-level locale variable with no React reactivity. We opt out of that
 * (`reload: false`) and instead bump `uiLocale` in the ui store, which is used
 * as a remount key on the routed content (see __root.tsx). That re-renders
 * every message in the new language while keeping the live WebSocket and
 * telemetry store mounted — important for a tool used mid-session.
 *
 * No-op for an unknown locale code.
 */
export function applyLocale(code: string): void {
  if (!isLocale(code)) return;
  setLocale(code, { reload: false });
  uiStore.actions.setUiLocale(code);
}
