import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write JSON by replacing target only after complete serialization/write.
 * Temporary files stay beside target so rename remains atomic on one volume.
 */
export function writeAtomicJson(path: string, value: unknown): void {
  const target = resolve(path);
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporary = resolve(directory, `.${basename(target)}.${randomBytes(12).toString("hex")}.tmp`);
  try {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) throw new Error("Cannot serialize undefined as JSON");
    const encoded = `${json}\n`;
    writeFileSync(temporary, encoded, "utf8");
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve original write/rename error; cleanup is best effort.
    }
    throw error;
  }
}
