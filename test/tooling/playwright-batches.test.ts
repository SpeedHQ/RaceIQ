import { describe, expect, test } from "bun:test";
import {
  parsePlaywrightBatches,
  runPlaywrightBatches,
  type PlaywrightBatch,
  type PlaywrightCommandOptions,
  type PlaywrightCommandRunner,
} from "../../scripts/playwright-batches";

const freshBatch: PlaywrightBatch = {
  name: "fresh-install",
  serverSet: "fresh",
  projects: "--project=fresh-install",
  workers: 1,
};

function batchJson(batch: Record<string, unknown>): string {
  return JSON.stringify([batch]);
}

describe("parsePlaywrightBatches", () => {
  test("parses supported server sets, trims projects, and defaults workers to one", () => {
    expect(parsePlaywrightBatches(JSON.stringify([
      { name: "fresh-install", serverSet: "fresh", projects: "  --project=fresh-install  " },
      { name: "tunes", serverSet: "tunes", projects: "--project=tunes", workers: 2 },
      { name: "tunes-unseeded", serverSet: "tunes-unseeded", projects: "--project=tunes-unseeded" },
      { name: "seeded-1", serverSet: "seeded", projects: "--project=seeded-e2e", shard: "1/4", isolation: 1 },
    ]))).toEqual([
      { name: "fresh-install", serverSet: "fresh", projects: "--project=fresh-install", workers: 1 },
      { name: "tunes", serverSet: "tunes", projects: "--project=tunes", workers: 2 },
      { name: "tunes-unseeded", serverSet: "tunes-unseeded", projects: "--project=tunes-unseeded", workers: 1 },
      { name: "seeded-1", serverSet: "seeded", projects: "--project=seeded-e2e", workers: 1, shard: "1/4", isolation: 1 },
    ]);
  });

  test("rejects malformed batches before commands run", () => {
    const invalidSources = [
      "not-json",
      "{}",
      "[]",
      JSON.stringify([null]),
      batchJson({ name: "Fresh Install", serverSet: "fresh", projects: "--project=fresh-install" }),
      JSON.stringify([
        { name: "same", serverSet: "fresh", projects: "--project=fresh-install" },
        { name: "same", serverSet: "seeded", projects: "--project=seeded-e2e" },
      ]),
      batchJson({ name: "all", serverSet: "all", projects: "--project=fresh-install" }),
      batchJson({ name: "fresh", serverSet: "fresh", projects: "  " }),
      batchJson({ name: "fresh", serverSet: "fresh", projects: "--project=fresh-install", workers: 0 }),
      batchJson({ name: "fresh", serverSet: "fresh", projects: "--project=fresh-install", workers: 1.5 }),
      batchJson({ name: "seeded", serverSet: "seeded", projects: "--project=seeded-e2e", shard: "0/4" }),
      batchJson({ name: "seeded", serverSet: "seeded", projects: "--project=seeded-e2e", shard: "5/4" }),
      batchJson({ name: "seeded", serverSet: "seeded", projects: "--project=seeded-e2e", isolation: 0 }),
      batchJson({ name: "fresh", serverSet: "fresh", projects: "--project=fresh-install", isolation: 1 }),
      JSON.stringify([
        { name: "seeded-1", serverSet: "seeded", projects: "--project=seeded-e2e", isolation: 1 },
        { name: "seeded-2", serverSet: "seeded", projects: "--project=seeded-e2e", isolation: 1 },
      ]),
    ];

    for (const source of invalidSources) {
      expect(() => parsePlaywrightBatches(source)).toThrow();
    }
  });
});

