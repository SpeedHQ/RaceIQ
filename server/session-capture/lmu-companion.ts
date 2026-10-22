import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import { ManifestSchema, MAX_CAPTURE_MANIFEST_BYTES, type Manifest } from "@raceiq/capture-splitting";

export type LmuOpponentRetention = {
  opponentRetention: "retained" | "removed" | "not-recorded";
  opponentAvailability: "complete" | "incomplete" | "missing" | "corrupt" | null;
  sourceRevision: string;
};

const revisionFor = (info: Stats): string =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;

/** Reads retention from an owned standalone manifest; legacy source metadata stays unknown/retained. */
export async function readLmuOpponentRetention(sourcePath: string): Promise<LmuOpponentRetention> {
  const sourceInfo = await stat(sourcePath);
  const sourceRevision = revisionFor(sourceInfo);
  const manifestPath = sourcePath.endsWith("capture-manifest.json")
    ? sourcePath
    : resolve(dirname(sourcePath), "capture-manifest.json");
  let manifestBytes: Buffer;
  try {
    const info = await stat(manifestPath);
    if (info.size > MAX_CAPTURE_MANIFEST_BYTES) throw new Error("Capture manifest exceeds size limit");
    manifestBytes = await readFile(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { opponentRetention: "retained", opponentAvailability: "incomplete", sourceRevision };
    }
    throw error;
  }
  let manifest: Manifest;
  try {
    manifest = Schema.decodeUnknownSync(ManifestSchema)(JSON.parse(manifestBytes.toString("utf8")));
  } catch {
    return { opponentRetention: "retained", opponentAvailability: "corrupt", sourceRevision };
  }
  if (manifest.opponentRetention === "removed" || manifest.opponentRetention === "not-recorded") {
    return { opponentRetention: manifest.opponentRetention, opponentAvailability: null, sourceRevision: manifest.sourceRevision };
  }
  const companion = manifest.opponentCompanion;
  if (!companion) {
    const availability = manifest.opponentRetention === undefined ? "incomplete" : "missing";
    return { opponentRetention: "retained", opponentAvailability: availability, sourceRevision: manifest.sourceRevision };
  }
  if (companion.committedPrefix.byteLength < companion.byteLength) {
    return { opponentRetention: "retained", opponentAvailability: "incomplete", sourceRevision: manifest.sourceRevision };
  }
  try {
    if (basename(companion.file) !== companion.file || isAbsolute(companion.file)) throw new Error("Invalid companion path");
    const directory = await realpath(dirname(manifestPath));
    const path = resolve(directory, companion.file);
    const resolved = await realpath(path);
    const inside = relative(directory, resolved);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Companion path escapes manifest directory");
    const info = await stat(resolved);
    if (info.size !== companion.byteLength) throw new Error("Companion length mismatch");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(resolved)) digest.update(chunk);
    if (digest.digest("hex") !== companion.sha256) throw new Error("Companion integrity mismatch");
    return { opponentRetention: "retained", opponentAvailability: "complete", sourceRevision: manifest.sourceRevision };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { opponentRetention: "retained", opponentAvailability: code === "ENOENT" ? "missing" : "corrupt", sourceRevision: manifest.sourceRevision };
  }
}
