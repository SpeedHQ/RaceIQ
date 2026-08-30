import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { GameId } from "../../shared/games/ids";
import { resolveDataDir } from "../runtime/config/data-dir";

const LD_ENTRY = "session.ld";
const LDX_ENTRY = "session.ldx";
const MANIFEST_ENTRY = "manifest.json";
export const MOTEC_SOURCE_SUFFIX = ".motec.zip";
import { PHYSICS as ACC_PHYSICS, GRAPHICS as ACC_GRAPHICS, STATIC as ACC_STATIC } from "../games/acc/structs";
import { PHYSICS as EVO_PHYSICS, GRAPHICS_EVO as EVO_GRAPHICS, STATIC_EVO as EVO_STATIC } from "../games/ac-evo/structs";
export function motecLegacyRecordLength(gameId: GameId): number {
  const sizes = gameId === "acc"
    ? [ACC_PHYSICS.SIZE, ACC_GRAPHICS.SIZE, ACC_STATIC.SIZE]
    : [EVO_PHYSICS.SIZE, EVO_GRAPHICS.SIZE, EVO_STATIC.SIZE];
  return 4 + 24 + sizes[0] + sizes[1] + sizes[2];
}
export function legacyMotecOffsetToPacketIndex(gameId: GameId, rawByteOffset: number): number {
  const length = motecLegacyRecordLength(gameId);
  if (rawByteOffset < 12 || (rawByteOffset - 12) % length !== 0) {
    throw new Error(`Legacy MoTeC raw offset ${rawByteOffset} is not aligned for ${gameId}`);
  }
  return (rawByteOffset - 12) / length;
}
export function packetIndexToLegacyMotecOffset(gameId: GameId, index: number): number {
  return 12 + index * motecLegacyRecordLength(gameId);
}
export function encodeMotecSourceArchive(
  ldBytes: Uint8Array,
  ldxBytes?: Uint8Array,
): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    [LD_ENTRY]: ldBytes,
    [MANIFEST_ENTRY]: Buffer.from(JSON.stringify({ version: 1, offsetEncoding: "packet-index" })),
  };
  if (ldxBytes !== undefined) entries[LDX_ENTRY] = ldxBytes;
  return zipSync(entries);
}

export function decodeMotecSourceArchive(bytes: Uint8Array): {
  ldBytes: Buffer;
  ldxBytes?: Buffer;
  offsetEncoding: MotecOffsetEncoding;
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
  let offsetEncoding: MotecOffsetEncoding = "legacy-bin-byte-offset";
  const manifest = entries[MANIFEST_ENTRY];
  if (manifest !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(manifest).toString("utf8")); } catch { throw new Error("Invalid MoTeC source archive manifest"); }
    if (!parsed || typeof parsed !== "object" || !("version" in parsed) || !("offsetEncoding" in parsed) ||
      parsed.version !== 1 ||
      (parsed.offsetEncoding !== "packet-index" && parsed.offsetEncoding !== "legacy-bin-byte-offset")) {
      throw new Error("Unsupported MoTeC source archive manifest");
    }
    offsetEncoding = parsed.offsetEncoding;
  }
  return {
    ldBytes: Buffer.from(ldBytes),
    offsetEncoding,
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
