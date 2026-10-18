import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PublishedManifest } from "./contract";

/** Count each authoritative replay file once, including manifest members. */
export async function captureSourceFiles(input: {
  readonly rawFile: string;
  readonly archiveFiles: readonly string[];
  readonly manifests: readonly { path: string; manifest: PublishedManifest }[];
}): Promise<Map<string, number>> {
  const files = new Set([resolve(input.rawFile)]);
  for (const path of input.archiveFiles) files.add(resolve(path));
  for (const { path, manifest } of input.manifests) {
    files.add(resolve(path));
    if (manifest.version === 4) files.add(resolve(dirname(path), manifest.archiveFile));
    else for (const chunk of manifest.chunks) files.add(resolve(dirname(path), chunk.path));
  }
  const sizes = new Map<string, number>();
  for (const path of files) sizes.set(path, (await stat(path)).size);
  return sizes;
}

