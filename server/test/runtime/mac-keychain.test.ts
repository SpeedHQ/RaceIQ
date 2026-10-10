import { describe, expect, test } from "bun:test";
import { createMacKeychain } from "../../runtime/platform/mac-keychain";

describe("macOS credential arguments", () => {
  test("passes shell metacharacters literally without invoking a shell", () => {
    const calls: { file: string; args: string[]; shell: unknown }[] = [];
    const keychain = createMacKeychain((file, args, options) => {
      calls.push({ file, args, shell: options.shell });
      return "stored-value\n";
    });
    const account = 'provider"; $(printf account); `printf account`-api-key';
    const secret = 'key" $HOME $(printf secret) `printf secret` \\ end';
    keychain.set(account, secret);
    expect(keychain.get(account)).toBe("stored-value");
    keychain.delete(account);
    expect(calls.map((c) => c.file)).toEqual(Array(3).fill("/usr/bin/security"));
    expect(calls.every((c) => !c.shell)).toBe(true);
    expect(calls[0].args).toEqual(["add-generic-password", "-U", "-s", "RaceIQ", "-a", account, "-w", secret]);
    expect(calls[1].args).toContain(account);
    expect(calls[2].args).toContain(account);
  });

  test("never returns subprocess errors containing credentials", () => {
    const keychain = createMacKeychain(() => { throw new Error("command failed: private-test-key"); });
    expect(() => keychain.set("gemini-api-key", "private-test-key")).toThrow("Keychain operation failed");
  });
});
