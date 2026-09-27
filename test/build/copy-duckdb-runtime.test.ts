import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDuckDBRuntime } from "../../scripts/build/copy-duckdb-runtime";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("copies DuckDB platform runtime into installer layout", () => {
  const distDirectory = mkdtempSync(join(tmpdir(), "raceiq-duckdb-runtime-"));
  temporaryDirectories.push(distDirectory);

  copyDuckDBRuntime(process.cwd(), distDirectory);

  const scopeDirectory = join(distDirectory, "node_modules", "@duckdb");
  const packages = readdirSync(scopeDirectory);
  expect(packages).toHaveLength(1);

  const packageDirectory = join(scopeDirectory, packages[0]!);
  const manifest = JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8"),
  ) as { name: string };
  expect(manifest.name).toBe(`@duckdb/${packages[0]}`);
  expect(existsSync(join(packageDirectory, "duckdb.node"))).toBe(true);
});
