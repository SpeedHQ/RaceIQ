import { z } from "zod";
import type { SetupGameId, SetupNativeFormat } from "./file-formats";

export const SETUP_BACKUP_SCHEMA_VERSION = 1 as const;
export const SETUP_BACKUP_ARCHIVE_EXTENSION = ".raceiq-setup.zip" as const;

export const SetupConflictPolicySchema = z.enum(["error", "replace", "copy"]);
const isoDate = z.string().datetime({ offset: true });
const fileSchema = z.strictObject({
  path: z.string().min(1).max(240),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const SetupBackupManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(SETUP_BACKUP_SCHEMA_VERSION),
  gameId: z.enum(["acc", "ac-evo"]),
  carId: z.string().min(1),
  trackId: z.string().min(1),
  setupName: z.string().min(1),
  nativeFormat: z.enum(["acc-json", "ac-evo-carsetup"]),
  createdAt: isoDate,
  updatedAt: isoDate,
  files: z.array(fileSchema).min(1).max(16),
});
export type SetupBackupManifestV1 = z.infer<typeof SetupBackupManifestV1Schema>;
export type SetupBackupListItem =
  | ({ valid: true; id: string; driveFileName: string } & SetupBackupManifestV1)
  | { valid: false; id: string; driveFileName: string; code: SetupBackupErrorCode; error: string };
export const SetupBackupErrorCodeSchema = z.enum([
  "drive-not-configured", "drive-disconnected", "drive-unavailable", "setup-folder-missing",
  "local-setup-not-found", "backup-not-found", "duplicate-name", "invalid-name", "invalid-archive",
  "invalid-manifest", "unsupported-schema", "unsupported-format", "binding-mismatch",
]);
export type SetupBackupErrorCode = z.infer<typeof SetupBackupErrorCodeSchema>;
export class SetupBackupArchiveError extends Error {
  public readonly code: SetupBackupErrorCode;
  constructor(code: SetupBackupErrorCode, message: string) { super(message); this.code = code; this.name = "SetupBackupArchiveError"; }
}

export type { SetupGameId, SetupNativeFormat };
