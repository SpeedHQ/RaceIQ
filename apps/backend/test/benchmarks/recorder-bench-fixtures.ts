import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type FixtureInventory = {
  captures: string[];
  motecArchives: string[];
  ibtOriginals: string[];
  duckdbOriginals: string[];
  zipArchives: string[];
  testSupportGenerators: {
    ibt: string;
    duckdb: string;
  };
};

export async function recorderBenchmarkFixtureInventory(root: string): Promise<FixtureInventory> {
  const sessionRoot = join(root, "test/artifacts/sessions");
  const captureFiles = await readdir(sessionRoot).catch(() => []);
  const motecRoot = join(root, "test/artifacts/motec");
  const motecFiles = await readdir(motecRoot).catch(() => []);
  const allArtifacts = [
    ...captureFiles.map((name) => join(sessionRoot, name)),
    ...motecFiles.map((name) => join(motecRoot, name)),
  ];
  return {
    captures: allArtifacts.filter((path) => /\.(?:bin|bin\.gz)$/i.test(path)),
    motecArchives: allArtifacts.filter((path) => /\.(?:ld|ldx)$/i.test(path)),
    ibtOriginals: allArtifacts.filter((path) => /\.ibt$/i.test(path)),
    duckdbOriginals: allArtifacts.filter((path) => /\.(?:duckdb|wal)$/i.test(path)),
    zipArchives: allArtifacts.filter((path) => /\.zip$/i.test(path)),
    testSupportGenerators: {
      ibt: "packages/game-iracing/test/support/games/iracing-ibt.ts:createRecording",
      duckdb: "packages/game-lmu/test/support/duckdb.ts:createLMUDuckDB/populateLMUDuckDB",
    },
  };
}
