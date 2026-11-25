import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { randomUUID } from "node:crypto";

const maxRecordSize = 1024 * 1024;
const dpapi = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$source = [IO.MemoryStream]::new()
[Console]::OpenStandardInput().CopyTo($source)
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
$entropy = [Text.Encoding]::UTF8.GetBytes('RaceIQ.ChatGPTSubscription.v1')
`;

export interface ChatGptCredentialCipher {
  protect(plaintext: Uint8Array): Promise<Uint8Array>;
  unprotect(ciphertext: Uint8Array): Promise<Uint8Array>;
}

export function windowsChatGptCredentialCipher(): ChatGptCredentialCipher | null {
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== "win32" || !systemRoot || !win32.isAbsolute(systemRoot)) return null;
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  async function transform(operation: "Protect" | "Unprotect", input: Uint8Array) {
    const script = `${dpapi}
$result = [Security.Cryptography.ProtectedData]::${operation}($source.ToArray(), $entropy, $scope)
[Console]::OpenStandardOutput().Write($result, 0, $result.Length)
`;
    const child = Bun.spawn([powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdin: Buffer.from(input.buffer, input.byteOffset, input.byteLength), stdout: "pipe", stderr: "ignore",
      windowsHide: true, timeout: 5000,
    });
    const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).bytes()]);
    if (exit !== 0 || output.length === 0 || output.length > maxRecordSize) throw new Error("storage_failed");
    return output;
  }

  return { protect: (input) => transform("Protect", input), unprotect: (input) => transform("Unprotect", input) };
}

export function createChatGptCredentialStore(dataDir: string, cipher: ChatGptCredentialCipher) {
  const filename = join(dataDir, "chatgpt-subscription", "credentials.dpapi");

  return {
    async read(): Promise<Uint8Array | null> {
      let input: Buffer;
      try {
        input = await readFile(filename);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error("storage_failed");
      }
      try {
        if (input.length === 0 || input.length > maxRecordSize) throw new Error("storage_failed");
        const plaintext = await cipher.unprotect(input);
        if (plaintext.length === 0 || plaintext.length > maxRecordSize) throw new Error("storage_failed");
        return plaintext;
      } catch {
        throw new Error("storage_failed");
      }
    },
    async replace(plaintext: Uint8Array) {
      const temp = `${filename}.${randomUUID()}.tmp`;
      try {
        if (plaintext.length === 0 || plaintext.length > maxRecordSize) throw new Error("storage_failed");
        const ciphertext = await cipher.protect(plaintext);
        if (ciphertext.length === 0 || ciphertext.length > maxRecordSize) throw new Error("storage_failed");
        await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
        const file = await open(temp, "wx", 0o600);
        try {
          await file.writeFile(ciphertext);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temp, filename);
      } catch {
        await rm(temp, { force: true }).catch(() => undefined);
        throw new Error("storage_failed");
      }
    },
  };
}
