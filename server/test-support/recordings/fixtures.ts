import { existsSync } from "node:fs";
import { join } from "node:path";

export const RECORDINGS_DIR = "test/artifacts/sessions";

export function getRecordingFixture(filename: string): string | null {
  const recordingPath = join(RECORDINGS_DIR, filename);
  return existsSync(recordingPath) ? recordingPath : null;
}
