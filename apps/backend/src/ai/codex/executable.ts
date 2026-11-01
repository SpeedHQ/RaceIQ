/** Trusted settings only. Never accept executable paths or argv from HTTP. */
export function findCodexExecutable(configured: string): string | null {
  const candidates = configured ? [configured] : ["codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
  return candidates.map((candidate) => Bun.which(candidate)).find(Boolean) ?? null;
}
