import { randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Manifest } from "@raceiq/capture-splitting";

async function publishSnapshot(path: string, serialized: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, serialized, { flag: "wx" });
    const file = await open(temporary, "r+");
    try { await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const parent = await open(dirname(path), "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function persistCaptureManifest(path: string, manifest: Manifest): Promise<void> {
  const serialized = JSON.stringify(manifest);
  await publishSnapshot(`${path}.recovery`, serialized);
  await publishSnapshot(path, serialized);
}
