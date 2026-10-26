import { randomUUID } from "node:crypto";
import { openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../runtime/config/data-dir";

const INSTALLATION_ID_PATH = join(resolveDataDir(), "recording-installation-id");

/** Stable local identity kept beside app data, never inside portable recordings or app.db. */
export function getRecordingInstallationId(): string {
  try {
    const id = readFileSync(INSTALLATION_ID_PATH, "utf8").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("Recording installation identity is malformed");
    }
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const id = randomUUID();
  let fd: number;
  try {
    fd = openSync(INSTALLATION_ID_PATH, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return getRecordingInstallationId();
  }
  try {
    writeFileSync(fd, `${id}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  return id;
}
