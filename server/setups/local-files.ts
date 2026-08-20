import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";
import { AccSetupJsonSchema, setupFileFormat, setupNativeFormat, type SetupGameId, type SetupNativeFormat } from "../../shared/racing/setups/file-formats";
import { parseCarSetup } from "../games/ac-evo/carsetup-wire";
import { getSetupsBaseDir, isPathWithinSetupsFolder, resolveGuardedSetupFile } from "./file-guard";

export interface SetupFileListing { carModel: string; trackName: string; fileName: string; absolutePath: string; }
export interface LocalSetupFile { gameId: SetupGameId; carId: string; trackId: string; fileName: string; absolutePath: string; nativeFormat: SetupNativeFormat; bytes: Buffer; }
export interface LocalSetupWriteResult { gameId: SetupGameId; carId: string; trackId: string; fileName: string; absolutePath: string; nativeFormat: SetupNativeFormat; bytes: Buffer; placed: boolean; }
const writeLocks = new Map<string, Promise<void>>();


export function sanitisePathSegment(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || '<>:"/\\|?*'.includes(character)) continue;
    safe += character;
  }
  return safe.trim();
}

export function validateSetupPathSegment(value: string, label: "car" | "track" | "setup"): string {
  if (value.length === 0 || value === "." || value === ".." || value.length > 120 || /[\\/<>"|?*:]/.test(value) || Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f) || /[. ]$/.test(value)) throw new Error(`invalid-name:${label}`);
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)) throw new Error(`invalid-name:${label}`);
  return value;
}

export function listSetupFiles(baseDir: string): SetupFileListing[] {
  const out: SetupFileListing[] = [];
  let cars: string[]; try { cars = readdirSync(baseDir).filter((name) => statSync(resolve(baseDir, name)).isDirectory()); } catch { return out; }
  for (const carModel of cars) {
    const carPath = resolve(baseDir, carModel); let tracks: string[]; try { tracks = readdirSync(carPath).filter((name) => statSync(resolve(carPath, name)).isDirectory()); } catch { continue; }
    for (const trackName of tracks) {
      const trackPath = resolve(carPath, trackName); let files: string[]; try { files = readdirSync(trackPath).filter((name) => /\.(json|carsetup)$/i.test(name)); } catch { continue; }
      for (const fileName of files) out.push({ carModel, trackName, fileName, absolutePath: resolve(trackPath, fileName) });
    }
  }
  return out;
}

export async function readLocalSetupFile(gameId: SetupGameId, absolutePath: string): Promise<LocalSetupFile> {
  const guarded = await resolveGuardedSetupFile(gameId, absolutePath);
  if (!guarded.ok) throw new Error(guarded.error);
  const base = realpathSync(resolve(guarded.baseDir)); const relative = guarded.realPath.slice(base.length + 1).split(sep);
  if (relative.length !== 3) throw new Error("invalid-name:path");
  const [carId, trackId, fileName] = relative; validateSetupPathSegment(carId, "car"); validateSetupPathSegment(trackId, "track");
  const format = setupFileFormat(gameId); if (!fileName.toLowerCase().endsWith(format.extension)) throw new Error("unsupported-format");
  const stem = fileName.slice(0, -format.extension.length); validateSetupPathSegment(stem, "setup");
  if (gameId === "acc") { const parsed = AccSetupJsonSchema.safeParse(JSON.parse(guarded.bytes.toString("utf8"))); if (!parsed.success) throw new Error("invalid-setup"); }
  else { const parsed = parseCarSetup(guarded.bytes); if (!parsed || parsed.raw.length === 0) throw new Error("invalid-setup"); }
  return { gameId, carId, trackId, fileName, absolutePath: guarded.realPath, nativeFormat: setupNativeFormat(gameId), bytes: guarded.bytes };
}
export async function writeLocalSetupFile(input: { gameId: SetupGameId; carId: string; trackId: string; setupName: string; nativeFormat: SetupNativeFormat; bytes: Buffer; conflict: "error" | "replace" | "copy" | "keep" }): Promise<LocalSetupWriteResult> {
  const key = `${input.gameId}/${input.carId.toLowerCase()}/${input.trackId.toLowerCase()}`;
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  writeLocks.set(key, current);
  await previous;
  try { return await writeLocalSetupFileUnlocked(input); } finally { release(); if (writeLocks.get(key) === current) writeLocks.delete(key); }
}

async function writeLocalSetupFileUnlocked(input: { gameId: SetupGameId; carId: string; trackId: string; setupName: string; nativeFormat: SetupNativeFormat; bytes: Buffer; conflict: "error" | "replace" | "copy" | "keep" }): Promise<LocalSetupWriteResult> {
  validateSetupPathSegment(input.carId, "car"); validateSetupPathSegment(input.trackId, "track"); validateSetupPathSegment(input.setupName, "setup");
  if (input.nativeFormat !== setupNativeFormat(input.gameId)) throw new Error("unsupported-format");
  if (input.gameId === "acc") { const parsed = AccSetupJsonSchema.safeParse(JSON.parse(input.bytes.toString("utf8"))); if (!parsed.success) throw new Error("invalid-setup"); }
  else { const parsed = parseCarSetup(input.bytes); if (!parsed || parsed.raw.length === 0) throw new Error("invalid-setup"); }
  const baseDir = await getSetupsBaseDir(input.gameId, { create: true }); if (!baseDir) throw new Error("setup-folder-missing");
  const realBase = realpathSync(resolve(baseDir)); const dir = resolve(realBase, input.carId, input.trackId); mkdirSync(dir, { recursive: true });
  const realDir = realpathSync(dir);
  if (!isPathWithinSetupsFolder(realDir, realBase)) throw new Error("invalid-name:path");
  const extension = setupFileFormat(input.gameId).extension; let stem = input.setupName; let target = resolve(realDir, `${stem}${extension}`);
  const existingNames = () => new Set(readdirSync(realDir).map((file) => file.toLowerCase()));
  const existing = [...existingNames()].find((file) => file === `${stem}${extension}`.toLowerCase());
  if (existing) { const actual = readdirSync(realDir).find((file) => file.toLowerCase() === existing) ?? existing; if (input.conflict === "error") throw new Error("duplicate-name"); if (input.conflict === "keep") return { gameId: input.gameId, carId: input.carId, trackId: input.trackId, fileName: actual, absolutePath: resolve(realDir, actual), nativeFormat: input.nativeFormat, bytes: input.bytes, placed: false }; if (input.conflict === "replace") target = resolve(realDir, actual); if (input.conflict === "copy") { let n = 2; let names = existingNames(); while (names.has(`${stem}${extension}`.toLowerCase())) { stem = `${input.setupName} (${n++})`; target = resolve(realDir, `${stem}${extension}`); names = existingNames(); } } }
  const temp = `${target}.raceiq-${randomBytes(8).toString("hex")}.tmp`; writeFileSync(temp, input.bytes); renameSync(temp, target);
  return { gameId: input.gameId, carId: input.carId, trackId: input.trackId, fileName: target.slice(target.lastIndexOf(sep) + 1), absolutePath: target, nativeFormat: input.nativeFormat, bytes: input.bytes, placed: true };
}
