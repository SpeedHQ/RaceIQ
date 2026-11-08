import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest } from "./contract";
import { prepareSplitWindows, type SplitPreparationInput } from "./prepare";
import { splitCapturePromise } from "./index";

/** Prepare parser-aware lap windows and build an immutable bundle, cleaning up owned output on failure. */
export async function prepareCaptureBundle<State>(input: Pick<SplitPreparationInput<State>, "windows" | "source" | "codec" | "bootstrapVersion"> & {
  readonly sourcePath: string;
  readonly outputDirectory: string;
  readonly sourceRevision: string;
}): Promise<{ manifestPath: string; manifest: Manifest }> {
  const lapWindows = await prepareSplitWindows(input);
  // A pre-existing directory belongs to the caller, not this operation.
  await mkdir(input.outputDirectory);
  try {
    const manifest = await splitCapturePromise({
      sourcePath: input.sourcePath,
      outputDirectory: input.outputDirectory,
      gameId: input.codec.gameId,
      sourceRevision: input.sourceRevision,
      lapWindows,
    });
    if (manifest.version !== 3) throw new Error("Capture split did not produce a v3 manifest");
    return { manifestPath: join(input.outputDirectory, "manifest.json"), manifest };
  } catch (error) {
    await rm(input.outputDirectory, { recursive: true, force: true });
    throw error;
  }
}
