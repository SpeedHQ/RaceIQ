import { create } from "zustand";
import { getLocale } from "@/paraglide/runtime";

interface UiStore {
  settingsOpen: boolean;
  settingsSection: string | undefined;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  onboardingOpen: boolean;
  openOnboarding: () => void;
  closeOnboarding: () => void;
  /**
   * Current UI locale, mirrored from Paraglide. Used as a remount key on the
   * routed content so a language switch re-renders every `m.*` string WITHOUT a
   * full page reload (keeps the live WebSocket + telemetry store alive). Update
   * it via `applyLocale()` in lib/locale.ts, never directly.
   */
  uiLocale: string;
  setUiLocale: (locale: string) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  settingsOpen: false,
  settingsSection: undefined,
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section }),
  closeSettings: () => set({ settingsOpen: false, settingsSection: undefined }),
  onboardingOpen: false,
  openOnboarding: () => set({ onboardingOpen: true }),
  closeOnboarding: () => set({ onboardingOpen: false }),
  uiLocale: getLocale(),
  setUiLocale: (locale) => set({ uiLocale: locale }),
}));
