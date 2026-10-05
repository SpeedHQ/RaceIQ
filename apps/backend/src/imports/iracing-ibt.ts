import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { getRecordingEngineKind } from "@raceiq/backend-core/runtime/recorder-engine";
import { importStagedWithRust, previewStagedWithRust } from "@raceiq/backend-core/session-capture/import-results";
import {
  IbtImportError,
  ibtFrames,
  previewIbtFile,
  type IbtImportPreview,
} from "@raceiq/game-iracing/ibt-preview";
import { registerImportedIRacingIdentity } from "@raceiq/game-iracing/identity";
import { importSessionFrames, type ImportSessionResult } from "@raceiq/backend-core/session-capture/import-pipeline";
import type { SessionOwnership } from "@raceiq/shared/racing/sessions/types";

const STAGE_TTL_MS = 30 * 60 * 1000;
export const MAX_IBT_BYTES = 8 * 1024 * 1024 * 1024;
const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StagedIbtManifest {
  version: 1;
  createdAt: number;
  sha256: string;
  preview: IbtImportPreview;
}

function stageDir(): string {
  const path = resolve(resolveDataDir(), "recorder-jobs", "ibt-staging");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function stagePaths(token: string): { directory: string; outputRoot: string; ibt: string; manifest: string } {
  if (!TOKEN_PATTERN.test(token)) throw new IbtImportError("Invalid staged IBT token");
  const directory = join(stageDir(), token);
  const outputRoot = join(resolve(resolveDataDir(), "recorder-jobs", "ibt-jobs"), token);
  return {
    directory,
    outputRoot,
    ibt: join(directory, "session.ibt"),
    manifest: join(directory, "manifest.json"),
  };
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function removeStage(token: string): void {
  const paths = stagePaths(token);
  rmSync(paths.directory, { recursive: true, force: true });
}

function cleanupExpiredStages(): void {
  const root = stageDir();
  const cutoff = Date.now() - STAGE_TTL_MS;
  for (const token of readdirSync(root)) {
    if (!TOKEN_PATTERN.test(token)) continue;
    const paths = stagePaths(token);
    try {
      const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as StagedIbtManifest;
      if (manifest.createdAt < cutoff || statSync(paths.directory).mtimeMs < cutoff) removeStage(token);
    } catch {
      removeStage(token);
    }
  }
}

export async function stageIbtUpload(
  body: ReadableStream<Uint8Array> | null,
  fileName: string,
  declaredBytes?: number,
): Promise<{ token: string | null; preview: IbtImportPreview }> {
  cleanupExpiredStages();
  if (!body) throw new IbtImportError("Missing IBT request body");
  if (
    declaredBytes !== undefined &&
    (!Number.isSafeInteger(declaredBytes) ||
      declaredBytes <= 0 ||
      declaredBytes > MAX_IBT_BYTES)
  ) {
    throw new IbtImportError(
      `IBT upload exceeds the ${MAX_IBT_BYTES / 1024 ** 3} GiB limit`,
      413,
    );
  }

  const token = randomUUID();
  const paths = stagePaths(token);
  mkdirSync(paths.directory, { recursive: false, mode: 0o700 });
  const file = await openFile(paths.ibt, "wx", 0o600);
  const reader = body.getReader();
  const sha256 = createHash("sha256");
  let bytesWritten = 0;
  let uploadFailure: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sha256.update(value);
      bytesWritten += value.byteLength;
      if (bytesWritten > MAX_IBT_BYTES) {
        throw new IbtImportError(
          `IBT upload exceeds the ${MAX_IBT_BYTES / 1024 ** 3} GiB limit`,
          413,
        );
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await file.write(value, offset, value.byteLength - offset);
        if (result.bytesWritten === 0) {
          throw new IbtImportError("IBT staging write stopped unexpectedly");
        }
        offset += result.bytesWritten;
      }
    }
  } catch (error) {
    uploadFailure = error;
  } finally {
    await file.close();
    reader.releaseLock();
  }
  if (uploadFailure) {
    removeIfPresent(paths.ibt);
    throw uploadFailure;
  }

  if (bytesWritten === 0) {
    removeIfPresent(paths.ibt);
    throw new IbtImportError("The uploaded IBT file is empty");
  }
  if (declaredBytes !== undefined && bytesWritten !== declaredBytes) {
    removeIfPresent(paths.ibt);
    throw new IbtImportError(
      `Incomplete IBT upload: expected ${declaredBytes} bytes, received ${bytesWritten}`,
    );
  }

  try {
    let preview: IbtImportPreview;
    const contentHash = sha256.digest("hex");
    if (getRecordingEngineKind() === "rust") {
      mkdirSync(paths.outputRoot, { recursive: true, mode: 0o700 });
      try {
        const result = await previewStagedWithRust({
          path: paths.ibt,
          originalName: fileName,
          outputRoot: paths.outputRoot,
          jobId: token,
          operation: "preview",
          format: "ibt",
          gameId: "iracing",
        });
        if (!result.preview || typeof result.preview !== "object") throw new IbtImportError("Rust recorder returned invalid IBT preview");
        preview = result.preview as IbtImportPreview;
      } finally {
        rmSync(paths.outputRoot, { recursive: true, force: true });
      }
    } else {
      preview = await previewIbtFile(paths.ibt, fileName);
    }
    if (!preview.canImport) {
      removeIfPresent(paths.ibt);
      return { token: null, preview };
    }
    const manifest: StagedIbtManifest = {
      version: 1,
      createdAt: Date.now(),
      sha256: contentHash,
      preview,
    };
    writeFileSync(paths.manifest, JSON.stringify(manifest));
    return { token, preview };
  } catch (error) {
    removeIfPresent(paths.ibt);
    removeIfPresent(paths.manifest);
    throw error;
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function loadManifest(token: string): Promise<{
  paths: ReturnType<typeof stagePaths>;
  manifest: StagedIbtManifest;
}> {
  cleanupExpiredStages();
  const paths = stagePaths(token);
  if (!existsSync(paths.ibt) || !existsSync(paths.manifest)) {
    throw new IbtImportError(
      "This IBT preview has expired or was already used",
      410,
    );
  }

  let manifest: StagedIbtManifest;
  try {
    manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as StagedIbtManifest;
  } catch {
    removeStage(token);
    throw new IbtImportError("The staged IBT manifest is invalid", 410);
  }
  if (
    manifest.version !== 1 ||
    !manifest.preview?.canImport ||
    Date.now() - manifest.createdAt > STAGE_TTL_MS
  ) {
    removeStage(token);
    throw new IbtImportError("This IBT preview has expired", 410);
  }
  if (statSync(paths.ibt).size !== manifest.preview.fileSize || await fileSha256(paths.ibt) !== manifest.sha256) {
    removeStage(token);
    throw new IbtImportError("The staged IBT file changed after preview", 410);
  }
  return { paths, manifest };
}

export async function commitStagedIbt(
  token: string,
  ownership: SessionOwnership = "mine",
): Promise<{
  packetCount: number;
  laps: ImportSessionResult["laps"];
  preview: IbtImportPreview;
}> {
  const { paths, manifest } = await loadManifest(token);
  try {
    try {
      await registerImportedIRacingIdentity(manifest.preview);
      if (getRecordingEngineKind() === "rust") {
        mkdirSync(paths.outputRoot, { recursive: true, mode: 0o700 });
        const result = await importStagedWithRust({
          path: paths.ibt,
          originalName: manifest.preview.fileName ?? "session.ibt",
          outputRoot: paths.outputRoot,
          jobId: token,
          gameId: "iracing",
          format: "ibt",
          ownership,
          requireLaps: true,
        });
        return { packetCount: result.packetCount, laps: result.laps, preview: manifest.preview };
      }
      const result = await importSessionFrames(
        ibtFrames(paths.ibt, manifest.preview),
        "iracing",
        { requireLaps: true, ownership },
      );
      return {
        packetCount: result.packetCount,
        laps: result.laps,
        preview: manifest.preview,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "No complete, importable laps were found") {
        throw new IbtImportError(error.message);
      }
      throw error;
    }
  } finally {
    removeStage(token);
  }
}

export function cancelStagedIbt(token: string): void {
  removeStage(token);
}
