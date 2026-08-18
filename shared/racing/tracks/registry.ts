import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { IS_COMPILED, SHARED_DIR } from "@shared/platform/runtime/data-paths";

export const TRACK_REGISTRY_VERSION = 1 as const;
export const TRACK_REGISTRY_PATH = resolve(SHARED_DIR, "tracks", "registry.sqlite");

let registry: Database | null = null;

export function getTrackRegistry(): Database {
  if (registry) return registry;
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
  registry = database;
  return database;
}

export function writeTrackRegistry(operation: (database: Database) => void): void {
  if (IS_COMPILED) throw new Error("Bundled track registry is read-only");
  const database = getTrackRegistry();
  database.transaction(operation)(database);
}

export function closeTrackRegistry(): void {
  registry?.close();
  registry = null;
}
