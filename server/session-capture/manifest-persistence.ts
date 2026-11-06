import { randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectoryTree } from "@raceiq/capture-formats/session/durable-directory";
import type { Manifest } from "@raceiq/capture-splitting";

async function publishSnapshot(path: string, serialized: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, serialized, { flag: "wx" });
    const file = await open(temporary, "r+");
    try { await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    await syncDirectoryTree(dirname(path));
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
