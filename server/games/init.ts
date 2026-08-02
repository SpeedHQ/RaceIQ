import { registerServerGame } from "./registry";
import { registerGame } from "../../shared/games/registry";
import { forzaServerAdapter } from "./fm-2023";
import { f1ServerAdapter } from "./f1-2025";
import { accServerAdapter } from "./acc";
import { acEvoServerAdapter } from "./ac-evo";
import { iracingServerAdapter } from "./iracing";
import { releaseFeatureFlags, type ReleaseFeatureFlags } from "../../shared/release-feature-flags";

export function nativeTelemetryGameIds(
  flags = releaseFeatureFlags(true),
): readonly ["acc", "ac-evo"] | readonly ["acc", "ac-evo", "iracing"] {
  return flags.iracingAdapter ? ["acc", "ac-evo", "iracing"] : ["acc", "ac-evo"];
}

export function serverGameAdaptersForFeatures(
  flags: ReleaseFeatureFlags = releaseFeatureFlags(true),
) {
  const adapters = [
    f1ServerAdapter,
    forzaServerAdapter,
    accServerAdapter,
    acEvoServerAdapter,
  ];
  if (flags.iracingAdapter) adapters.push(iracingServerAdapter);
  return adapters;
}

/** Register server game adapters. Call once at server startup. */
export function initServerGameAdapters(
  flags: ReleaseFeatureFlags = releaseFeatureFlags(true),
): void {
  for (const adapter of serverGameAdaptersForFeatures(flags)) {
    registerServerGame(adapter);
    // Server adapters override shared stub name-resolution methods.
    registerGame(adapter);
  }
}
