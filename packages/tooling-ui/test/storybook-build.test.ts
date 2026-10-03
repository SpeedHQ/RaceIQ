import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { getStorybookBuildKey, verifyStorybookBuild } from "../src/ui/build-storybook";

const ROOT_DIR = path.resolve(import.meta.dir, "../../..");

const fixtures: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "storybook-cache-"));
  fixtures.push(root);
  const clientRoot = path.join(root, "client");
  await mkdir(clientRoot, { recursive: true });
  // Hooks export repository-local Git variables; fixtures must own their index.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const initialized = Bun.spawnSync(["git", "init", "-q", root], { cwd: root, env });
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
  await writeFile(path.join(root, "package.json"), "{}\n");
  await writeFile(path.join(clientRoot, "source.ts"), "export const value = 1;\n");
  // Historical revisions need not ignore the new cache paths.
  await writeFile(path.join(root, ".gitignore"), "");
  const staged = Bun.spawnSync(["git", "add", "."], { cwd: root, env });
  if (staged.exitCode !== 0) throw new Error(staged.stderr.toString());
  return { root, clientRoot };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("Git hook environment cannot replace caller staging", async () => {
  const parent = await fixture();
  const parentEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  await writeFile(path.join(parent.root, "caller-change.ts"), "export const callerChange = true;\n");
  const staged = Bun.spawnSync(["git", "add", "caller-change.ts"], { cwd: parent.root, env: parentEnv });
  expect(staged.exitCode).toBe(0);
  const before = Bun.spawnSync(["git", "ls-files", "--stage"], { cwd: parent.root, env: parentEnv }).stdout.toString();
  // Git exports this variable when pre-commit runs tooling tests. Set it at
  // child-process startup, exactly like a real hook, rather than mutating env.
  const hookRun = Bun.spawnSync([
    process.execPath, "test", import.meta.path,
    "--test-name-pattern", "^build key changes for tracked edits",
    "--timeout", "60000",
  ], {
    cwd: path.resolve(ROOT_DIR, "."),
    env: { ...parentEnv, GIT_INDEX_FILE: path.join(parent.root, ".git/index"), RACEIQ_UNIT_TESTS: "1" },
  });
  expect(hookRun.exitCode).toBe(0);
  const after = Bun.spawnSync(["git", "ls-files", "--stage"], { cwd: parent.root, env: parentEnv }).stdout.toString();
  expect(after).toBe(before);
});

test("build key changes for tracked edits and new untracked source files", async () => {
  const { clientRoot } = await fixture();
  const initial = await getStorybookBuildKey(clientRoot);
  await writeFile(path.join(clientRoot, "source.ts"), "export const value = 2;\n");
  const edited = await getStorybookBuildKey(clientRoot);
  expect(edited).not.toBe(initial);
  await writeFile(path.join(clientRoot, "new-story.ts"), "export const story = true;\n");
  expect(await getStorybookBuildKey(clientRoot)).not.toBe(edited);
});

test("build key handles directory symlinks and tracks their targets", async () => {
  const { root, clientRoot } = await fixture();
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const link = path.join(clientRoot, "linked-input");
  await mkdir(first);
  await mkdir(second);
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(first, link, type);
  const initial = await getStorybookBuildKey(clientRoot);
  await rm(link);
  await symlink(second, link, type);
  expect(await getStorybookBuildKey(clientRoot)).not.toBe(initial);
});

test("build key changes when Vite build environment changes", async () => {
  const { clientRoot } = await fixture();
  const previous = process.env.VITE_STORYBOOK_CACHE_TEST;
  try {
    process.env.VITE_STORYBOOK_CACHE_TEST = "first";
    const initial = await getStorybookBuildKey(clientRoot);
    process.env.VITE_STORYBOOK_CACHE_TEST = "second";
    expect(await getStorybookBuildKey(clientRoot)).not.toBe(initial);
  } finally {
    if (previous === undefined) delete process.env.VITE_STORYBOOK_CACHE_TEST;
    else process.env.VITE_STORYBOOK_CACHE_TEST = previous;
  }
});

test("verify accepts Playwright's CI environment but rejects changed or missing static assets", async () => {
  const { clientRoot } = await fixture();
  const outputRoot = path.join(clientRoot, "storybook-static");
  await mkdir(outputRoot, { recursive: true });
  const assets = { "index.html": "<html></html>", "index.json": "{}" };
  const inventory = Object.entries(assets).map(([file, contents]) => ({
    path: file,
    size: Buffer.byteLength(contents),
    digest: createHash("sha256").update(contents).digest("hex"),
  }));
  for (const [file, contents] of Object.entries(assets)) await writeFile(path.join(outputRoot, file), contents);
  const metadataPath = path.join(clientRoot, "project.inlang/.cache/raceiq-storybook-build.json");
  await mkdir(path.dirname(metadataPath), { recursive: true });
  const previousCI = process.env.CI;
  try {
    delete process.env.CI;
    await writeFile(metadataPath, JSON.stringify({ version: 1, key: await getStorybookBuildKey(clientRoot), outputs: inventory }));
    process.env.CI = "true";
    await verifyStorybookBuild(clientRoot);
  } finally {
    if (previousCI === undefined) delete process.env.CI;
    else process.env.CI = previousCI;
  }
  await writeFile(path.join(outputRoot, "index.html"), "<html>tampered</html>");
  await expect(verifyStorybookBuild(clientRoot)).rejects.toThrow("missing, stale, or corrupt");
  await writeFile(path.join(outputRoot, "index.html"), assets["index.html"]);
  await rm(path.join(outputRoot, "index.json"));
  await expect(verifyStorybookBuild(clientRoot)).rejects.toThrow("missing, stale, or corrupt");
});
