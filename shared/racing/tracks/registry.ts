import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { IS_COMPILED } from "@shared/platform/runtime/data-paths";
import { readTrackRegistryReadModel, TRACK_REGISTRY_VERSION, type TrackRegistryReadModel } from "./registry/read-model";
import { readTrackRegistrySourceFiles, resolveTrackRegistryLocations } from "./registry/source";

export { TRACK_REGISTRY_VERSION } from "./registry/read-model";
export type { TrackRegistryReadModel } from "./registry/read-model";

/** Runtime path to bundled generated track registry. */
export const TRACK_REGISTRY_PATH = resolveTrackRegistryLocations().registryPath;

let registry: TrackRegistryReadModel | null = null;

function actualSourceHash(sourceDirectory: string): string {
  const hash = createHash("sha256");
  for (const [filename, body] of readTrackRegistrySourceFiles({ sourceDirectory })) {
    hash.update(filename);
    hash.update("\0");
    hash.update(body);
  }
  return hash.digest("hex");
}

/** Load validated generated registry once and retain it in memory. */
export function getTrackRegistry(): TrackRegistryReadModel {
  if (registry) return registry;

  const locations = resolveTrackRegistryLocations();
  if (!IS_COMPILED && existsSync(locations.transactionPath)) {
    throw new Error(`Pending track registry source update ${locations.transactionPath}; run bun run tracks:registry`);
  }
  const loaded = readTrackRegistryReadModel(TRACK_REGISTRY_PATH);
  if (loaded.version !== TRACK_REGISTRY_VERSION) {
    throw new Error(`Unsupported track registry version ${loaded.version}; expected ${TRACK_REGISTRY_VERSION}`);
  }
  if (!IS_COMPILED && actualSourceHash(locations.sourceDirectory) !== loaded.sourceHash) {
    throw new Error("Stale generated track registry; run bun run tracks:registry");
  }
  registry = loaded;
  return registry;
}

/** Invalidate in-memory registry after development-time artifact replacement. */
export function invalidateTrackRegistry(): void {
  registry = null;
}
