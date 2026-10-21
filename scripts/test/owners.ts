import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const SUITES = ["unit", "tooling", "integration", "e2e"] as const;
export type Suite = (typeof SUITES)[number];

export interface TestOwner {
  name: string;
  root: string;
}

function workspacePatterns(root: string): string[] {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const workspaces = manifest.workspaces;
  return Array.isArray(workspaces) ? workspaces : workspaces?.packages ?? [];
}

export function discoverTestOwners(root: string): TestOwner[] {
  const owners: TestOwner[] = [];
  for (const pattern of workspacePatterns(root)) {
    for (const manifestPath of new Bun.Glob(`${pattern.replace(/\\/g, "/")}/package.json`).scanSync({ cwd: root, onlyFiles: true })) {
      const ownerRoot = manifestPath.slice(0, -"/package.json".length);
      const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), "utf8")) as { name?: string };
      if (!manifest.name || manifest.name === "client") continue;
      const normalizedRoot = ownerRoot.replaceAll("\\", "/");
      if (normalizedRoot === ".." || normalizedRoot.startsWith("../") || resolve(root, normalizedRoot) !== resolve(root, manifestPath, "../")) continue;
      owners.push({ name: manifest.name, root: normalizedRoot });
    }
  }
  const unique = new Map<string, TestOwner>();
  for (const owner of owners) unique.set(owner.root, owner);
  return [...unique.values()].sort((a, b) => a.root.localeCompare(b.root));
}

export function readSuiteFiles(root: string, owner: TestOwner, suite: Suite): string[] {
  const ownerRoot = owner.root.replaceAll("\\", "/");
  const manifestRelative = `${ownerRoot}/test/${suite}-files.txt`;
  const manifest = resolve(root, manifestRelative);
  if (!existsSync(manifest)) return [];
  const files: string[] = [];
  const seen = new Set<string>();
  const text = readFileSync(manifest, "utf8");
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.replaceAll("\\", "/");
    const absolute = resolve(root, normalized);
    const repoPath = relative(root, absolute).replaceAll(sep, "/");
    const prefix = `${ownerRoot}/test/`;
    const location = `${manifestRelative}:${index + 1}`;
    if (repoPath !== normalized || !repoPath.startsWith(prefix) || repoPath === prefix.slice(0, -1)) {
      throw new Error(`${location}: path must stay inside ${prefix}: ${line}`);
    }
    if (!/\.test\.tsx?$/.test(repoPath)) throw new Error(`${location}: invalid test path: ${line}`);
    if (!existsSync(absolute)) throw new Error(`${location}: listed test file does not exist: ${repoPath}`);
    if (seen.has(repoPath)) throw new Error(`${location}: duplicate path: ${line}`);
    seen.add(repoPath);
    files.push(repoPath);
  }
  if (files.length === 0) throw new Error(`${manifestRelative}: no test files`);
  return files;
}
