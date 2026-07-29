import { registerGame } from "./registry";
import { forzaAdapter } from "./fm-2023";
import { f1Adapter } from "./f1-2025";
import { accAdapter } from "./acc";
import { acEvoAdapter } from "./ac-evo";
import { iracingAdapter } from "./iracing";

/** Register all known game adapters. Call once at app startup. */
export function initGameAdapters(): void {
  registerGame(forzaAdapter);
  registerGame(f1Adapter);
  registerGame(accAdapter);
  registerGame(acEvoAdapter);
  registerGame(iracingAdapter);
}
