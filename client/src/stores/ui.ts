import { create } from "zustand";

interface UiStore {
  settingsOpen: boolean;
  settingsSection: string | undefined;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  onboardingOpen: boolean;
  openOnboarding: () => void;
  closeOnboarding: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  settingsOpen: false,
  settingsSection: undefined,
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section }),
  closeSettings: () => set({ settingsOpen: false, settingsSection: undefined }),
  onboardingOpen: false,
  openOnboarding: () => set({ onboardingOpen: true }),
  closeOnboarding: () => set({ onboardingOpen: false }),
}));
