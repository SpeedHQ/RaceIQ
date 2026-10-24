import { open } from "node:fs/promises";
import { dirname } from "node:path";

/** Persist directory entries from leaf through root after create/rename operations. */
export async function syncDirectoryTree(directoryPath: string): Promise<void> {
  let current = directoryPath;
  while (true) {
    const directory = await open(current, "r");
    try {
      try {
        await directory.sync();
      } catch (error) {
        // Windows rejects fsync on directory handles; keep other errors fatal.
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    } finally { await directory.close(); }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
