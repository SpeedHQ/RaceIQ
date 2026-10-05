import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MOTEC_ZIP_LIMITS, unzipBounded } from "../archive/bounded-unzip";
import { resolveDataDir } from "../runtime/config/data-dir";

export interface StagedMotecOriginal {
  token: string;
  path: string;
  outputRoot: string;
  originalName: string;
  sidecarPath?: string;
}

function originalPaths(token: string): { directory: string; input: string; manifest: string; outputRoot: string } {
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("Invalid MoTeC extraction token");
  const root = resolve(resolveDataDir(), "recorder-jobs", "motec-staging");
  const directory = join(root, token);
  const outputRoot = join(resolve(resolveDataDir(), "recorder-jobs", "motec-jobs"), token);
  return { directory, input: join(directory, "original-upload"), manifest: join(directory, "manifest.json"), outputRoot };
}
export async function stageMotecOriginalPair(ldBytes: Uint8Array, ldxBytes: Uint8Array, ldName = "session.ld", ldxName = "session.ldx"): Promise<StagedMotecOriginal> {
  await cleanupExpiredMotecOriginals();
  const token = randomUUID();
  const paths = originalPaths(token);
  const sidecarPath = join(paths.directory, "session.ldx");
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await mkdir(paths.outputRoot, { recursive: true, mode: 0o700 });
  try {
    await writeFile(paths.input, ldBytes, { flag: "wx", mode: 0o600 });
    await writeFile(sidecarPath, ldxBytes, { flag: "wx", mode: 0o600 });
    await writeFile(paths.manifest, JSON.stringify({ version: 1, createdAt: Date.now(), originalName: ldName, ldxName }), { flag: "wx", mode: 0o600 });
    return { token, path: paths.input, sidecarPath, outputRoot: paths.outputRoot, originalName: ldName };
  } catch (error) {
    await rm(paths.directory, { recursive: true, force: true });
    await rm(paths.outputRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function stageMotecOriginal(bytes: Uint8Array, originalName: string): Promise<StagedMotecOriginal> {
  await cleanupExpiredMotecOriginals();
  const token = randomUUID();
  const paths = originalPaths(token);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await mkdir(paths.outputRoot, { recursive: true, mode: 0o700 });
  try {
    await writeFile(paths.input, bytes, { flag: "wx", mode: 0o600 });
    await writeFile(paths.manifest, JSON.stringify({ version: 1, createdAt: Date.now(), originalName }), { flag: "wx", mode: 0o600 });
    return { token, path: paths.input, outputRoot: paths.outputRoot, originalName };
  } catch (error) {
    await rm(paths.directory, { recursive: true, force: true });
    await rm(paths.outputRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function loadStagedMotecOriginal(token: string): Promise<StagedMotecOriginal> {
  await cleanupExpiredMotecOriginals();
  const paths = originalPaths(token);
  let manifest: { version?: number; createdAt?: number; originalName?: string; ldxName?: string };
  try {
    manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
    await stat(paths.input);
  } catch {
    throw new Error("This MoTeC extraction has expired");
  }
  if (manifest.version !== 1 || !manifest.createdAt || Date.now() - manifest.createdAt > STAGE_TTL_MS || typeof manifest.originalName !== "string") {
    await rm(paths.directory, { recursive: true, force: true });
    throw new Error("This MoTeC extraction has expired");
  }
  const sidecarPath = manifest.ldxName ? join(paths.directory, "session.ldx") : undefined;
  if (sidecarPath) await stat(sidecarPath);
  await mkdir(paths.outputRoot, { recursive: true, mode: 0o700 });
  return { token, path: paths.input, outputRoot: paths.outputRoot, originalName: manifest.originalName, ...(sidecarPath ? { sidecarPath } : {}) };
}
export async function removeStagedMotecOriginal(token: string): Promise<void> {
  await rm(originalPaths(token).directory, { recursive: true, force: true });
}

async function cleanupExpiredMotecOriginals(now = Date.now()): Promise<void> {
  const root = resolve(resolveDataDir(), "recorder-jobs", "motec-staging");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const paths = originalPaths(entry.name);
    try {
      const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as { createdAt?: unknown };
      const createdAt = typeof manifest.createdAt === "number" ? manifest.createdAt : (await stat(paths.directory)).mtimeMs;
      if (now - createdAt > STAGE_TTL_MS) await rm(paths.directory, { recursive: true, force: true });
    } catch {
      await rm(paths.directory, { recursive: true, force: true });
    }
  }
}

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
