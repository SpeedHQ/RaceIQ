#!/usr/bin/env bun

import { resolve } from "node:path";

const allowedServerSets: Record<PlaywrightServerSet, true> = {
  fresh: true,
  tunes: true,
  "tunes-unseeded": true,
  seeded: true,
};
const safeBatchName = /^[a-z0-9-]+$/;

export type PlaywrightServerSet = "fresh" | "tunes" | "tunes-unseeded" | "seeded";

export interface PlaywrightBatch {
  name: string;
  serverSet: PlaywrightServerSet;
  projects: string;
  workers: number;
}

export interface PlaywrightCommandOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export type PlaywrightCommandRunner = (
  args: readonly string[],
  options: PlaywrightCommandOptions,
) => Promise<number>;

export function parsePlaywrightBatches(source: string): PlaywrightBatch[] {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`PLAYWRIGHT_BATCHES must be valid JSON${detail}`);
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("PLAYWRIGHT_BATCHES must be a non-empty JSON array");
  }

  const names = new Set<string>();
  return value.map((candidate, index) => {
    const label = `PLAYWRIGHT_BATCHES[${index}]`;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${label} must be an object`);
    }

    const batch = candidate as Record<string, unknown>;
    if (typeof batch.name !== "string" || !safeBatchName.test(batch.name)) {
      throw new Error(`${label}.name must match ${safeBatchName}`);
    }
    if (names.has(batch.name)) {
      throw new Error(`${label}.name must be unique (duplicate "${batch.name}")`);
    }
    names.add(batch.name);

    if (typeof batch.serverSet !== "string" || !Object.hasOwn(allowedServerSets, batch.serverSet)) {
      throw new Error(`${label}.serverSet must be one of fresh, tunes, tunes-unseeded, or seeded`);
    }
    if (typeof batch.projects !== "string" || batch.projects.trim() === "") {
      throw new Error(`${label}.projects must be a non-empty string`);
    }

    const workers = batch.workers ?? 1;
    if (typeof workers !== "number" || !Number.isInteger(workers) || workers <= 0) {
      throw new Error(`${label}.workers must be a positive integer`);
    }

    return {
      name: batch.name,
      serverSet: batch.serverSet as PlaywrightServerSet,
      projects: batch.projects.trim(),
      workers,
    };
  });
}

const repositoryDir = resolve(import.meta.dir, "..");
const playwrightDir = resolve(repositoryDir, "playwright");
const playwrightCiScript = resolve(import.meta.dir, "playwright-ci.ts");

export const defaultPlaywrightCommandRunner: PlaywrightCommandRunner = async (args, options) => {
  const bunExecutable = Bun.which("bun") ?? process.execPath;
  const child = Bun.spawn([bunExecutable, playwrightCiScript, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
};

export async function runPlaywrightBatches(
  batches: readonly PlaywrightBatch[],
  runCommand: PlaywrightCommandRunner = defaultPlaywrightCommandRunner,
): Promise<number> {
  let failed = false;

  for (const batch of batches) {
    const options: PlaywrightCommandOptions = {
      cwd: playwrightDir,
      env: {
        ...process.env,
        PW_SERVER_SET: batch.serverSet,
        PLAYWRIGHT_PROJECTS: batch.projects,
        PW_WORKERS: String(batch.workers),
        PW_OUTPUT_DIR: `./test-results/batches/${batch.name}`,
      },
    };

    const discoveryExit = await runCommand(["test", "--list"], options);
    if (discoveryExit !== 0) {
      failed = true;
      continue;
    }

    const gateExit = await runCommand(["test"], options);
    if (gateExit !== 0) failed = true;
  }

  return failed ? 1 : 0;
}

async function main(): Promise<void> {
  try {
    const batches = parsePlaywrightBatches(Bun.env.PLAYWRIGHT_BATCHES ?? "");
    process.exitCode = await runPlaywrightBatches(batches);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}

if (import.meta.main) await main();
