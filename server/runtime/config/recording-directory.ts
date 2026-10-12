import { resolve } from "node:path";
import { resolveDataDir } from "./data-dir";
import { loadSettings } from "./settings";

export function resolveRecordingDirectory(): string {
  return resolve(loadSettings().recordingDirectory ?? resolve(resolveDataDir(), "sessions"));
}
