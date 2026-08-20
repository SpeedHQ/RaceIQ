import { Readable } from "node:stream";
import { drive } from "@googleapis/drive";
import type { drive_v3 } from "@googleapis/drive";
import { parseSetupBackupArchive } from "../../setups/backup-archive";
import type { SetupBackupListItem, SetupGameId } from "../../../shared/racing/setups/backup";
import { getAuthorizedClient } from "./auth";

type FileRef = drive_v3.Schema$File;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const APP_PROPS = { raceiq: "setup-backup", raceiqKind: "setup-archive" };
type DriveApi = ReturnType<typeof drive>;
function isDomainError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "drive-unavailable" || error.code === "drive-disconnected" || error.code === "backup-not-found";
}
function isDriveFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("response" in error) return true;
  if ("code" in error && (error.code === "ENOTFOUND" || error.code === "ECONNRESET" || error.code === "ETIMEDOUT" || typeof error.code === "number")) return true;
  return false;
}
export type SetupBackupStore = { list(gameId: SetupGameId): Promise<SetupBackupListItem[]>; upload(input: { gameId: SetupGameId; carId: string; trackId: string; fileName: string; bytes: Buffer; existingId?: string }): Promise<{ id: string }>; download(gameId: SetupGameId, id: string): Promise<Buffer>; update(gameId: SetupGameId, id: string, fileName: string, bytes: Buffer): Promise<void>; delete(gameId: SetupGameId, id: string): Promise<void> };
export type SetupBackupStoreDeps = { driveFactory?: (authClient: Awaited<ReturnType<typeof getAuthorizedClient>>) => DriveApi; authClient?: Awaited<ReturnType<typeof getAuthorizedClient>> };
function owned(file: FileRef): boolean { return file.appProperties?.raceiq === APP_PROPS.raceiq && file.appProperties?.raceiqKind === APP_PROPS.raceiqKind && !!file.id; }
function driveError(error: unknown): Error { const status = typeof error === "object" && error && "response" in error && typeof error.response === "object" && error.response && "status" in error.response ? error.response.status : typeof error === "object" && error && "code" in error ? error.code : undefined; if (status === 401) return Object.assign(new Error("Google Drive is disconnected"), { code: "drive-disconnected" }); if (status === 404) return Object.assign(new Error("Google Drive backup not found"), { code: "backup-not-found" }); return Object.assign(new Error("Google Drive is temporarily unavailable"), { code: "drive-unavailable" }); }

export function createSetupBackupStore(deps: SetupBackupStoreDeps = {}): SetupBackupStore {
  let apiPromise: Promise<DriveApi> | undefined;
  async function api(): Promise<DriveApi> { return apiPromise ??= (async () => { const authClient = deps.authClient ?? await getAuthorizedClient(); return (deps.driveFactory ?? ((a) => drive({ version: "v3", auth: a })))(authClient); })(); }
  async function children(parentId: string): Promise<FileRef[]> { const result: FileRef[] = []; let pageToken: string | undefined; do { const page = await (await api()).files.list({ q: `'${parentId}' in parents and trashed = false`, pageSize: 100, pageToken, fields: "nextPageToken,files(id,name,mimeType,appProperties,parents)" }); result.push(...((page.data.files ?? []) as FileRef[])); pageToken = page.data.nextPageToken ?? undefined; } while (pageToken); return result; }
  async function findFolder(parentId: string | undefined, name: string): Promise<string> { const files = await children(parentId ?? "root"); const found = files.find((f) => f.mimeType === FOLDER_MIME && f.name === name); if (found?.id) return found.id; const created = await (await api()).files.create({ requestBody: { name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined, appProperties: APP_PROPS }, fields: "id" }); if (!created.data.id) throw new Error("Google Drive folder creation failed"); return created.data.id; }
  async function hierarchy(gameId: SetupGameId, carId?: string, trackId?: string): Promise<string> { let id = await findFolder(undefined, "RaceIQ"); id = await findFolder(id, "Setups"); id = await findFolder(id, gameId); if (carId) id = await findFolder(id, carId); if (trackId) id = await findFolder(id, trackId); return id; }
  async function descendants(parent: string): Promise<FileRef[]> { const direct = await children(parent); const nested = await Promise.all(direct.filter((f) => f.mimeType === FOLDER_MIME && f.id).map((f) => descendants(f.id!))); return direct.concat(nested.flat()); }
  async function ownedFile(gameId: SetupGameId, id: string): Promise<FileRef> { const file = (await (await api()).files.get({ fileId: id, fields: "id,name,mimeType,appProperties,parents" })).data as FileRef; if (!owned(file)) throw Object.assign(new Error("Google Drive backup not found"), { code: "backup-not-found" }); const gameFolder = await hierarchy(gameId); if (!(await descendants(gameFolder)).some((f) => f.id === id)) throw Object.assign(new Error("Google Drive backup not found"), { code: "backup-not-found" }); return file; }
  return {
    async list(gameId) {
      try {
        const gameFolder = await hierarchy(gameId);
        const files = (await descendants(gameFolder)).filter((f) => f.mimeType !== FOLDER_MIME && owned(f));
        const output: SetupBackupListItem[] = [];
        for (const file of files) {
          try {
            const parsed = parseSetupBackupArchive(await this.download(gameId, file.id!));
            output.push({ valid: true, id: file.id!, driveFileName: file.name ?? "", ...parsed.manifest });
          } catch (error) {
            if (error instanceof Error && "code" in error && (error.code === "drive-unavailable" || error.code === "drive-disconnected" || error.code === "backup-not-found")) throw error;
            if (error && typeof error === "object" && "response" in error) throw driveError(error);
            if (isDriveFailure(error)) throw driveError(error);
            const candidate = error as { code?: unknown };
            const code = typeof candidate.code === "string" ? candidate.code : "invalid-archive";
            output.push({ valid: false, id: file.id!, driveFileName: file.name ?? "", code: code as any, error: error instanceof Error ? error.message : "Invalid backup archive" });
          }
        }
        return output;
      } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "drive-unavailable" || error.code === "drive-disconnected" || error.code === "backup-not-found")) throw error;
        throw driveError(error);
      }
    },
    async upload(input) { try { const parent = input.existingId ? undefined : await hierarchy(input.gameId, input.carId, input.trackId); if (input.existingId) await ownedFile(input.gameId, input.existingId); const body = Readable.from([input.bytes]); const result = input.existingId ? await (await api()).files.update({ fileId: input.existingId, requestBody: { name: input.fileName, mimeType: "application/zip", appProperties: APP_PROPS }, media: { mimeType: "application/zip", body }, fields: "id" }) : await (await api()).files.create({ requestBody: { name: input.fileName, parents: [parent!], mimeType: "application/zip", appProperties: APP_PROPS }, media: { mimeType: "application/zip", body }, fields: "id" }); if (!result.data.id) throw new Error("Google Drive upload failed"); return { id: result.data.id }; } catch (error) { if (isDomainError(error)) throw error; throw driveError(error); } },
    async download(gameId, id) { try { await ownedFile(gameId, id); const result = await (await api()).files.get({ fileId: id, alt: "media" }, { responseType: "arraybuffer" }); return Buffer.from(result.data as ArrayBuffer); } catch (error) { if (isDomainError(error)) throw error; throw driveError(error); } },
    async update(gameId, id, fileName, bytes) { await this.upload({ gameId, carId: "", trackId: "", fileName, bytes, existingId: id }); },
    async delete(gameId, id) { try { await ownedFile(gameId, id); await (await api()).files.delete({ fileId: id }); } catch (error) { if (isDomainError(error)) throw error; throw driveError(error); } },
  };
}
