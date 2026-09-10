export type ParaglideHashInput = readonly [path: string, contents: string];

export async function computeParaglideInputHash(
  inputs: readonly ParaglideHashInput[],
  compilerFingerprint: string,
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(compilerFingerprint);
  for (const [path, contents] of [...inputs].sort(([a], [b]) => a.localeCompare(b))) {
    hasher.update(`\0${path}\0${contents}`);
  }
  return hasher.digest("hex");
}
