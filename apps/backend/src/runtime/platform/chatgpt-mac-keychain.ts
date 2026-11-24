import { createHash } from "node:crypto";

const helper = String.raw`
import Foundation
import Security
let input = FileHandle.standardInput.readDataToEndOfFile()
let account = CommandLine.arguments.last!
let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: "RaceIQ.ChatGPTSubscription", kSecAttrAccount as String: account]
if input.isEmpty {
  var query = key
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var stored: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &stored)
  if status == errSecItemNotFound { exit(0) }
  guard status == errSecSuccess, let data = stored as? Data else { exit(1) }
  FileHandle.standardOutput.write(data)
} else {
  let update = [kSecValueData as String: input]
  var status = SecItemUpdate(key as CFDictionary, update as CFDictionary)
  if status == errSecItemNotFound {
    var newItem = key
    newItem[kSecValueData as String] = input
    status = SecItemAdd(newItem as CFDictionary, nil)
  }
  exit(status == errSecSuccess ? 0 : 1)
}
`;

export function createChatGptMacKeychain(canonicalDataDir: string) {
  const account = createHash("sha256").update(canonicalDataDir).digest("hex");
  async function run(input: Buffer | "ignore") {
    try {
      const child = Bun.spawn(["/usr/bin/swift", "-e", helper, account], {
        stdin: input, stdout: "pipe", stderr: "ignore", timeout: 30_000,
      });
      const [exit, data] = await Promise.all([child.exited, new Response(child.stdout).bytes()]);
      if (exit !== 0 || data.length > 1024 * 1024) throw new Error();
      return data;
    } catch {
      throw new Error("storage_failed");
    }
  }
  return {
    async read() {
      const data = await run("ignore");
      return data.length ? data : null;
    },
    async replace(data: Uint8Array) {
      if (!data.length || data.length > 1024 * 1024) throw new Error("storage_failed");
      await run(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    },
  };
}
