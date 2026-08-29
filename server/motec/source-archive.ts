import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { GameId } from "../../shared/games/ids";
import { resolveDataDir } from "../runtime/config/data-dir";

export const MOTEC_SOURCE_SUFFIX = ".motec.zip";

const LD_ENTRY = "session.ld";
const LDX_ENTRY = "session.ldx";

export function encodeMotecSourceArchive(
  ldBytes: Uint8Array,
  ldxBytes?: Uint8Array,
): Uint8Array {
  const entries: Record<string, Uint8Array> = { [LD_ENTRY]: ldBytes };
  if (ldxBytes !== undefined) entries[LDX_ENTRY] = ldxBytes;
  return zipSync(entries);
}

export function decodeMotecSourceArchive(bytes: Uint8Array): {
  ldBytes: Buffer;
  ldxBytes?: Buffer;
} {
  const entries = unzipSync(bytes);
  const ldBytes = entries[LD_ENTRY];
  if (ldBytes === undefined) {
    throw new Error("Invalid MoTeC source archive: missing session.ld");
  }
  if (ldBytes.byteLength === 0) {
    throw new Error("Invalid MoTeC source archive: session.ld is empty");
  }
  const ldxBytes = entries[LDX_ENTRY];
  return {
    ldBytes: Buffer.from(ldBytes),
    ...(ldxBytes === undefined ? {} : { ldxBytes: Buffer.from(ldxBytes) }),
  };
}

export async function persistMotecSourceArchive(
  gameId: GameId,
  ldBytes: Uint8Array,
  ldxBytes?: Uint8Array,
): Promise<string> {
  const directory = join(resolveDataDir(), "sessions", gameId);
  await mkdir(directory, { recursive: true });

  const archivePath = join(
    directory,
    `${new Date().toISOString()}-${randomUUID()}${MOTEC_SOURCE_SUFFIX}`,
  );
  const temporaryPath = `${archivePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, encodeMotecSourceArchive(ldBytes, ldxBytes));
    await rename(temporaryPath, archivePath);
    return archivePath;
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Temporary file may not have been created, or may already be gone.
    }
    throw error;
  }
}
