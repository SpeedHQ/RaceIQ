import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

function nativeNpmExecutable(executable: string): string {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) return executable;
  try {
    const launcher = realpathSync(executable);
    if (basename(launcher) !== "codex.js") return executable;
    // Read public package manifests only; never dependency source or auth files.
    const manifest = JSON.parse(readFileSync(join(dirname(launcher), "..", "package.json"), "utf8"));
    if (manifest.name !== "@openai/codex" || manifest.version !== "0.164.0" || manifest.bin?.codex !== "bin/codex.js") return executable;
    const platformPackage = `@openai/codex-darwin-${process.arch}`;
    if (!manifest.optionalDependencies?.[platformPackage]) return executable;
    const metadataPath = Bun.resolveSync(`${platformPackage}/package.json`, dirname(launcher));
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (metadata.name !== "@openai/codex" || metadata.version !== `0.164.0-darwin-${process.arch}`) return executable;
    const triple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    // Verified 0.164.0 npm platform layout. Execute its native CLI directly so
    // GUI launches do not depend on the Node-based npm wrapper or shell PATH.
    return Bun.which(join(dirname(metadataPath), "vendor", triple, "bin", "codex")) ?? executable;
  } catch {
    return executable;
  }
}

/** Trusted settings only. Never accept executable paths or argv from HTTP. */
export function findCodexExecutable(configured: string): string | null {
  const candidates = configured ? [configured] : ["codex", join(homedir(), ".local", "bin", "codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
  const executable = candidates.map((candidate) => Bun.which(candidate)).find(Boolean);
  return executable ? nativeNpmExecutable(executable) : null;
}
