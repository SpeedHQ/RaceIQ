import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { checkTestShards } from "./check-shards";
import { discoverTestOwners, ownerTestRoot, readSuiteFiles, SUITES, type Suite } from "./owners";

type Task = Record<string, unknown> & { inputs?: string[] };
type Config = { tasks: Record<string, Task> } & Record<string, unknown>;

const suiteTasks: Record<string, Suite> = {
  "test:unit": "unit",
  "test:tooling": "tooling",
  "test:integration": "integration",
  "test:e2e:recordings": "e2e",
};

export function generateTurboInputs(root: string): string {
  checkTestShards(root);
  const config = JSON.parse(readFileSync(resolve(root, "turbo.json"), "utf8")) as Config;
  if (!config.tasks || typeof config.tasks !== "object") throw new Error("turbo.json: missing tasks");
  const owners = discoverTestOwners(root);
  const allOwners = discoverTestOwners(root, { includeDisabled: true });
  const clientRoot = "client";
  const scanRoots = [...owners.map((owner) => owner.root), clientRoot, "test"];
  for (const directory of new Set(scanRoots)) {
    if (!existsSync(resolve(root, directory))) continue;
    for (const pattern of ["**/*.test.ts", "**/*.test.tsx"]) {
      for (const file of new Bun.Glob(pattern).scanSync({ cwd: resolve(root, directory), onlyFiles: true, dot: true })) {
        const path = `${directory}/${file.replaceAll("\\", "/")}`;
        const parts = path.split("/");
        if (parts.some((part) => part === "fixtures" || part === "artifacts" || part === "node_modules")) continue;
        if (allOwners.some((owner) => owner.disabled && (path === owner.root || path.startsWith(`${owner.root}/`)))) continue;
        if (parts.some((part) => part.startsWith("."))) {
          throw new Error(`${path}: hidden ordinary test is not covered by test discovery`);
        }
        if (directory === clientRoot && !path.startsWith(`${clientRoot}/test/`)) {
          throw new Error(`${path}: ordinary test is outside an owner test root`);
        }
      }
    }
  }
  for (const owner of owners) {
    for (const pattern of ["**/*.test.ts", "**/*.test.tsx"]) {
      for (const file of new Bun.Glob(pattern).scanSync({ cwd: resolve(root, owner.root), onlyFiles: true })) {
        const path = `${owner.root}/${file.replaceAll("\\", "/")}`;
        if (file.split(/[\\/]/).some((part) => part === "fixtures" || part === "artifacts" || part === "node_modules")) continue;
        if (allOwners.some((nested) => nested.root !== owner.root && nested.root.startsWith(`${owner.root}/`) && path.startsWith(`${nested.root}/`))) continue;
        if (!path.startsWith(`${ownerTestRoot(owner)}/`)) {
          throw new Error(`${path}: ordinary test is outside an owner test root`);
        }
      }
    }
  }
  for (const owner of owners) {
    const ownerConfigPath = resolve(root, owner.root, "turbo.json");
    const ownerConfig = existsSync(ownerConfigPath)
      ? JSON.parse(readFileSync(ownerConfigPath, "utf8")) as Config
      : { tasks: {} };
    const testRoot = ownerTestRoot(owner);
    const files = Object.fromEntries(SUITES.map((suite) => [suite, readSuiteFiles(root, owner, suite)])) as Record<Suite, string[]>;
    for (const [taskName, suite] of Object.entries(suiteTasks)) {
      if (!existsSync(resolve(root, testRoot, `${suite}-files.txt`))) continue;
      if (config.tasks[`${owner.name}#${taskName}`]) {
        throw new Error(`turbo.json: cannot generate ${owner.name}#${taskName} over an existing task`);
      }
      const inherited = config.tasks[taskName];
      if (!inherited) throw new Error(`turbo.json: missing ${taskName} for ${owner.name}`);
      const override = ownerConfig.tasks?.[taskName] ?? {};
      const baseInputs = inherited.inputs ?? ["$TURBO_DEFAULT$"];
      if (!Array.isArray(baseInputs) || !baseInputs.every((input) => typeof input === "string")) throw new Error(`${taskName}: invalid inputs`);
      const inputs = override.inputs === undefined ? [...baseInputs] : override.inputs.flatMap((input) => input === "$TURBO_EXTENDS$" ? baseInputs : [input]);
      const excluded = SUITES.filter((other) => other !== suite).flatMap((other) => [
        ...files[other],
        `${testRoot}/${other}-files.txt`,
      ]);
      for (const file of excluded) {
        if (/[*?[\]{}!]/.test(file)) throw new Error(`Cannot generate Turbo input for path with glob characters: ${file}`);
        inputs.push(`!$TURBO_ROOT$/${file}`);
        const local = relative(resolve(root, owner.root), resolve(root, file)).replaceAll("\\", "/");
        if (!local.startsWith("../")) inputs.push(`!${local}`);
      }
      inputs.push("$TURBO_ROOT$/scripts/test/turbo-inputs.ts");
      config.tasks[`${owner.name}#${taskName}`] = { ...inherited, ...override, inputs };
    }
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}
