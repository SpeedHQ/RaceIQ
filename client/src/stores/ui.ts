import { createStore, useSelector, type StoreActionMap } from "@tanstack/react-store";
import { getLocale } from "@/paraglide/runtime";
export interface UiState { settingsOpen: boolean; settingsSection: string | undefined; onboardingOpen: boolean; uiLocale: string }
export interface UiActions extends StoreActionMap { openSettings: (section?: string) => void; closeSettings: () => void; openOnboarding: () => void; closeOnboarding: () => void; setUiLocale: (locale: string) => void }
const initialUiState: UiState = { settingsOpen: false, settingsSection: undefined, onboardingOpen: false, uiLocale: getLocale() };
export const uiStore = createStore(initialUiState, (store): UiActions => ({
  openSettings: (section) => store.setState((state) => ({ ...state, settingsOpen: true, settingsSection: section })),
  closeSettings: () => store.setState((state) => ({ ...state, settingsOpen: false, settingsSection: undefined })),
  openOnboarding: () => store.setState((state) => ({ ...state, onboardingOpen: true })),
  closeOnboarding: () => store.setState((state) => ({ ...state, onboardingOpen: false })),
  setUiLocale: (uiLocale) => store.setState((state) => ({ ...state, uiLocale })),
}));
export function useUiStore<T>(selector: (state: UiState) => T): T { return useSelector(uiStore, selector, { compare: Object.is }); }
