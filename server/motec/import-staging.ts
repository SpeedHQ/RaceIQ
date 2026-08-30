import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";

export interface StagedMotecArchive {
  token: string;
  ldName: string;
  ldxName: string;
}

interface StagedPaths {
  directory: string;
  ld: string;
  ldx: string;
  manifest: string;
}

function pathsFor(token: string): StagedPaths {
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("Invalid MoTeC extraction token");
  const directory = join(tmpdir(), `raceiq-motec-${token}`);
  return { directory, ld: join(directory, "session.ld"), ldx: join(directory, "session.ldx"), manifest: join(directory, "manifest.json") };
}

function extractEntries(bytes: Uint8Array): { ld: [string, Uint8Array]; ldx: [string, Uint8Array] } {
  const entries = unzipSync(bytes);
  const ld = Object.entries(entries).filter(([name, value]) => name.toLowerCase().endsWith(".ld") && value.byteLength > 0);
  const ldx = Object.entries(entries).filter(([name, value]) => name.toLowerCase().endsWith(".ldx") && value.byteLength > 0);
  if (ld.length !== 1) throw new Error("MoTeC archive must contain exactly one non-empty .ld file");
  if (ldx.length !== 1) throw new Error("MoTeC archive must contain exactly one non-empty .ldx signal file");
  return { ld: ld[0]!, ldx: ldx[0]! };
}

export function isMotecArchive(bytes: Uint8Array): boolean {
  try {
    extractEntries(bytes);
    return true;
  } catch {
    return false;
  }
}

export async function stageMotecArchive(bytes: Uint8Array): Promise<StagedMotecArchive> {
  const { ld, ldx } = extractEntries(bytes);
  const token = randomUUID();
  const paths = pathsFor(token);
  await mkdir(paths.directory, { recursive: false });
  try {
    await writeFile(paths.ld, ld[1]);
    await writeFile(paths.ldx, ldx[1]);
    await writeFile(paths.manifest, JSON.stringify({ version: 1, createdAt: Date.now(), ldName: ld[0].split(/[\\/]/).pop(), ldxName: ldx[0].split(/[\\/]/).pop() }));
    return { token, ldName: ld[0].split(/[\\/]/).pop() ?? "session.ld", ldxName: ldx[0].split(/[\\/]/).pop() ?? "session.ldx" };
  } catch (error) {
    await rm(paths.directory, { recursive: true, force: true });
    throw error;
  }
}

export async function loadStagedMotec(token: string): Promise<{ ldBytes: Buffer; ldxBytes: Buffer }> {
  const paths = pathsFor(token);
  const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as { version?: number; createdAt?: number };
  if (manifest.version !== 1 || !manifest.createdAt || Date.now() - manifest.createdAt > 15 * 60 * 1000) {
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
