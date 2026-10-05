import { basename, join, resolve } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";

export interface RustJobStage {
  jobId: string;
  outputRoot: string;
  inputPath: string;
  sidecarPath?: string;
  cleanup(): Promise<void>;
  cleanupOutput(): Promise<void>;
}

/** Stage unmodified upload bytes beneath configured recorder job root. */
export async function stageRustJobFiles(
  files: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
): Promise<RustJobStage> {
  const root = resolve(resolveDataDir(), "recorder-jobs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const inputRoot = await mkdtemp(join(root, "upload-"));
  const jobId = basename(inputRoot);
  const outputRoot = join(root, `job-${jobId}`);
  const paths: string[] = [];
  try {
    await mkdir(outputRoot, { recursive: false, mode: 0o700 });
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      const safeName = file.name.replace(/[\\/\0]/g, "_").replace(/^\.+/, "_") || `input-${index}`;
      // One prefix preserves companion names such as .duckdb + .duckdb.wal.
      const path = join(inputRoot, `0-${safeName}`);
      await writeFile(path, file.bytes, { flag: "wx", mode: 0o600 });
      paths.push(path);
    }
    if (paths.length === 0) throw new Error("Rust recorder job requires at least one staged input file");
  } catch (error) {
    await Promise.all([
      rm(inputRoot, { recursive: true, force: true }),
      rm(outputRoot, { recursive: true, force: true }),
    ]);
    throw error;
  }
  return {
    jobId,
    outputRoot,
    inputPath: paths[0]!,
    ...(paths[1] ? { sidecarPath: paths[1] } : {}),
    cleanup: () => rm(inputRoot, { recursive: true, force: true }),
    cleanupOutput: () => rm(outputRoot, { recursive: true, force: true }),
  };
}
