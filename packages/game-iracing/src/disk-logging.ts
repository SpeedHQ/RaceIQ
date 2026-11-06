import { dlopen, FFIType, ptr, toArrayBuffer, type Library } from "bun:ffi";
import { join, resolve } from "node:path";

const HWND_BROADCAST = 0xffffn;
const TELEMETRY_COMMAND = 10;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const KF_FLAG_DONT_VERIFY = 0x4000;

const user32Symbols = {
  RegisterWindowMessageW: { args: [FFIType.ptr], returns: FFIType.u32 },
  SendNotifyMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.bool },
} as const;
const kernel32Symbols = {
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
  MoveFileW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  GetLastError: { args: [], returns: FFIType.u32 },
  lstrlenW: { args: [FFIType.u64], returns: FFIType.i32 },
} as const;
const shell32Symbols = {
  SHGetKnownFolderPath: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
} as const;
const ole32Symbols = {
  CoTaskMemFree: { args: [FFIType.u64], returns: FFIType.void },
} as const;

type User32Library = Library<typeof user32Symbols>;
type Kernel32Library = Library<typeof kernel32Symbols>;
type Shell32Library = Library<typeof shell32Symbols>;
type Ole32Library = Library<typeof ole32Symbols>;
let user32: User32Library | null = null;
let kernel32: Kernel32Library | null = null;
let shell32: Shell32Library | null = null;
let ole32: Ole32Library | null = null;
let broadcastMessage = 0;

function requireWindows(): void {
  if (process.platform !== "win32") throw new Error("Native iRacing disk capture requires Windows");
}

/** Uses the current user's Known Documents folder, including Windows redirection. */
export function resolveIRacingTelemetryDirectory(): string {
  requireWindows();
  const shell = shell32 ??= dlopen("shell32.dll", shell32Symbols);
  const kernel = kernel32 ??= dlopen("kernel32.dll", kernel32Symbols);
  const ole = ole32 ??= dlopen("ole32.dll", ole32Symbols);
  // FOLDERID_Documents: FDD39AD0-238F-46AF-ADB4-6C85480369C7, GUID memory order.
  const folderId = Buffer.from([0xd0, 0x9a, 0xd3, 0xfd, 0x8f, 0x23, 0xaf, 0x46, 0xad, 0xb4, 0x6c, 0x85, 0x48, 0x03, 0x69, 0xc7]);
  const output = Buffer.alloc(8);
  const result = shell.symbols.SHGetKnownFolderPath(ptr(folderId), KF_FLAG_DONT_VERIFY, 0n, ptr(output));
  const address = output.readBigUInt64LE(0);
  try {
    if (result < 0 || !address) throw new Error(`Windows Documents folder lookup failed (${result})`);
    const length = kernel.symbols.lstrlenW(address);
    if (length <= 0 || length > 32767) throw new Error("Windows Documents folder has an invalid path length");
    const documents = Buffer.from(toArrayBuffer(Number(address), 0, length * 2)).toString("utf16le");
    return join(documents, "iRacing", "telemetry");
  } finally {
    if (address) ole.symbols.CoTaskMemFree(address);
  }
}

/** Queues the SDK telemetry command; only SDK flags can confirm enabled/active logging. */
export function setIRacingDiskLogging(enabled: boolean): void {
  requireWindows();
  const user = user32 ??= dlopen("user32.dll", user32Symbols);
  if (!broadcastMessage) {
    const name = Buffer.from("IRSDK_BROADCASTMSG\0", "utf16le");
    broadcastMessage = user.symbols.RegisterWindowMessageW(ptr(name));
    if (!broadcastMessage) throw new Error("Unable to register the iRacing SDK broadcast message");
  }
  // SDK docs-linked pyirsdk: command in low word, stop=0/start=1 in high word.
  const command = BigInt(TELEMETRY_COMMAND | (enabled ? 1 << 16 : 0));
  if (!user.symbols.SendNotifyMessageW(HWND_BROADCAST, broadcastMessage, command, 0n)) {
    const kernel = kernel32 ??= dlopen("kernel32.dll", kernel32Symbols);
    throw new Error(`iRacing telemetry command failed (Windows error ${kernel.symbols.GetLastError()})`);
  }
}

function windowsFileName(path: string) {
  const absolute = resolve(path);
  const extended = absolute.startsWith("\\\\?\\") ? absolute
    : absolute.startsWith("\\\\") ? `\\\\?\\UNC\\${absolute.slice(2)}` : `\\\\?\\${absolute}`;
  return Buffer.from(`${extended}\0`, "utf16le");
}

/** A paused writer still owns its file; stable size alone is not evidence of completion. */
export function isIRacingTelemetryFileClosed(path: string): boolean {
  requireWindows();
  const kernel = kernel32 ??= dlopen("kernel32.dll", kernel32Symbols);
  const name = windowsFileName(path);
  const handle = BigInt(kernel.symbols.CreateFileW(ptr(name), 0x80000000, 0, null, 3, 0x80, 0n));
  if (!handle || handle === INVALID_HANDLE_VALUE) {
    const error = kernel.symbols.GetLastError();
    // Disappearance between scans and active writers are normal collection races.
    if (error === 2 || error === 3 || error === 32 || error === 33) return false;
    throw new Error(`Unable to probe iRacing telemetry file (Windows error ${error})`);
  }
  if (!kernel.symbols.CloseHandle(handle)) throw new Error("Unable to close the iRacing telemetry probe handle");
  return true;
}

/** Same-volume atomic publication without replacing any existing archive file. */
export function publishIRacingTelemetryFile(stage: string, destination: string): boolean {
  requireWindows();
  const kernel = kernel32 ??= dlopen("kernel32.dll", kernel32Symbols);
  const from = windowsFileName(stage);
  const to = windowsFileName(destination);
  if (kernel.symbols.MoveFileW(ptr(from), ptr(to))) return true;
  const error = kernel.symbols.GetLastError();
  if (error === 80 || error === 183) return false;
  throw new Error(`Unable to publish iRacing telemetry file (Windows error ${error})`);
}
