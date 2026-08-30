import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MOTEC_ZIP_LIMITS, unzipBounded } from "../archive/bounded-unzip";

export interface StagedMotecArchive {
  token: string;
  ldName: string;
  ldxName: string;
}

export interface ExtractedMotecArchive {
  ldBytes: Buffer;
  ldxBytes: Buffer;
  ldName: string;
  ldxName: string;
}

interface StagedPaths {
  directory: string;
  ld: string;
  ldx: string;
  manifest: string;
}

const STAGE_TTL_MS = 15 * 60 * 1000;
const STAGING_DIRECTORY_PATTERN = /^raceiq-motec-([0-9a-f-]{36})$/i;

function pathsFor(token: string): StagedPaths {
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("Invalid MoTeC extraction token");
  const directory = join(tmpdir(), `raceiq-motec-${token}`);
  return { directory, ld: join(directory, "session.ld"), ldx: join(directory, "session.ldx"), manifest: join(directory, "manifest.json") };
}

function safeArchiveName(name: string, fallback: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? "";
  const sanitized = leaf
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
    .trim()
    .slice(0, 128);
  return sanitized || fallback;
}

export function extractMotecArchive(bytes: Uint8Array): ExtractedMotecArchive {
  const entries = unzipBounded(bytes, MOTEC_ZIP_LIMITS);
  const ld = Object.entries(entries).filter(([name, value]) => name.toLowerCase().endsWith(".ld") && value.byteLength > 0);
  const ldx = Object.entries(entries).filter(([name, value]) => name.toLowerCase().endsWith(".ldx") && value.byteLength > 0);
  if (ld.length !== 1) throw new Error("MoTeC archive must contain exactly one non-empty .ld file");
  if (ldx.length !== 1) throw new Error("MoTeC archive must contain exactly one non-empty .ldx signal file");
  return {
    ldBytes: Buffer.from(ld[0]![1]),
    ldxBytes: Buffer.from(ldx[0]![1]),
    ldName: safeArchiveName(ld[0]![0], "session.ld"),
    ldxName: safeArchiveName(ldx[0]![0], "session.ldx"),
  };
}

export function isMotecArchive(bytes: Uint8Array): boolean {
  try {
    extractMotecArchive(bytes);
    return true;
  } catch {
    return false;
  }
}

export async function stageMotecArchive(bytes: Uint8Array): Promise<StagedMotecArchive> {
  const extracted = extractMotecArchive(bytes);
  const token = randomUUID();
  const paths = pathsFor(token);
  await mkdir(paths.directory, { recursive: false });
  try {
    await writeFile(paths.ld, extracted.ldBytes);
    await writeFile(paths.ldx, extracted.ldxBytes);
    await writeFile(paths.manifest, JSON.stringify({
      version: 1,
      createdAt: Date.now(),
      ldName: extracted.ldName,
      ldxName: extracted.ldxName,
    }));
    return {
      token,
      ldName: extracted.ldName,
      ldxName: extracted.ldxName,
    };
  } catch (error) {
    await rm(paths.directory, { recursive: true, force: true });
    throw error;
  }
}

export async function loadStagedMotec(token: string): Promise<{ ldBytes: Buffer; ldxBytes: Buffer }> {
  const paths = pathsFor(token);
  const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as { version?: number; createdAt?: number };
  if (manifest.version !== 1 || !manifest.createdAt || Date.now() - manifest.createdAt > STAGE_TTL_MS) {
    await rm(paths.directory, { recursive: true, force: true });
    throw new Error("This MoTeC extraction has expired");
  }
  await stat(paths.ld);
  await stat(paths.ldx);
  return { ldBytes: await readFile(paths.ld), ldxBytes: await readFile(paths.ldx) };
}

export async function removeStagedMotec(token: string): Promise<void> {
  await rm(pathsFor(token).directory, { recursive: true, force: true });
}

export async function cleanupExpiredStagedMotec(now = Date.now()): Promise<number> {
  let entries;
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = STAGING_DIRECTORY_PATTERN.exec(entry.name);
    if (!match) continue;

    const paths = pathsFor(match[1]!);
    let createdAt: number;
    try {
      createdAt = (await stat(paths.directory)).mtimeMs;
    } catch {
      continue;
    }
    try {
      const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as { createdAt?: unknown };
      if (typeof manifest.createdAt === "number") createdAt = manifest.createdAt;
    } catch {
      // Missing or malformed manifests age from the directory timestamp.
    }
    if (now - createdAt <= STAGE_TTL_MS) continue;

    try {
      await rm(paths.directory, { recursive: true, force: true });
      removed++;
    } catch {
      // Cancellation may remove the directory during this maintenance pass.
    }
  }
  return removed;
}
