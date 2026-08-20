import type { SetupBackupStore } from "../integrations/google-drive/setup-backup-store";
import { buildSetupBackupArchive, parseSetupBackupArchive, renameSetupBackupArchive } from "./backup-archive";
import { readLocalSetupFile, writeLocalSetupFile, type LocalSetupFile, type LocalSetupWriteResult } from "./local-files";
import type { SetupBackupListItem, SetupGameId } from "../../shared/racing/setups/backup";
export interface BackupService {
  listBackups(gameId: SetupGameId): Promise<SetupBackupListItem[]>;
  backupLocalSetup(input: { gameId: SetupGameId; localPath: string; conflict: "error" | "replace" | "copy" }): Promise<{ id: string }>;
  renameBackup(input: { gameId: SetupGameId; backupId: string; name: string; conflict: "error" | "replace" | "copy" }): Promise<{ id: string; name: string }>;
  restoreBackup(input: { gameId: SetupGameId; backupId: string; conflict: "error" | "replace" | "copy" }): Promise<LocalSetupWriteResult>;
  deleteBackup(input: { gameId: SetupGameId; backupId: string }): Promise<{ deleted: boolean }>;
}

export type BackupServiceDeps = { store: SetupBackupStore; clock?: () => Date; local?: { read: typeof readLocalSetupFile; write: typeof writeLocalSetupFile } };
function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof Error) return error.message;
  return undefined;
}
function codeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}
const stem = (name: string) => name.replace(/\.[^.]+$/, "");
function validItems(items: SetupBackupListItem[]) { return items.filter((i): i is Extract<SetupBackupListItem, { valid: true }> => i.valid); }
function findName(items: SetupBackupListItem[], gameId: SetupGameId, carId: string, trackId: string, name: string) { return validItems(items).find(i => i.gameId === gameId && i.carId.toLowerCase() === carId.toLowerCase() && i.trackId.toLowerCase() === trackId.toLowerCase() && i.setupName.toLowerCase() === name.toLowerCase()); }
function copyName(items: SetupBackupListItem[], gameId: SetupGameId, carId: string, trackId: string, name: string) { let n = 2; while (findName(items, gameId, carId, trackId, `${name} (${n})`)) n++; return `${name} (${n})`; }

export function createBackupService(deps: BackupServiceDeps) {
  const clock = deps.clock ?? (() => new Date()); const local = deps.local ?? { read: readLocalSetupFile, write: writeLocalSetupFile };
  async function listBackups(gameId: SetupGameId) { return deps.store.list(gameId); }
  async function backupLocalSetup(input: { gameId: SetupGameId; localPath: string; conflict: "error" | "replace" | "copy" }) {
    let file: LocalSetupFile;
    try { file = await local.read(input.gameId, input.localPath); }
    catch (error) {
      const code = errorCode(error);
      throw codeError(code?.includes("setup-folder") ? "setup-folder-missing" : code === "local-setup-not-found" ? code : "local-setup-not-found");
    }
    const items = await listBackups(input.gameId); const existing = findName(items, input.gameId, file.carId, file.trackId, stem(file.fileName));
    if (existing && input.conflict === "error") throw codeError("duplicate-name");
    const name = existing && input.conflict === "copy" ? copyName(items, input.gameId, file.carId, file.trackId, stem(file.fileName)) : stem(file.fileName);
    const now = clock().toISOString(); const manifest = { schemaVersion: 1 as const, gameId: input.gameId, carId: file.carId, trackId: file.trackId, setupName: name, nativeFormat: file.nativeFormat, createdAt: now, updatedAt: now };
    const archive = buildSetupBackupArchive({ manifest, payload: file.bytes });
    return deps.store.upload({ gameId: input.gameId, carId: file.carId, trackId: file.trackId, fileName: `${name}${".raceiq-setup.zip"}`, bytes: archive, existingId: existing && input.conflict === "replace" ? existing.id : undefined });
  }
  async function renameBackup(input: { gameId: SetupGameId; backupId: string; name: string; conflict: "error" | "replace" | "copy" }) {
    const items = await listBackups(input.gameId); const source = validItems(items).find(i => i.id === input.backupId); if (!source) throw codeError("backup-not-found");
    let name = input.name; const target = findName(items, input.gameId, source.carId, source.trackId, name);
    if (target && target.id !== source.id) { if (input.conflict === "error") throw codeError("duplicate-name"); if (input.conflict === "copy") name = copyName(items, input.gameId, source.carId, source.trackId, name); }
    const archive = renameSetupBackupArchive(await deps.store.download(input.gameId, source.id), name, clock().toISOString());
    await deps.store.update(input.gameId, source.id, `${name}.raceiq-setup.zip`, archive);
    if (target && target.id !== source.id && input.conflict === "replace") await deps.store.delete(input.gameId, target.id);
    return { id: source.id, name };
  }
  async function restoreBackup(input: { gameId: SetupGameId; backupId: string; conflict: "error" | "replace" | "copy" }) {
    const items = await listBackups(input.gameId); const item = validItems(items).find(i => i.id === input.backupId); if (!item) throw codeError("backup-not-found");
    if (item.gameId !== input.gameId) throw codeError("binding-mismatch");
    const parsed = parseSetupBackupArchive(await deps.store.download(input.gameId, input.backupId)); const file = parsed.manifest.files[0]!; const bytes = parsed.files[file.path];
    if (parsed.manifest.gameId !== input.gameId || parsed.manifest.nativeFormat !== item.nativeFormat || parsed.manifest.carId !== item.carId || parsed.manifest.trackId !== item.trackId) throw codeError("binding-mismatch");
    return local.write({ gameId: input.gameId, carId: parsed.manifest.carId, trackId: parsed.manifest.trackId, setupName: parsed.manifest.setupName, nativeFormat: parsed.manifest.nativeFormat, bytes, conflict: input.conflict });
  }
  async function deleteBackup(input: { gameId: SetupGameId; backupId: string }) { await deps.store.delete(input.gameId, input.backupId); return { deleted: true }; }
  return { listBackups, backupLocalSetup, renameBackup, restoreBackup, deleteBackup };
}
