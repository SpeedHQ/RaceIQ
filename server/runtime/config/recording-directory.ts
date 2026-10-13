import type { SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import { resolve } from "node:path";
import { resolveDataDir } from "./data-dir";
import { loadSettings } from "./settings";

export function resolveRecordingDirectory(): string {
  return resolve(loadSettings().recordingDirectory ?? resolve(resolveDataDir(), "sessions"));
}

export function resolveRecordingGameDirectory(gameId: string, ownership: SessionOwnership = "mine"): string {
  return resolve(resolveRecordingDirectory(), ownership === "others" ? "others" : "own", gameId);
}
