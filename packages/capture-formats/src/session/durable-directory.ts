import { open } from "node:fs/promises";
import { dirname } from "node:path";

/** Persist directory entries on platforms supporting directory fsync. */
export async function syncDirectoryTree(directoryPath: string): Promise<void> {
  // Windows supports file flushes, but not fsync on directory handles.
  if (process.platform === "win32") return;
  let current = directoryPath;
  while (true) {
    const directory = await open(current, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
