import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, readdir, mkdir, open, link, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, parse } from "node:path";

export function isRecordingPathContained(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export async function hashRecordingFile(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

export async function canonicalRecordingPath(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try { return resolve(await realpath(current), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

const captureExtensions = [".bin", ".bin.gz", ".motec.zip"];
export function isRecordingCaptureName(name: string): boolean {
  return captureExtensions.some((extension) => name.endsWith(extension));
}

export async function findLegacyRecordingFiles(root: string, knownGames: ReadonlySet<string>): Promise<string[]> {
  const result: string[] = [];
  let games;
  try { games = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
  for (const game of games) {
    if (!game.isDirectory() || game.name === "own" || game.name === "others" || !knownGames.has(game.name)) continue;
    const directory = join(root, game.name);
    let files;
    try { files = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const file of files) if (file.isFile() && isRecordingCaptureName(file.name)) result.push(join(directory, file.name));
  }
  return result;
}

export async function validateLegacyRecordingPath(root: string, path: string, requireCaptureName = true): Promise<boolean> {
  const parts = relative(root, path).split(sep);
  if (!isRecordingPathContained(root, path) || parts.length !== 2 || (requireCaptureName && !isRecordingCaptureName(parts[1]))) return false;
  const rootInfo = await lstat(root).catch(() => null);
  const parent = await lstat(join(root, parts[0])).catch(() => null);
  if (rootInfo?.isSymbolicLink() || (rootInfo && !rootInfo.isDirectory()) || parent?.isSymbolicLink() || (parent && !parent.isDirectory())) return false;
  const file = await lstat(path).catch(() => null);
  return file === null || (file.isFile() && !file.isSymbolicLink());
}

export async function isLegacyRecordingCandidate(root: string, path: string, requireCaptureName = true): Promise<boolean> {
  if (!await validateLegacyRecordingPath(root, path, requireCaptureName)) return false;
  const directory = await lstat(dirname(path)).catch(() => null);
  const file = await lstat(path).catch(() => null);
  return Boolean(directory?.isDirectory() && !directory.isSymbolicLink() && file?.isFile() && !file.isSymbolicLink());
}
export async function enumerateRecordingFiles(root: string, excluded?: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = resolve(directory, name);
      if (excluded && (path === excluded || isRecordingPathContained(excluded, path))) continue;
      const info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile() && isRecordingCaptureName(name)) found.push(path);
    }
  }
  try { await visit(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return found;
}

export async function hasRecordingSymlinkDirectory(root: string, path: string): Promise<boolean> {
  const parts = relative(root, path).split(sep).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

export async function canonicalExistingRecordingParent(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try { return await realpath(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
export async function validateRecordingDirectory(input: string, roots: { dataDirectory: string; currentDirectory: string }): Promise<string> {
  const invalid = (message: string, code = "INVALID_DIRECTORY") => Object.assign(new Error(message), { code });
  if (!input.trim() || input.includes("\0") || !isAbsolute(input)) throw invalid("Directory must be an absolute path");
  const requested = resolve(input);
  let canonical: string;
  try { canonical = await realpath(requested); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(requested, { recursive: true });
    canonical = await realpath(requested);
  }
  if (!(await lstat(canonical)).isDirectory()) throw invalid("Path is not a directory");
  const dataDirectory = await realpath(roots.dataDirectory);
  const currentDirectory = await realpath(roots.currentDirectory).catch((error) =>
    (error as NodeJS.ErrnoException).code === "ENOENT" ? resolve(roots.currentDirectory) : Promise.reject(error));
  const nestedDataDestination = isRecordingPathContained(currentDirectory, canonical) && isRecordingPathContained(dataDirectory, currentDirectory);
  if (canonical === parse(canonical).root || canonical === dataDirectory || canonical !== currentDirectory &&
    (isRecordingPathContained(canonical, dataDirectory) || isRecordingPathContained(dataDirectory, canonical) && !nestedDataDestination)) {
    throw invalid("Directory is reserved");
  }
  if (canonical !== currentDirectory) {
    const probe = resolve(canonical, `.raceiq-link-probe-${randomUUID()}`);
    const linkedProbe = `${probe}.link`;
    const handle = await open(probe, "wx");
    try {
      await handle.sync();
      await link(probe, linkedProbe);
    } catch (error) {
      if (["ENOTSUP", "EOPNOTSUPP", "EXDEV", "EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw invalid("Destination filesystem does not support hard links required for safe recording relocation", "UNSUPPORTED_FILESYSTEM");
      }
      throw error;
    } finally {
      await handle.close();
      await rm(linkedProbe, { force: true });
      await rm(probe, { force: true });
    }
  }
  return canonical;
}
