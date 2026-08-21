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
      { name: "seeded", serverSet: "seeded", projects: "--project=seeded-e2e" },
    ]))).toEqual([
      { name: "fresh-install", serverSet: "fresh", projects: "--project=fresh-install", workers: 1 },
      { name: "tunes", serverSet: "tunes", projects: "--project=tunes", workers: 2 },
      { name: "tunes-unseeded", serverSet: "tunes-unseeded", projects: "--project=tunes-unseeded", workers: 1 },
      { name: "seeded", serverSet: "seeded", projects: "--project=seeded-e2e", workers: 1 },
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
    }

    expect(await completion).toBe(0);
    expect(calls).toEqual(expectedCalls);
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
});
