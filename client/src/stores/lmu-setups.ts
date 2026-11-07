import { create } from "zustand";
import type { SetStateAction } from "react";
import type { SvmDocument } from "@raceiq/game-lmu-metadata/setups/svm";

export type LmuSetupSource = { kind: "file"; path: string; sha256: string };
export interface LoadedLmuSetup { id: string; document: SvmDocument; source: LmuSetupSource; fileName: string }
interface LmuSetupSession {
  active: LoadedLmuSetup | null;
  compareA: LoadedLmuSetup | null;
  compareB: LoadedLmuSetup | null;
  loaded: ReadonlyMap<string, LoadedLmuSetup>;
  pending: ReadonlyMap<string, number>;
  setActive: (value: LoadedLmuSetup | null) => void;
  setCompareA: (value: LoadedLmuSetup | null) => void;
  setCompareB: (value: LoadedLmuSetup | null) => void;
  setLoaded: (value: SetStateAction<ReadonlyMap<string, LoadedLmuSetup>>) => void;
  setPending: (value: SetStateAction<ReadonlyMap<string, number>>) => void;
}

// Memory only: preserve staged clicks while navigating; imported originals live in LMU Settings.
export const useLmuSetupSession = create<LmuSetupSession>((set) => ({
  active: null,
  compareA: null,
  compareB: null,
  loaded: new Map(),
  pending: new Map(),
  setActive: (active) => set({ active }),
  setCompareA: (compareA) => set({ compareA }),
  setCompareB: (compareB) => set({ compareB }),
  setLoaded: (value) => set((state) => ({ loaded: typeof value === "function" ? value(state.loaded) : value })),
  setPending: (value) => set((state) => ({ pending: typeof value === "function" ? value(state.pending) : value })),
}));
