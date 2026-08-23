import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const SHARDS = ["unit", "integration"] as const;
type Shard = (typeof SHARDS)[number];

interface Assignment {
  location: string;
  shard: Shard;
}

export interface ShardCoverage {
  shardCounts: Record<Shard, number>;
  testCount: number;
}

function ordinaryTestFiles(root: string): string[] {
  const files = new Set<string>();
  for (const pattern of ["test/**/*.test.ts", "test/**/*.test.tsx"]) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      files.add(file.replaceAll("\\", "/"));
    }
  }
  return [...files].sort();
}

export function checkTestShards(root = resolve(import.meta.dir, "../..")): ShardCoverage {
  const assignments = new Map<string, Assignment>();
  const errors: string[] = [];
  const shardCounts: Record<Shard, number> = { unit: 0, integration: 0 };

  for (const shard of SHARDS) {
    const manifestRelativePath = `scripts/test/${shard}-files.txt`;
    const manifestPath = resolve(root, manifestRelativePath);
    const text = readFileSync(manifestPath, "utf8");

    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      const normalized = line.replaceAll("\\", "/");
      const absolute = resolve(root, normalized);
      const relativePath = relative(root, absolute).replaceAll(sep, "/");
      const location = `${manifestRelativePath}:${index + 1}`;

      if (relativePath !== normalized || !relativePath.startsWith("test/")) {
        errors.push(`${location}: path must stay inside test/: ${line}`);
        continue;
      }
      if (!/\.test\.tsx?$/.test(relativePath)) {
        errors.push(`${location}: invalid test path: ${line}`);
        continue;
      }
      if (!existsSync(absolute)) {
        errors.push(`${location}: listed test file does not exist: ${relativePath}`);
      }

      const previous = assignments.get(relativePath);
      if (previous) {
        errors.push(`${relativePath}: listed more than once (${previous.location}, ${location})`);
        continue;
      }

      assignments.set(relativePath, { location, shard });
      shardCounts[shard] += 1;
    }

    if (shardCounts[shard] === 0) errors.push(`${manifestRelativePath}: no test files`);
  }

  const discovered = ordinaryTestFiles(root);
  const discoveredSet = new Set(discovered);
  for (const file of discovered) {
    if (!assignments.has(file)) errors.push(`${file}: not assigned to a test shard`);
  }
  for (const [file, assignment] of assignments) {
    if (existsSync(resolve(root, file)) && !discoveredSet.has(file)) {
      errors.push(`${assignment.location}: listed path is not an ordinary test file: ${file}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Test shard coverage failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }

  return { shardCounts, testCount: discovered.length };
}

if (import.meta.main) {
  try {
    const coverage = checkTestShards();
    console.log(`All ${coverage.testCount} ordinary tests are assigned exactly once ` + `(${coverage.shardCounts.unit} unit, ${coverage.shardCounts.integration} integration).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
