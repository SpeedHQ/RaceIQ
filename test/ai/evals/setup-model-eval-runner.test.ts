import { expect, test } from "bun:test";

test("setup model eval entrypoint isolates before loading inner runner", async () => {
  const wrapper = await Bun.file(new URL("../../../scripts/quality/setup-model-eval.ts", import.meta.url)).text();
  const inner = await Bun.file(new URL("../../../scripts/quality/run-setup-model-eval.ts", import.meta.url)).text();

  expect(wrapper).toMatch(/import \{ mkdtemp, rm \} from "node:fs\/promises"/);
  expect(wrapper).toMatch(/await import\("\.\/run-setup-model-eval"\)/);
  expect(wrapper).not.toMatch(/from ["']@mastra\//);
  expect(wrapper).not.toMatch(/from ["']\.\.\/\.\.\/mastra\//);
  expect(inner).toMatch(/initDb\(\)/);
  expect(inner).toMatch(/initGameAdapters\(\)/);
  expect(inner).toMatch(/initServerGameAdapters\(\)/);
});
