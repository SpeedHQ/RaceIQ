import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { findLMUSetupsDirectory } from "@raceiq/game-lmu/setup-directory";
import { resolveLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import { parseSVM, writeSVM, type SvmDocument, type SvmEdit } from "@raceiq/game-lmu-metadata/setups/svm";
import { getSvmFieldAccess } from "@raceiq/game-lmu-metadata/setups/capabilities";
import { sanitisePathSegment } from "../routes/tune-shared";
import { isPathWithinSetupsFolder } from "./file-guard";

const MAX_SOURCE_BYTES = 1024 * 1024;

type Failure = { ok: false; status: 400 | 404 | 409 | 500; error: string };
type Success<T> = { ok: true; value: T };
type Result<T> = Success<T> | Failure;
type ValidFile = { bytes: Uint8Array; parsed: SvmDocument };

function fail(status: Failure["status"], error: string): Failure { return { ok: false, status, error }; }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function validBase64(value: string): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) return null;
  return new Uint8Array(buffer);
}

async function canonicalRoot(): Promise<{ root: string; realRoot: string } | null> {
  const root = await findLMUSetupsDirectory();
  if (!root) return null;
  try {
    const realRoot = await realpath(root);
    if (!(await stat(realRoot)).isDirectory()) return null;
    return { root: resolve(root), realRoot };
  } catch { return null; }
}

function relativeParts(input: string): string[] | null {
  if (!input || input.includes("\\") || input.startsWith("/") || input.includes("\0")) return null;
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts;
}

async function guardedPath(root: { root: string; realRoot: string }, relative: string, directory = false): Promise<Result<string>> {
  const parts = relativeParts(relative);
  if (!parts) return fail(400, "Path must be a relative path inside LMU Settings");
  const candidate = resolve(root.root, ...parts);
  if (!isPathWithinSetupsFolder(candidate, root.root)) return fail(400, "Path must be inside LMU Settings");
  try {
    const real = await realpath(candidate);
    if (!isPathWithinSetupsFolder(real, root.realRoot) || !(await stat(real))[directory ? "isDirectory" : "isFile"]()) return fail(400, "Path must be inside LMU Settings");
    return { ok: true, value: real };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fail(404, directory ? "Track folder not found" : "Setup file not found");
    return fail(500, "Could not inspect LMU setup path");
  }
}

async function readValidFile(root: { root: string; realRoot: string }, path: string): Promise<Result<ValidFile>> {
  if (!path.toLowerCase().endsWith(".svm")) return fail(400, "Only .svm setup files are supported");
  const guarded = await guardedPath(root, path);
  if (!guarded.ok) return guarded;
  let bytes: Buffer;
  try { bytes = await readFile(guarded.value); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? fail(404, "Setup file not found") : fail(500, "Could not read setup file"); }
  if (bytes.length > MAX_SOURCE_BYTES) return fail(400, "Setup file exceeds 1 MiB limit");
  const parsed = parseSVM(bytes);
  if (!parsed.ok) return fail(400, `Invalid SVM${parsed.line === null ? "" : ` at line ${parsed.line}`}: ${parsed.error}`);
  return { ok: true, value: { bytes, parsed: parsed.document } };
}

export async function listLMUSetups() {
  const root = await canonicalRoot();
  if (!root) return { baseDir: null, tracks: [], files: [], error: "LMU Settings folder not found" };
  const tracks: { folder: string; trackId: string | null; trackName: string }[] = [];
  const files: { path: string; fileName: string; trackFolder: string; trackId: string | null; trackName: string; carId: string | null; carName: string | null; className: string | null; error: string | null }[] = [];
  const rootName = "";
  const addFile = async (absolute: string, trackFolder: string, trackId: string | null, trackName: string) => {
    const path = absolute.slice(root.realRoot.length + 1).split(sep).join("/");
    const fileName = basename(absolute);
    if (!fileName.toLowerCase().endsWith(".svm")) return;
    try {
      if (!isPathWithinSetupsFolder(await realpath(absolute), root.realRoot)) return;
      const bytes = await readFile(absolute);
      if (bytes.length > MAX_SOURCE_BYTES) { files.push({ path, fileName, trackFolder, trackId, trackName, carId: null, carName: null, className: null, error: "Setup file exceeds 1 MiB limit" }); return; }
      const parsed = parseSVM(bytes);
      files.push({ path, fileName, trackFolder, trackId, trackName, carId: parsed.ok ? parsed.document.carId : null, carName: parsed.ok ? parsed.document.carName : null, className: parsed.ok ? parsed.document.className : null, error: parsed.ok ? null : `${parsed.error}${parsed.line ? ` (line ${parsed.line})` : ""}` });
    } catch {
      files.push({ path, fileName, trackFolder, trackId, trackName, carId: null, carName: null, className: null, error: "Could not read setup file" });
    }
  };
  try {
    for (const entry of await readdir(root.realRoot, { withFileTypes: true })) {
      const absolute = join(root.realRoot, entry.name);
      let real: string;
      let kind: "file" | "directory";
      try {
        real = await realpath(absolute);
        if (!isPathWithinSetupsFolder(real, root.realRoot)) continue;
        const resolvedStat = await stat(real);
        if (resolvedStat.isFile()) kind = "file";
        else if (resolvedStat.isDirectory()) kind = "directory";
        else continue;
      } catch { continue; }
      if (kind === "file") await addFile(absolute, rootName, null, "Root");
      else {
        const track = resolveLMUTrack(entry.name);
        const trackId = track?.id ?? null;
        const trackName = track?.name ?? entry.name;
        tracks.push({ folder: entry.name, trackId, trackName });
        for (const child of await readdir(real, { withFileTypes: true })) {
          const childPath = join(absolute, child.name);
          try {
            const childReal = await realpath(childPath);
            if (isPathWithinSetupsFolder(childReal, root.realRoot) && (await stat(childReal)).isFile()) await addFile(childPath, entry.name, trackId, trackName);
          } catch { await addFile(childPath, entry.name, trackId, trackName); }
        }
      }
    }
  } catch { return { baseDir: root.root, tracks, files, error: "Could not read LMU Settings folder" }; }
  return { baseDir: root.root, tracks, files, error: null };
}

