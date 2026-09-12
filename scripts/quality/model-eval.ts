#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const cwd = process.cwd();
const raceiqDataDir = await mkdtemp(`${tmpdir()}/raceiq-model-eval-`);
const previousDataDir = process.env.DATA_DIR;
const previousStorageUrl = process.env.MASTRA_STORAGE_URL;
const previousObservabilityPath = process.env.MASTRA_OBSERVABILITY_PATH;

process.env.DATA_DIR = raceiqDataDir;
process.env.MASTRA_STORAGE_URL ??= `file:${resolve(cwd, "data/mastra-model-evals.db")}`;
process.env.MASTRA_OBSERVABILITY_PATH ??= resolve(cwd, "data/mastra-model-evals-observability.duckdb");
try {
  // Dynamic import is intentional: dependent modules read DATA_DIR at initialization.
  await import("./run-model-eval");
} finally {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousStorageUrl === undefined) delete process.env.MASTRA_STORAGE_URL;
  else process.env.MASTRA_STORAGE_URL = previousStorageUrl;
  if (previousObservabilityPath === undefined) delete process.env.MASTRA_OBSERVABILITY_PATH;
  else process.env.MASTRA_OBSERVABILITY_PATH = previousObservabilityPath;
  await rm(raceiqDataDir, { recursive: true, force: true });
}
