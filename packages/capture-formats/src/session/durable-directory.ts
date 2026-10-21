import { open } from "node:fs/promises";
import { dirname } from "node:path";

/** Persist directory entries from leaf through root where directory fsync is supported.
 * Windows does not expose a portable directory fsync through Node; file contents are
 * still flushed separately by callers, but directory-entry durability is not asserted.
 */
export async function syncDirectoryTree(directoryPath: string): Promise<void> {
  let current = directoryPath;
  while (true) {
    const directory = await open(current, "r");
    try {
      if (process.platform !== "win32") await directory.sync();
    } finally {
      await directory.close();
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