export async function getLMUSetupContent(path: string): Promise<Result<{ fileName: string; path: string; contentBase64: string; sha256: string }>> {
  const root = await canonicalRoot();
  if (!root) return fail(404, "LMU Settings folder not found");
  const file = await readValidFile(root, path);
  if (!file.ok) return file;
  return { ok: true, value: { fileName: basename(path), path, contentBase64: Buffer.from(file.value.bytes).toString("base64"), sha256: sha256(file.value.bytes) } };
}

export interface SaveLMUSetupInput {
  source: { kind: "file"; path: string; sha256: string } | { kind: "upload"; contentBase64: string; trackFolder: string };
  fileName: string;
  edits: SvmEdit[];
}

function checkedFileName(input: string): string | null {
  if (typeof input !== "string" || input.trim() !== input || sanitisePathSegment(input) !== input || !input || input === "." || input === ".." || /[\\/]/.test(input) || [...input].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127) || /[. ]$/.test(input)) return null;
  const extension = extname(input);
  const output = extension ? input : `${input}.svm`;
  if (extname(output).toLowerCase() !== ".svm" || output.length > 160 || basename(output) !== output) return null;
  const device = output.replace(/\.svm$/i, "").split(".")[0]!.toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/.test(device)) return null;
  return output;
}

async function saveExclusive(root: { root: string; realRoot: string }, trackFolder: string, fileName: string, bytes: Uint8Array): Promise<Result<{ fileName: string; path: string; contentBase64: string; sha256: string }>> {
  let parent = root.realRoot;
  let relative = fileName;
  if (trackFolder) {
    const checked = await guardedPath(root, trackFolder, true);
    if (!checked.ok) return checked;
    parent = checked.value;
    relative = `${trackFolder}/${fileName}`;
  }
  try {
    const freshParent = await realpath(parent);
    if (!isPathWithinSetupsFolder(freshParent, root.realRoot, true)) return fail(400, "Track folder must be inside LMU Settings");
    const target = join(freshParent, fileName);
    if (!isPathWithinSetupsFolder(target, root.realRoot)) return fail(400, "Target must be inside LMU Settings");
    let handle;
    try {
      handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return fail(409, "Setup file already exists; choose another name");
      throw error;
    }
    const created = await handle.stat();
    try { await handle.writeFile(bytes); await handle.sync(); }
    catch {
      await handle.close().catch(() => {});
      try {
        const current = await lstat(target);
        if (current.dev === created.dev && current.ino === created.ino) await rm(target);
      } catch { /* target disappeared or was replaced */ }
      return fail(500, "Could not write setup file");
    }
    await handle.close();
    return { ok: true, value: { fileName, path: relative, contentBase64: Buffer.from(bytes).toString("base64"), sha256: sha256(bytes) } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fail(404, trackFolder ? "Track folder not found" : "LMU Settings folder not found");
    return fail(500, "Could not save setup file");
  }
}

export async function saveLMUSetup(input: SaveLMUSetupInput): Promise<Result<{ fileName: string; path: string; contentBase64: string; sha256: string }>> {
  const root = await canonicalRoot();
  if (!root) return fail(404, "LMU Settings folder not found");
  const fileName = checkedFileName(input.fileName);
  if (!fileName) return fail(400, "Choose a valid .svm filename (maximum 160 characters)");
  if (!Array.isArray(input.edits) || input.edits.length === 0) return fail(400, "At least one nonzero setup edit is required");
  let document: SvmDocument;
  if (input.source.kind === "file") {
    const file = await readValidFile(root, input.source.path);
    if (!file.ok) return file;
    if (!/^[a-f0-9]{64}$/i.test(input.source.sha256) || sha256(file.value.bytes) !== input.source.sha256.toLowerCase()) return fail(409, "Source setup changed; reload it before saving");
    document = file.value.parsed;
  } else {
    const uploaded = validBase64(input.source.contentBase64);
    if (!uploaded) return fail(400, "Invalid base64 setup content");
    if (uploaded.length > MAX_SOURCE_BYTES) return fail(400, "Setup file exceeds 1 MiB limit");
    const parsed = parseSVM(uploaded);
    if (!parsed.ok) return fail(400, `Invalid SVM${parsed.line === null ? "" : ` at line ${parsed.line}`}: ${parsed.error}`);
    document = parsed.document;
    const folder = input.source.trackFolder;
    if (folder !== "") {
      const track = await guardedPath(root, folder, true);
      if (!track.ok) return track;
    }
  }
  try {
    for (const edit of input.edits) {
      const access = getSvmFieldAccess(document, edit.id);
      if (!access.editable) return fail(400, access.reason ?? `Field ${edit.id} is not editable`);
    }
    const output = writeSVM(document, input.edits);
    const trackFolder = input.source.kind === "file" ? input.source.path.split("/").slice(0, -1).join("/") : input.source.trackFolder;
    return saveExclusive(root, trackFolder, fileName, output);
  } catch (error) { return fail(400, error instanceof Error ? error.message : "Invalid SVM edit"); }
}
