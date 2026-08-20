import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { createHash } from "node:crypto";
import { parseCarSetup } from "../games/ac-evo/carsetup-wire";
import { AccSetupJsonSchema, setupFileFormat, setupNativeFormat } from "../../shared/racing/setups/file-formats";
import { SetupBackupManifestV1Schema, SETUP_BACKUP_SCHEMA_VERSION, type SetupBackupManifestV1, type SetupGameId, type SetupNativeFormat, SetupBackupArchiveError } from "../../shared/racing/setups/backup";

export type SetupBackupArchive = { manifest: SetupBackupManifestV1; files: Record<string, Buffer> };
type BuildInput = { manifest: SetupBackupManifestV1; files: Record<string, Buffer> } | { manifest: Omit<SetupBackupManifestV1, "files">; payload: Buffer };
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const fail = (code: ConstructorParameters<typeof SetupBackupArchiveError>[0], msg: string): never => { throw new SetupBackupArchiveError(code, msg); };
function validMemberPath(path: string) {
  return path.length > 0
    && !path.startsWith("/")
    && !path.startsWith("\\")
    && !/^[A-Za-z]:/.test(path)
    && !path.includes("\\")
    && !path.split("/").some((p) => p === ".." || p === "");
}
function validateSetupName(setupName: string) {
  if (setupName.length === 0 || setupName === "." || setupName === ".." || setupName.length > 120
    || /[\\/<>"|?*:]/.test(setupName) || Array.from(setupName).some((character) => character.charCodeAt(0) <= 0x1f) || /[. ]$/.test(setupName)
    || /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(setupName)) {
    fail("invalid-name", "invalid setup name");
  }
}
function validatePayload(gameId: SetupGameId, format: SetupNativeFormat, bytes: Buffer) {
  if (format !== setupNativeFormat(gameId)) fail("unsupported-format", "native format does not match game");
  if (gameId === "acc") { let value: unknown; try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("invalid-archive", "invalid JSON payload"); } if (!AccSetupJsonSchema.safeParse(value).success) fail("invalid-archive", "invalid ACC setup payload"); }
  else { const parsed = parseCarSetup(bytes); if (!parsed || parsed.raw.length === 0) fail("invalid-archive", "invalid AC EVO setup payload"); }
}
export function buildSetupBackupArchive(input: BuildInput): Buffer {
  const base = input.manifest as SetupBackupManifestV1;
  const candidate: SetupBackupManifestV1 = "payload" in input
    ? { ...base, files: [{ path: `${base.setupName}${setupFileFormat(base.gameId).extension}`, size: input.payload.length, sha256: sha256(input.payload) }] }
    : base;
  const parsed = SetupBackupManifestV1Schema.safeParse(candidate);
  if (!parsed.success) fail("invalid-manifest", "manifest does not match schema");
  const manifest = parsed.data as SetupBackupManifestV1;
  const files: Record<string, Buffer> = "payload" in input ? { [manifest.files[0]!.path]: input.payload } : input.files;
  const entries: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest)) };
  for (const f of manifest.files) {
    const bytes = files[f.path];
    if (!bytes) fail("invalid-archive", `missing payload ${f.path}`);
    validatePayload(manifest.gameId, manifest.nativeFormat, bytes);
    if (bytes.length !== f.size || sha256(bytes) !== f.sha256) fail("invalid-archive", "payload integrity mismatch");
    entries[`files/${f.path}`] = bytes;
  }
  return Buffer.from(zipSync(entries));
}
export function parseSetupBackupArchive(bytes: Buffer): SetupBackupArchive {
  let zip: Record<string, Uint8Array>; try { zip = unzipSync(bytes); } catch { return fail("invalid-archive", "unreadable ZIP"); }
  const names = Object.keys(zip); if (names.filter((n) => n === "manifest.json").length !== 1 || names.some((n) => n !== "manifest.json" && !n.startsWith("files/"))) fail("invalid-archive", "unexpected archive members");
  let raw: unknown;
  try { raw = JSON.parse(strFromU8(zip["manifest.json"]!)); } catch { return fail("invalid-manifest", "malformed manifest"); }
  const schemaVersion = raw && typeof raw === "object" && "schemaVersion" in raw ? raw.schemaVersion : undefined;
  if (schemaVersion !== SETUP_BACKUP_SCHEMA_VERSION) fail("unsupported-schema", "unsupported schema");
  const checked = SetupBackupManifestV1Schema.safeParse(raw); if (!checked.success) fail("invalid-manifest", "invalid manifest");
  const manifest = checked.data as SetupBackupManifestV1; const paths = new Set<string>(); const files: Record<string, Buffer> = {};
  for (const f of manifest.files) { if (paths.has(f.path) || !validMemberPath(f.path)) fail("invalid-archive", "invalid member path"); paths.add(f.path); const member = zip[`files/${f.path}`]; if (!member) fail("invalid-archive", "missing payload"); const payload = Buffer.from(member); if (payload.length !== f.size || sha256(payload) !== f.sha256) fail("invalid-archive", "payload integrity mismatch"); validatePayload(manifest.gameId, manifest.nativeFormat, payload); files[f.path] = payload; }
  const declared = new Set(manifest.files.map((f) => `files/${f.path}`)); if (names.some((n) => n !== "manifest.json" && !declared.has(n))) fail("invalid-archive", "undeclared payload");
  return { manifest, files };
}
export function renameSetupBackupArchive(bytes: Buffer, setupName: string, updatedAt = new Date().toISOString()): Buffer {
  validateSetupName(setupName);
  const archive = parseSetupBackupArchive(bytes);
  const old = archive.manifest.files;
  if (old.length !== 1) fail("invalid-archive", "expected one setup payload");
  const ext = setupFileFormat(archive.manifest.gameId).extension;
  const path = `${setupName}${ext}`;
  const manifest: SetupBackupManifestV1 = { ...archive.manifest, setupName, updatedAt, files: [{ ...old[0]!, path }] };
  return buildSetupBackupArchive({ manifest, files: { [path]: archive.files[old[0]!.path]! } });
}
