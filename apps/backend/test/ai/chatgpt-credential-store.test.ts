import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChatGptCredentialStore,
  windowsChatGptCredentialCipher,
} from "../../src/runtime/platform/chatgpt-credential-store";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("replacement persists only protected bytes and retains the old record when protection fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-chatgpt-"));
  const protectedRecord = encoder.encode("protected bytes");
  let failed = false;
  const cipher = {
    async protect(value: Uint8Array) {
      if (failed) throw new Error("secret-bearing diagnostic");
      expect(decoder.decode(value)).toBe("renewable secret");
      return protectedRecord;
    },
    async unprotect(value: Uint8Array) {
      expect(decoder.decode(value)).toBe(decoder.decode(protectedRecord));
      return encoder.encode("renewable secret");
    },
  };
  try {
    const store = createChatGptCredentialStore(directory, cipher);
    expect(await store.read()).toBeNull();
    await store.replace(encoder.encode("renewable secret"));
    failed = true;
    await expect(store.replace(encoder.encode("rotated secret"))).rejects.toThrow(/^storage_failed$/);
    const recordDirectory = join(directory, "chatgpt-subscription");
    expect(await readdir(recordDirectory)).toEqual(["credentials.dpapi"]);
    expect(await readFile(join(recordDirectory, "credentials.dpapi"), "utf8")).toBe("protected bytes");
    const reopened = createChatGptCredentialStore(directory, cipher);
    expect(decoder.decode((await reopened.read())!)).toBe("renewable secret");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("Windows DPAPI protects, reopens and rotates the actual credential file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-chatgpt-dpapi-"));
  try {
    const firstCipher = windowsChatGptCredentialCipher();
    if (!firstCipher) throw new Error("Windows credential protection unavailable");
    const store = createChatGptCredentialStore(directory, firstCipher);
    await store.replace(encoder.encode("first refresh token"));
    expect(await readFile(join(directory, "chatgpt-subscription", "credentials.dpapi"), "utf8")).not.toContain("first refresh token");
    const secondCipher = windowsChatGptCredentialCipher();
    if (!secondCipher) throw new Error("Windows credential protection unavailable");
    const reopened = createChatGptCredentialStore(directory, secondCipher);
    expect(decoder.decode((await reopened.read())!)).toBe("first refresh token");
    await reopened.replace(encoder.encode("rotated refresh token"));
    expect(decoder.decode((await store.read())!)).toBe("rotated refresh token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
