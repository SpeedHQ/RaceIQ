import { resolve } from "node:path";
import { validateGoldenRecordingDirectory } from "./golden-manifest";

const rootDir = resolve(import.meta.dir, "../../..");
const manifestDir = resolve(rootDir, "test", "golden-recordings");

try {
  const validated = await validateGoldenRecordingDirectory(manifestDir, rootDir);
  for (const { manifest, verification } of validated) {
    console.log(
      `[ok] ${manifest.id}: ${verification.artifactBytes} compressed bytes, ${verification.uncompressedBytes} source bytes`,
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] ${message}`);
  process.exitCode = 1;
}
