#!/usr/bin/env bun

import { resolve } from "node:path";

const allowedServerSets: Record<PlaywrightServerSet, true> = {
  fresh: true,
  tunes: true,
  "tunes-unseeded": true,
  seeded: true,
};
const safeBatchName = /^[a-z0-9-]+$/;
const safeShard = /^([1-9]\d*)\/([1-9]\d*)$/;
const seededPorts = { server: 3120, client: 4120, udp: 15320 } as const;
const isolationPortStride = 10;

export type PlaywrightServerSet = "fresh" | "tunes" | "tunes-unseeded" | "seeded";

export interface PlaywrightBatch {
  name: string;
  serverSet: PlaywrightServerSet;
  projects: string;
  workers: number;
  shard?: string;
  isolation?: number;
}

export interface PlaywrightCommandOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface PlaywrightBatchRunOptions {
  parallel?: boolean;
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
  const isolations = new Set<number>();
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

    let shard: string | undefined;
    if (batch.shard !== undefined) {
      if (typeof batch.shard !== "string") throw new Error(`${label}.shard must use current/total format`);
      const match = safeShard.exec(batch.shard);
      if (!match || Number(match[1]) > Number(match[2])) {
        throw new Error(`${label}.shard must use current/total format with current no greater than total`);
      }
      shard = batch.shard;
    }

    let isolation: number | undefined;
    if (batch.isolation !== undefined) {
      if (typeof batch.isolation !== "number" || !Number.isInteger(batch.isolation) || batch.isolation <= 0) {
        throw new Error(`${label}.isolation must be a positive integer`);
      }
      if (batch.serverSet !== "seeded") throw new Error(`${label}.isolation is only supported for seeded batches`);
      if (isolations.has(batch.isolation)) {
        throw new Error(`${label}.isolation must be unique (duplicate ${batch.isolation})`);
      }
      isolations.add(batch.isolation);
      isolation = batch.isolation;
    }

    return {
      name: batch.name,
      serverSet: batch.serverSet as PlaywrightServerSet,
      projects: batch.projects.trim(),
      workers,
      ...(shard ? { shard } : {}),
      ...(isolation ? { isolation } : {}),
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

function isolatedSeededEnvironment(batch: PlaywrightBatch): Record<string, string> {
  if (batch.isolation === undefined) return {};
  const offset = (batch.isolation - 1) * isolationPortStride;
  return {
    PW_SEEDED_E2E_PORT: String(seededPorts.server + offset),
    PW_SEEDED_E2E_CLIENT_PORT: String(seededPorts.client + offset),
    PW_SEEDED_E2E_UDP_PORT: String(seededPorts.udp + offset),
    PW_SEEDED_E2E_DATA_DIR: `./test-results/test-data-${batch.name}`,
  };
}

async function runPlaywrightBatch(batch: PlaywrightBatch, runCommand: PlaywrightCommandRunner): Promise<number> {
  const options: PlaywrightCommandOptions = {
    cwd: playwrightDir,
    env: {
      ...process.env,
      ...isolatedSeededEnvironment(batch),
      PW_SERVER_SET: batch.serverSet,
      PLAYWRIGHT_PROJECTS: batch.projects,
      PW_WORKERS: String(batch.workers),
      PW_OUTPUT_DIR: `./test-results/batches/${batch.name}`,
    },
  };
  const shardArgs = batch.shard ? [`--shard=${batch.shard}`] : [];
  const discoveryExit = await runCommand(["test", "--list", ...shardArgs], options);
  if (discoveryExit !== 0) return 1;
  return (await runCommand(["test", ...shardArgs], options)) === 0 ? 0 : 1;
}

function validateParallelIsolation(batches: readonly PlaywrightBatch[]): void {
  const isolations = new Set<number>();
  for (const batch of batches) {
    if (batch.serverSet !== "seeded" || batch.isolation === undefined || batch.workers !== 1) {
      throw new Error("Parallel Playwright batches require isolated seeded batches with one worker each");
    }
    if (isolations.has(batch.isolation)) throw new Error(`Parallel Playwright batch isolation ${batch.isolation} is duplicated`);
    isolations.add(batch.isolation);
  }
}

export async function runPlaywrightBatches(
  batches: readonly PlaywrightBatch[],
  runCommand: PlaywrightCommandRunner = defaultPlaywrightCommandRunner,
  options: PlaywrightBatchRunOptions = {},
): Promise<number> {
  if (options.parallel) {
    validateParallelIsolation(batches);
    const exitCodes = await Promise.all(batches.map((batch) => runPlaywrightBatch(batch, runCommand)));
    return exitCodes.some((exitCode) => exitCode !== 0) ? 1 : 0;
  }

  let failed = false;
  for (const batch of batches) {
    if ((await runPlaywrightBatch(batch, runCommand)) !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

async function main(): Promise<void> {
  try {
    const batches = parsePlaywrightBatches(Bun.env.PLAYWRIGHT_BATCHES ?? "");
    process.exitCode = await runPlaywrightBatches(
      batches,
      defaultPlaywrightCommandRunner,
      { parallel: Bun.env.PLAYWRIGHT_BATCHES_PARALLEL === "1" },
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}

if (import.meta.main) await main();