describe("runPlaywrightBatches", () => {
  test("runs each discovery and gate strictly sequentially", async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    const runner: PlaywrightCommandRunner = (args, options) => {
      calls.push(`${options.env.PW_SERVER_SET}:${args.join(" ")}`);
      const { promise, resolve } = Promise.withResolvers<number>();
      releases.push(() => resolve(0));
      return promise;
    };

    const completion = runPlaywrightBatches([
      freshBatch,
      { name: "seeded", serverSet: "seeded", projects: "--project=seeded-e2e", workers: 1 },
    ], runner);
    const expectedCalls = [
      "fresh:test --list",
      "fresh:test",
      "seeded:test --list",
      "seeded:test",
    ];

    for (let index = 0; index < expectedCalls.length; index += 1) {
      expect(calls).toEqual(expectedCalls.slice(0, index + 1));
      releases[index]();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(await completion).toBe(0);
    expect(calls).toEqual(expectedCalls);
  });

  test("runs isolated seeded shards concurrently", async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    const runner: PlaywrightCommandRunner = (args, options) => {
      calls.push(`${options.env.PW_SEEDED_E2E_PORT}:${args.join(" ")}`);
      const { promise, resolve } = Promise.withResolvers<number>();
      releases.push(() => resolve(0));
      return promise;
    };
    const batches: PlaywrightBatch[] = [1, 2, 3, 4].map((isolation) => ({
      name: `seeded-${isolation}`,
      serverSet: "seeded",
      projects: "--project=seeded-e2e",
      workers: 1,
      shard: `${isolation}/4`,
      isolation,
    }));

    const completion = runPlaywrightBatches(batches, runner, { parallel: true });
    expect(calls).toEqual([
      "3120:test --list --shard=1/4",
      "3130:test --list --shard=2/4",
      "3140:test --list --shard=3/4",
      "3150:test --list --shard=4/4",
    ]);

    for (const release of releases.splice(0, 4)) release();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.slice(4).sort()).toEqual([
      "3120:test --shard=1/4",
      "3130:test --shard=2/4",
      "3140:test --shard=3/4",
      "3150:test --shard=4/4",
    ]);

    for (const release of releases) release();
    expect(await completion).toBe(0);
  });

  test("rejects parallel batches that share a backend or worker", async () => {
    const runner: PlaywrightCommandRunner = async () => 0;
    await expect(runPlaywrightBatches([freshBatch], runner, { parallel: true })).rejects.toThrow();
    await expect(runPlaywrightBatches([
      { name: "seeded", serverSet: "seeded", projects: "--project=seeded-e2e", workers: 2, isolation: 1 },
    ], runner, { parallel: true })).rejects.toThrow();
  });

  test("skips gate after failed discovery and continues with later batches", async () => {
    const calls: string[] = [];
    const exitCodes = [7, 0, 0];
    const runner: PlaywrightCommandRunner = async (args, options) => {
      calls.push(`${options.env.PW_SERVER_SET}:${args.join(" ")}`);
      return exitCodes.shift() ?? 0;
    };

    const exitCode = await runPlaywrightBatches([
      freshBatch,
      { name: "tunes", serverSet: "tunes", projects: "--project=tunes", workers: 1 },
    ], runner);

    expect(exitCode).toBe(1);
    expect(calls).toEqual(["fresh:test --list", "tunes:test --list", "tunes:test"]);
  });

  test("continues after a failed gate and returns aggregated failure", async () => {
    const calls: string[] = [];
    const exitCodes = [0, 3, 0, 0];
    const runner: PlaywrightCommandRunner = async (args, options) => {
      calls.push(`${options.env.PW_SERVER_SET}:${args.join(" ")}`);
      return exitCodes.shift() ?? 0;
    };

    const exitCode = await runPlaywrightBatches([
      freshBatch,
      { name: "seeded", serverSet: "seeded", projects: "--project=seeded-e2e", workers: 1 },
    ], runner);

    expect(exitCode).toBe(1);
    expect(calls).toEqual([
      "fresh:test --list",
      "fresh:test",
      "seeded:test --list",
      "seeded:test",
    ]);
  });

  test("sets isolated server, project, worker, and output environment per batch", async () => {
    const optionsByCall: PlaywrightCommandOptions[] = [];
    const runner: PlaywrightCommandRunner = async (_args, options) => {
      optionsByCall.push(options);
      return 0;
    };

    await runPlaywrightBatches([
      { name: "tunes-unseeded", serverSet: "tunes-unseeded", projects: "--project=tunes-unseeded", workers: 3 },
    ], runner);

    expect(optionsByCall).toHaveLength(2);
    for (const options of optionsByCall) {
      expect(options.cwd.replaceAll("\\", "/").endsWith("/playwright")).toBe(true);
      expect(options.env.PW_SERVER_SET).toBe("tunes-unseeded");
      expect(options.env.PLAYWRIGHT_PROJECTS).toBe("--project=tunes-unseeded");
      expect(options.env.PW_WORKERS).toBe("3");
      expect(options.env.PW_OUTPUT_DIR).toBe("./test-results/batches/tunes-unseeded");
    }
  });

  test("sets unique seeded ports and data directory for an isolated batch", async () => {
    const calls: Array<{ args: readonly string[]; options: PlaywrightCommandOptions }> = [];
    const runner: PlaywrightCommandRunner = async (args, options) => {
      calls.push({ args, options });
      return 0;
    };

    await runPlaywrightBatches([
      {
        name: "seeded-3",
        serverSet: "seeded",
        projects: "--project=seeded-e2e",
        workers: 1,
        shard: "3/4",
        isolation: 3,
      },
    ], runner);

    expect(calls.map(({ args }) => args)).toEqual([
      ["test", "--list", "--shard=3/4"],
      ["test", "--shard=3/4"],
    ]);
    for (const { options } of calls) {
      expect(options.env.PW_SEEDED_E2E_PORT).toBe("3140");
      expect(options.env.PW_SEEDED_E2E_CLIENT_PORT).toBe("4140");
      expect(options.env.PW_SEEDED_E2E_UDP_PORT).toBe("15340");
      expect(options.env.PW_SEEDED_E2E_DATA_DIR).toBe("./test-results/test-data-seeded-3");
      expect(options.env.PW_OUTPUT_DIR).toBe("./test-results/batches/seeded-3");
    }
  });
});
