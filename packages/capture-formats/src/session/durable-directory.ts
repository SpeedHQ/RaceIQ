import { open } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Flush directory entries where supported, from leaf through root.
 * Windows rejects fsync on read-only directory handles. Callers still flush
 * writable file handles before publication; this cannot promise POSIX directory
 * durability on Windows. Opening paths and all other I/O failures remain fatal.
 */
export async function syncDirectoryTree(directoryPath: string): Promise<void> {
  let current = directoryPath;
  while (true) {
    const directory = await open(current, "r");
    try {
      try {
        await directory.sync();
      } catch (error) {
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM" ||
            !(await directory.stat()).isDirectory()) throw error;
      }
    } finally { await directory.close(); }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
