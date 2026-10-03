import { describe, expect, test } from "bun:test";
import { createBoundedPipelineRunner } from "../benchmarks/pipeline-bench-support";

describe("bounded pipeline benchmark runner", () => {
  test("flushes detector state at configured packet intervals", async () => {
    const calls: string[] = [];
    const runner = createBoundedPipelineRunner(
      {
        processPacket: async () => { calls.push("process"); },
        flushIncompleteLap: async () => { calls.push("flush"); },
      },
      2,
    );

    await runner.run({});
    await runner.run({});
    await runner.run({});

    expect(calls).toEqual(["process", "process", "flush", "process"]);
  });
});
