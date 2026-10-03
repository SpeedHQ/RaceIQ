import { createReadStream, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";

export interface CombinedRecording {
  path: string;
  cleanup(): void;
}

export async function combineRecordingParts(parts: readonly string[]): Promise<CombinedRecording> {
  if (parts.length < 2) throw new Error("Expected at least two recording parts");
  const numbered = parts.map((part) => {
    const match = /^(.*)\.part(\d+)$/i.exec(basename(part));
    if (!match) throw new Error(`Invalid recording part name: ${part}`);
    return { path: part, stem: match[1]!, number: Number(match[2]) };
  });
  const stem = numbered[0]!.stem;
  if (numbered.some((part) => part.stem.toLowerCase() !== stem.toLowerCase())) {
    throw new Error("Recording parts must share one filename stem");
  }
  numbered.sort((a, b) => a.number - b.number);
  if (numbered.some((part, index) => part.number !== index + 1)) {
    throw new Error("Recording parts must be numbered consecutively from part1");
  }

  const directory = mkdtempSync(join(tmpdir(), "raceiq-recording-"));
  const path = join(directory, `recording-${stem}`);
  try {
    for (let index = 0; index < numbered.length; index++) {
      await pipeline(
        createReadStream(numbered[index]!.path),
        createWriteStream(path, { flags: index === 0 ? "w" : "a" }),
      );
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
