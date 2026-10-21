import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

type Execute = (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string;

export function createMacKeychain(execute: Execute = execFileSync) {
  function run(args: string[]): string {
    try {
      // No shell: account names and secrets remain literal arguments.
      return execute("/usr/bin/security", args, {
        encoding: "utf-8", timeout: 5000, shell: false, stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // child_process errors can include the command arguments (and the key).
      throw new Error("Keychain operation failed");
    }
  }
  return {
    get: (account: string) => run(["find-generic-password", "-s", "RaceIQ", "-a", account, "-w"]).trim(),
    set: (account: string, password: string) => { run(["add-generic-password", "-U", "-s", "RaceIQ", "-a", account, "-w", password]); },
    delete: (account: string) => { run(["delete-generic-password", "-s", "RaceIQ", "-a", account]); },
  };
}
