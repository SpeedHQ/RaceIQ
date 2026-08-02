import { registerGame } from "./registry";
import { forzaAdapter } from "./fm-2023";
import { f1Adapter } from "./f1-2025";
import { accAdapter } from "./acc";
import { acEvoAdapter } from "./ac-evo";
import { iracingAdapter } from "./iracing";
import { releaseFeatureFlags, type ReleaseFeatureFlags } from "../release-feature-flags";

export function gameAdaptersForFeatures(
  flags: ReleaseFeatureFlags = releaseFeatureFlags(true),
) {
  const adapters = [forzaAdapter, f1Adapter, accAdapter, acEvoAdapter];
  if (flags.iracingAdapter) adapters.push(iracingAdapter);
  return adapters;
}

/** Register game adapters. Call once at app startup. */
export function initGameAdapters(
  flags: ReleaseFeatureFlags = releaseFeatureFlags(true),
): void {
  for (const adapter of gameAdaptersForFeatures(flags)) registerGame(adapter);
}
