import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { discoverTestOwners, readSuiteFiles, SUITES, type Suite } from "./owners";

interface Assignment {
  location: string;
  suite: Suite;
  owner: string;
}

export interface ShardCoverage {
  suiteCounts: Record<Suite, number>;
  testCount: number;
}

function ordinaryTests(root: string, directory: string): string[] {
  const files = new Set<string>();
  if (!existsSync(resolve(root, directory))) return [];
  for (const pattern of ["**/*.test.ts", "**/*.test.tsx"]) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: resolve(root, directory), onlyFiles: true })) {
      const normalized = file.replaceAll("\\", "/");
      if (normalized.split("/").some((part) => part === "fixtures" || part === "artifacts")) continue;
      files.add(`${directory}/${normalized}`);
    }
  }
  return [...files].sort();
}

export function checkTestShards(root = resolve(import.meta.dir, "../..")): ShardCoverage {
  const assignments = new Map<string, Assignment>();
  const errors: string[] = [];
  const suiteCounts = Object.fromEntries(SUITES.map((suite) => [suite, 0])) as Record<Suite, number>;
  const owners = discoverTestOwners(root);
  const ownerTests = new Set<string>();

  for (const owner of owners) {
    const discovered = ordinaryTests(root, owner.root).filter((file) =>
      file.startsWith(`${owner.root}/test/`),
    );
    for (const file of discovered) ownerTests.add(file);
    for (const suite of SUITES) {
      const manifestRelativePath = `${owner.root}/test/${suite}-files.txt`;
      try {
        const files = readSuiteFiles(root, owner, suite);
        for (const file of files) {
          const previous = assignments.get(file);
          const location = `${manifestRelativePath}`;
          if (previous) {
            errors.push(`${file}: listed more than once (${previous.location}, ${location})`);
            continue;
          }
          assignments.set(file, { location, suite, owner: owner.name });
          suiteCounts[suite] += 1;
        }
      } catch (error) {
        if (!existsSync(resolve(root, manifestRelativePath))) continue;
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const discovered = [...ownerTests].sort();
  for (const file of discovered) if (!assignments.has(file)) errors.push(`${file}: not assigned to a test suite`);
  for (const [file, assignment] of assignments) {
    if (!ownerTests.has(file)) errors.push(`${assignment.location}: listed path is not an ordinary test file: ${file}`);
  }
  for (const file of ordinaryTests(root, "test")) {
    if (!ownerTests.has(file)) errors.push(`${file}: ordinary test is outside an owner test root`);
  }

  if (errors.length > 0) {
    throw new Error(`Test shard coverage failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
  return { suiteCounts, testCount: discovered.length };
}

if (import.meta.main) {
  try {
    const coverage = checkTestShards();
    console.log(
      `All ${coverage.testCount} ordinary tests are assigned exactly once ` +
        `(${SUITES.map((suite) => `${coverage.suiteCounts[suite]} ${suite}`).join(", ")}).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
