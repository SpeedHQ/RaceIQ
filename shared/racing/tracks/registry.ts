import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { IS_COMPILED } from "@shared/platform/runtime/data-paths";
import { readTrackRegistrySourceFiles, resolveTrackRegistryLocations } from "./registry-source";

export const TRACK_REGISTRY_VERSION = 3 as const;
export const TRACK_REGISTRY_PATH = resolveTrackRegistryLocations().databasePath;

let registry: Database | null = null;
let registryRevision = 0;

function actualSourceHash(sourceDirectory: string): string {
  const hash = createHash("sha256");
  for (const [filename, body] of readTrackRegistrySourceFiles({ sourceDirectory })) {
    hash.update(filename);
    hash.update("\0");
    hash.update(body);
  }
  return hash.digest("hex");
}

function openTrackRegistry(validateArtifacts: boolean): Database {
  if (registry) return registry;

  const locations = resolveTrackRegistryLocations();
  if (!IS_COMPILED && validateArtifacts && existsSync(locations.transactionPath)) {
    throw new Error(`Pending track registry source update ${locations.transactionPath}; run bun run tracks:registry`);
  }
  if (!existsSync(TRACK_REGISTRY_PATH)) throw new Error(`Missing bundled track registry ${TRACK_REGISTRY_PATH}`);

  const database = new Database(TRACK_REGISTRY_PATH, {
    readonly: IS_COMPILED,
    create: false,
    strict: true,
  });
  database.exec("PRAGMA foreign_keys = ON");

  const version = database.query("PRAGMA user_version").get() as { user_version: number };
  if (version.user_version !== TRACK_REGISTRY_VERSION) {
    database.close();
    throw new Error(`Unsupported track registry version ${version.user_version}; expected ${TRACK_REGISTRY_VERSION}`);
  }

  let metadata: Array<{ key: string; value: string }>;
  try {
    metadata = database.query("SELECT key, value FROM registry_metadata ORDER BY key").all() as Array<{ key: string; value: string }>;
  } catch {
    database.close();
    throw new Error("Track registry metadata missing; run bun run tracks:registry");
  }
  const metadataByKey = Object.fromEntries(metadata.map(({ key, value }) => [key, value]));
  if (metadata.length !== 2 || metadataByKey.sourceVersion !== "1" || !/^[0-9a-f]{64}$/.test(metadataByKey.sourceHash ?? "")) {
    database.close();
    throw new Error("Track registry metadata invalid; run bun run tracks:registry");
  }

  if (!IS_COMPILED && validateArtifacts) {
    const sourceHash = actualSourceHash(locations.sourceDirectory);
    if (sourceHash !== metadataByKey.sourceHash) {
      database.close();
      throw new Error("Stale generated track registry; run bun run tracks:registry");
    }
  }

  registry = database;
  return database;
}

export function getTrackRegistry(): Database {
  return openTrackRegistry(true);
}

export function writeGeneratedTrackRegistry(operation: (database: Database) => void): void {
  if (IS_COMPILED) throw new Error("Bundled track registry is read-only");
  const database = openTrackRegistry(false);
  database.transaction(operation)(database);
  registryRevision += 1;
}

export function getTrackRegistryRevision(): number {
  return registryRevision;
}

export function closeTrackRegistry(): void {
  registry?.close();
  registry = null;
}
