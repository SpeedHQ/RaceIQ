import { existsSync } from "fs";
import { join } from "path";

export const RECORDINGS_DIR = "test/artifacts/sessions";

export function getRecordingFixture(filename: string): string | null {
  const recordingPath = join(RECORDINGS_DIR, filename);
  return existsSync(recordingPath) ? recordingPath : null;
}
