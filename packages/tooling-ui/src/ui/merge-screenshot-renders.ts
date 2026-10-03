#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface MergeScreenshotRendersOptions {
  inputDir: string;
  outputDir: string;
}

export function mergeScreenshotRenders(options: MergeScreenshotRendersOptions): void {
  const currentDir = join(options.outputDir, "current-responsive");
  const baseDir = join(options.outputDir, "base-responsive");
  mkdirSync(currentDir, { recursive: true });
  mkdirSync(baseDir, { recursive: true });

  const shards = readdirSync(options.inputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("pr-screenshot-render-"))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  if (shards.length === 0) throw new Error(`No screenshot render shards found in ${options.inputDir}`);

  const firstShard = join(options.inputDir, shards[0].name);
  for (const metadata of ["pr-number.txt", "base-ref.txt"]) {
    const source = join(firstShard, metadata);
    if (!existsSync(source)) throw new Error(`Missing ${metadata} in ${firstShard}`);
    cpSync(source, join(options.outputDir, metadata));
  }

  for (const shard of shards) {
    for (const name of ["current-responsive", "base-responsive"]) {
      const source = join(options.inputDir, shard.name, name);
      if (existsSync(source)) cpSync(source, join(options.outputDir, name), { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const inputIndex = args.indexOf("--input");
  const outputIndex = args.indexOf("--output");
  const inputDir = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
  const outputDir = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!inputDir || !outputDir) throw new Error("Usage: merge-screenshot-renders.ts --input DIR --output DIR");
  mergeScreenshotRenders({ inputDir, outputDir });
}
