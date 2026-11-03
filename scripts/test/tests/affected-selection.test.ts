import { expect, test } from "bun:test";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { generateTurboInputs } from "../turbo-inputs";

const project = resolve(import.meta.dir, "../../..");

function copyFixtureFile(source: string, destination: string) {
  let stat;
  try {
    stat = lstatSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) return;
  mkdirSync(dirname(destination), { recursive: true });
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
  else copyFileSync(source, destination);
}

test("fixture copying preserves dangling symlinks without following them", () => {
  const root = mkdtempSync(resolve(tmpdir(), "turbo-copy-"));
  try {
    symlinkSync("missing-target", resolve(root, "source"));
    copyFixtureFile(resolve(root, "source"), resolve(root, "nested/copy"));
    expect(lstatSync(resolve(root, "nested/copy")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(resolve(root, "nested/copy"))).toBe("missing-target");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "turbo-affected-"));
  const put = (path: string, data: string) => {
    const file = resolve(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.toString().trim();
  };
  const snapshot = (parent?: string) => {
    git("add", ".");
    const tree = git("write-tree");
    const data = `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author Fixture <fixture@example.com> 1700000000 +0000\ncommitter Fixture <fixture@example.com> 1700000000 +0000\n\nfixture\n`;
    const result = Bun.spawnSync(["git", "hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: root, stdin: Buffer.from(data), stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-b", "main");
  put(".gitignore", "node_modules\n.turbo\n");
  put("package.json", JSON.stringify({ name: "fixture", private: true, packageManager: "npm@10.0.0", workspaces: ["packages/*"] }));
  put("package-lock.json", JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: { "": { name: "fixture", workspaces: ["packages/*"] } } }));
  put("turbo.json", JSON.stringify({ futureFlags: { affectedUsingTaskInputs: true }, tasks: {
    transit: { dependsOn: ["^transit"], inputs: ["src/**"] },
    "test:unit": { dependsOn: ["transit"], inputs: ["test/**"], env: ["FIXTURE_VALUE"] },
    "test:integration": { dependsOn: ["transit"], inputs: ["test/**"] },
  } }));
  for (const name of ["leaf", "consumer", "downstream", "unrelated"]) {
    const dependency = name === "consumer" ? "leaf" : name === "downstream" ? "consumer" : undefined;
    put(`packages/${name}/package.json`, JSON.stringify({ name, version: "1.0.0", scripts: { "test:unit": "node -e \"console.log('suite executed')\"", "test:integration": "node -e \"console.log('integration executed')\"" }, ...(dependency ? { dependencies: { [dependency]: "*" } } : {}) }));
    put(`packages/${name}/src/index.js`, dependency ? `export { name } from '${dependency}';\n` : `export const name = '${name}';\n`);
    put(`packages/${name}/test/unit-files.txt`, `packages/${name}/test/unit.test.ts\n`);
    put(`packages/${name}/test/unit.test.ts`, name === "leaf" ? "import './shared-helper.js';\n" : `// ${name}\n`);
    put(`packages/${name}/test/integration-files.txt`, `packages/${name}/test/integration.test.ts\n`);
    put(`packages/${name}/test/integration.test.ts`, name === "leaf" ? "import './shared-helper.js';\n" : `// ${name}\n`);
  }
  put("packages/leaf/test/shared-helper.js", "export const helper = true;\n");
  mkdirSync(resolve(root, "scripts/test"), { recursive: true });
  copyFileSync(resolve(project, "scripts/test/run-turbo.ts"), resolve(root, "scripts/test/run-turbo.ts"));
  copyFileSync(resolve(project, "scripts/test/owners.ts"), resolve(root, "scripts/test/owners.ts"));
  copyFileSync(resolve(project, "scripts/test/check-shards.ts"), resolve(root, "scripts/test/check-shards.ts"));
  copyFileSync(resolve(project, "scripts/test/turbo-inputs.ts"), resolve(root, "scripts/test/turbo-inputs.ts"));
  symlinkSync(resolve(project, "node_modules"), resolve(root, "node_modules"), "dir");
  const base = snapshot();
  git("update-ref", "refs/heads/main", base);
  put("packages/leaf/test/unit.test.ts", "// changed leaf\n");
  const head = snapshot(base);
  git("update-ref", "refs/heads/feature", head);
  git("symbolic-ref", "HEAD", "refs/heads/feature");
  git("reset", "--mixed", head);
  const run = (args: string[], range: Record<string, string | undefined> = {}) => {
    const env = { ...process.env, TURBO_SCM_BASE: undefined, TURBO_SCM_HEAD: undefined, ...range };
    return Bun.spawnSync([process.execPath, resolve(root, "scripts/test/run-turbo.ts"), "test:unit", ...args], {
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
  };
  const selected = (range: Record<string, string | undefined> = {}) => {
    const result = run(["--affected", "--dry=json"], range);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const json = JSON.parse(result.stdout.toString()) as { tasks: Array<{ task: string; package: string }> };
    return { result, packages: json.tasks.filter((task) => task.task === "test:unit").map((task) => task.package).sort() };
  };
  return { root, put, git, snapshot, base, head, run, selected, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("generated suite inputs do not mutate inherited or other owner tasks", () => {
  const f = fixture();
  try {
    const config = JSON.parse(generateTurboInputs(f.root)) as { tasks: Record<string, { inputs: string[] }> };
    expect(config.tasks["test:unit"]!.inputs).toEqual(["test/**"]);
    expect(config.tasks["leaf#test:unit"]!.inputs).toContain("!test/integration.test.ts");
    expect(config.tasks["leaf#test:unit"]!.inputs).not.toContain("!$TURBO_ROOT$/packages/consumer/test/integration.test.ts");
    expect(config.tasks["leaf#test:integration"]!.inputs).toContain("!test/unit.test.ts");
    expect(config.tasks["consumer#test:unit"]!.inputs).not.toContain("!$TURBO_ROOT$/packages/leaf/test/integration.test.ts");
  } finally { f.cleanup(); }
});

test("generated suite inputs refuse to replace a qualified root task", () => {
  const f = fixture();
  try {
    f.put("turbo.json", JSON.stringify({ tasks: {
      "test:unit": { inputs: ["test/**"] },
      "test:integration": { inputs: ["test/**"] },
      "leaf#test:unit": { inputs: ["special/**"] },
    } }));
    expect(() => generateTurboInputs(f.root)).toThrow("cannot generate leaf#test:unit over an existing task");
  } finally { f.cleanup(); }
});

test("package task overrides retain generated suite isolation", () => {
  const f = fixture();
  try {
    f.put("packages/leaf/turbo.json", JSON.stringify({
      extends: ["//"],
      tasks: { "test:unit": { inputs: ["$TURBO_EXTENDS$", "extra/**"] } },
    }));
    f.put("packages/leaf/extra/data.txt", "package-specific input\n");
    const generated = JSON.parse(generateTurboInputs(f.root)) as { tasks: Record<string, { inputs: string[] }> };
    expect(generated.tasks["leaf#test:unit"]!.inputs).toContain("extra/**");
    expect(generated.tasks["leaf#test:unit"]!.inputs).toContain("!test/integration.test.ts");
    const baseline = f.snapshot(f.head);
    f.git("update-ref", "refs/heads/main", baseline);
    f.git("reset", "--mixed", baseline);
    f.put("packages/leaf/test/integration.test.ts", "// changed integration\n");
    expect(f.selected().packages).toEqual([]);
  } finally { f.cleanup(); }
});

test("native defaults select committed leaf tests and execute the suite", () => {
  const f = fixture();
  try {
    expect(f.selected().packages).toEqual(["leaf"]);
    const executed = f.run(["--affected", "--cache=local:"]);
    expect(executed.exitCode, executed.stderr.toString()).toBe(0);
    expect(executed.stdout.toString()).toContain("suite executed");
  } finally { f.cleanup(); }
});

test("native defaults select modified working-tree leaf tests", () => {
  const f = fixture();
  try {
    f.git("update-ref", "refs/heads/main", f.head);
    f.put("packages/leaf/test/unit.test.ts", "// modified\n");
    expect(f.selected().packages).toEqual(["leaf"]);
  } finally { f.cleanup(); }
});

test("native defaults select untracked working-tree leaf tests", () => {
  const f = fixture();
  try {
    f.git("update-ref", "refs/heads/main", f.head);
    f.put("packages/leaf/test/new.test.ts", "// untracked\n");
    f.put("packages/leaf/test/unit-files.txt", "packages/leaf/test/unit.test.ts\npackages/leaf/test/new.test.ts\n");
    expect(f.selected().packages).toEqual(["leaf"]);
  } finally { f.cleanup(); }
});

test("unassigned tests fail closed before Turbo selection", () => {
  const f = fixture();
  try {
    for (const path of ["packages/leaf/test/unknown.test.ts", "packages/leaf/test/nested/unknown.test.tsx", "packages/leaf/src/new.test.ts", "packages/leaf/src/nested/new.test.tsx", "test/unowned.test.ts"]) {
      f.put(path, "// unassigned\n");
      const result = f.run(["--affected", "--dry=json"]);
      expect(result.exitCode, path).not.toBe(0);
      expect(result.stderr.toString()).toContain(path);
      rmSync(resolve(f.root, path));
    }
  } finally { f.cleanup(); }
});

test("workspace test discovery preserves browser specs and excluded fixture conventions", () => {
  const f = fixture();
  try {
    f.put("packages/leaf/src/example.spec.ts", "// browser spec\n");
    f.put("packages/disabled/package.json", JSON.stringify({ name: "disabled", raceiq: { testOwner: false } }));
    f.put("packages/disabled/src/example.test.ts", "// disabled owner\n");
    f.put("packages/leaf/src/fixtures/example.test.ts", "// fixture\n");
    f.put("packages/leaf/src/artifacts/example.test.tsx", "// artifact\n");
    expect(() => generateTurboInputs(f.root)).not.toThrow();
  } finally { f.cleanup(); }
});

test("another suite's owned test and manifest do not select unit", () => {
  const f = fixture();
  try {
    f.git("update-ref", "refs/heads/main", f.head);
    f.put("packages/leaf/test/integration.test.ts", "// changed integration\n");
    f.put("packages/leaf/test/integration-files.txt", "# changed\npackages/leaf/test/integration.test.ts\n");
    expect(f.selected().packages).toEqual([]);
    const result = Bun.spawnSync([process.execPath, resolve(f.root, "scripts/test/run-turbo.ts"), "test:integration", "--affected"], {
      cwd: f.root, env: { ...process.env, TURBO_SCM_BASE: undefined, TURBO_SCM_HEAD: undefined }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("integration executed");
  } finally { f.cleanup(); }
});

test("explicit valid ranges preserve selection", () => {
  const f = fixture();
  try {
    for (const range of [
      { TURBO_SCM_BASE: f.base, TURBO_SCM_HEAD: f.head },
      { TURBO_SCM_BASE: f.base },
      { TURBO_SCM_HEAD: f.head },
    ]) expect(f.selected(range).packages).toEqual(["leaf"]);
  } finally { f.cleanup(); }
});

test("invalid and equal ranges select full", () => {
  const f = fixture();
  try {
    for (const range of [
      { TURBO_SCM_BASE: "", TURBO_SCM_HEAD: f.head },
      { TURBO_SCM_BASE: "missing", TURBO_SCM_HEAD: f.head },
      { TURBO_SCM_BASE: f.head, TURBO_SCM_HEAD: f.head },
    ]) {
      const selection = f.selected(range);
      expect(selection.packages).toEqual(["consumer", "downstream", "leaf", "unrelated"]);
      expect(selection.result.stderr.toString()).toContain("running full task selection");
    }
  } finally { f.cleanup(); }
});

test("shallow history selects affected when range is available and full when missing", () => {
  const f = fixture();
  try {
    f.put(".git/shallow", `${f.base}\n`);
    expect(f.selected({ TURBO_SCM_BASE: f.base, TURBO_SCM_HEAD: f.head }).packages).toEqual(["leaf"]);
    f.put(".git/shallow", `${f.head}\n`);
    const shallow = f.selected({ TURBO_SCM_BASE: f.base, TURBO_SCM_HEAD: f.head });
    expect(shallow.packages).toEqual(["consumer", "downstream", "leaf", "unrelated"]);
    expect(shallow.result.stderr.toString()).toContain("running full task selection");
  } finally { f.cleanup(); }
});

test("non-affected invocation selects the full graph", () => {
  const f = fixture();
  try {
    const full = f.run(["--dry=json"]);
    expect(full.exitCode, full.stderr.toString()).toBe(0);
    const output = JSON.parse(full.stdout.toString()) as { tasks: Array<{ task: string }> };
    const tasks = output.tasks;
    expect(tasks.filter((task) => task.task === "test:unit")).toHaveLength(4);
  } finally { f.cleanup(); }
});

test("test helpers stay local while production changes reach transitive consumers", () => {
  const f = fixture();
  try {
    f.git("update-ref", "refs/heads/main", f.head);
    f.put("packages/leaf/test/shared-helper.js", "export const helper = false;\n");
    expect(f.selected().packages).toEqual(["leaf"]);
    f.git("checkout", "--", "packages/leaf/test/shared-helper.js");
    f.put("packages/leaf/src/index.js", "export const name = 'changed';\n");
    expect(f.selected().packages).toEqual(["consumer", "downstream", "leaf"]);
    const executed = f.run(["--affected", "--cache=local:"]);
    expect(executed.exitCode, executed.stderr.toString()).toBe(0);
    expect(executed.stdout.toString()).toContain("suite executed");
  } finally { f.cleanup(); }
});

test("deterministic suite cache hits and invalidates on relevant input", () => {
  const f = fixture();
  try {
    const run = (value = "one") => f.run(["--filter=leaf"], { FIXTURE_VALUE: value });
    const first = run();
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const second = run();
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(second.stdout.toString()).toMatch(/leaf:test:unit: cache hit/);
    f.put("packages/leaf/test/shared-helper.js", "export const helper = false;\n");
    const changed = run();
    expect(changed.exitCode, changed.stderr.toString()).toBe(0);
    expect(changed.stdout.toString()).toMatch(/leaf:test:unit: cache miss/);
    expect(changed.stdout.toString()).toContain("suite executed");
    f.put("packages/unrelated/test/unit.test.ts", "// unrelated change\n");
    const unrelated = run();
    expect(unrelated.exitCode, unrelated.stderr.toString()).toBe(0);
    expect(unrelated.stdout.toString()).toMatch(/leaf:test:unit: cache hit/);
    const environment = run("two");
    expect(environment.exitCode, environment.stderr.toString()).toBe(0);
    expect(environment.stdout.toString()).toMatch(/leaf:test:unit: cache miss/);
    expect(environment.stdout.toString()).toContain("suite executed");
  } finally { f.cleanup(); }
});

test("real owner suites retain selection, helper, fixture, and cache boundaries", () => {
  const root = mkdtempSync(resolve(tmpdir(), "turbo-real-owner-"));
  const command = (args: string[], cwd = root, env = process.env) =>
    Bun.spawnSync(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const git = (...args: string[]) => {
    const result = command(["git", ...args]);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.toString().trim();
  };
  const put = (path: string, data: string | Buffer) => {
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, data);
  };
  const snapshot = (parent?: string) => {
    git("add", ".");
    const tree = git("write-tree");
    const content = `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author Fixture <fixture@example.com> 1700000000 +0000\ncommitter Fixture <fixture@example.com> 1700000000 +0000\n\nfixture\n`;
    const result = Bun.spawnSync(["git", "hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: root, stdin: Buffer.from(content), stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    const files = command(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".", ":(exclude).claude"], project);
    expect(files.exitCode, files.stderr.toString()).toBe(0);
    for (const path of files.stdout.toString().split("\0").filter(Boolean)) {
      copyFixtureFile(resolve(project, path), resolve(root, path));
    }
    symlinkSync(resolve(project, "node_modules"), resolve(root, "node_modules"), "dir");
    git("init", "-b", "main");
    const base = snapshot();
    put("real-owner-baseline.txt", "baseline\n");
    const head = snapshot(base);
    git("update-ref", "refs/heads/main", head);
    git("reset", "--mixed", head);
    const env = { ...process.env, TURBO_SCM_BASE: base, TURBO_SCM_HEAD: head };
    const run = (...args: string[]) => command([process.execPath, resolve(root, "scripts/test/run-turbo.ts"), ...args], root, env);
    const query = (...tasks: string[]) => {
      const result = run(...tasks, "--affected", "--dry=json");
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const selection = JSON.parse(result.stdout.toString()) as { tasks: Array<{ task: string; package: string }> };
      return selection.tasks;
    };
    const owner = "@raceiq/frontend-contract-tests";
    const cases = [
      ["unit", "test:unit"],
      ["tooling", "test:tooling"],
      ["integration", "test:integration"],
      ["e2e", "test:e2e:recordings"],
    ] as const;
    for (const [suite, task] of cases) {
      const manifest = `packages/frontend-contract-tests/test/${suite}-files.txt`;
      const contents = readFileSync(resolve(root, manifest), "utf8");
      const testFile = contents.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#"))!;
      for (const path of [testFile, manifest]) {
        const original = readFileSync(resolve(root, path), "utf8");
        put(path, `${original}\n${path === manifest ? "#" : "//"} selection probe\n`);
        const selected = query(...cases.map((entry) => entry[1]));
        expect(selected.some((entry) => entry.package === owner && entry.task === task), path).toBe(true);
        for (const [, other] of cases) {
          if (other !== task) expect(selected.some((entry) => entry.package === owner && entry.task === other), path).toBe(false);
        }
        put(path, original);
      }
    }
    const helper = "packages/game-lmu/test/support/fixtures.ts";
    const helperContent = readFileSync(resolve(root, helper), "utf8");
    put(helper, `${helperContent}\n// selection probe\n`);
    const helperSelection = query("test:unit", "test:integration", "test:e2e:recordings");
    for (const task of ["test:unit", "test:integration", "test:e2e:recordings"]) {
      expect(helperSelection.some((entry) => entry.package === "@raceiq/game-lmu-tests" && entry.task === task), task).toBe(true);
    }
    put(helper, helperContent);
    const fixture = "packages/game-lmu/test/fixtures/sessions/lmu-real-opponents-grid-2026-10-22.bin.gz";
    const fixtureContent = readFileSync(resolve(root, fixture));
    put(fixture, Buffer.concat([fixtureContent, Buffer.from([0])]));
    expect(query("test:e2e:recordings").some((entry) => entry.package === "@raceiq/game-lmu-tests")).toBe(true);
    put(fixture, fixtureContent);
    const addedFixture = "packages/game-lmu/test/fixtures/sessions/selection-probe.bin.gz";
    put(addedFixture, fixtureContent);
    expect(query("test:e2e:recordings").some((entry) => entry.package === "@raceiq/game-lmu-tests")).toBe(true);
    rmSync(resolve(root, addedFixture));
    rmSync(resolve(root, fixture));
    expect(query("test:e2e:recordings").some((entry) => entry.package === "@raceiq/game-lmu-tests")).toBe(true);
    put(fixture, fixtureContent);
    const renamedFixture = "packages/game-lmu/test/fixtures/sessions/selection-renamed.bin.gz";
    rmSync(resolve(root, fixture));
    put(renamedFixture, fixtureContent);
    const renameSelection = query("test:unit", "test:integration", "test:e2e:recordings");
    for (const task of ["test:unit", "test:integration", "test:e2e:recordings"]) {
      expect(renameSelection.some((entry) => entry.package === "@raceiq/game-lmu-tests" && entry.task === task), task).toBe(true);
    }
    rmSync(resolve(root, renamedFixture));
    put(fixture, fixtureContent);
    const cacheArgs = ["test:unit", "--filter=@raceiq/tooling-build", "--output-logs=full"];
    const first = run(...cacheArgs);
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const second = run(...cacheArgs);
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(second.stdout.toString()).toMatch(/@raceiq\/tooling-build:test:unit: cache hit/);
    const testFile = "packages/tooling-build/test/copy-duckdb-runtime.test.ts";
    const original = readFileSync(resolve(root, testFile), "utf8");
    put(testFile, `${original}\n// cache probe\n`);
    const changed = run(...cacheArgs);
    expect(changed.exitCode, changed.stderr.toString()).toBe(0);
    expect(changed.stdout.toString()).toMatch(/@raceiq\/tooling-build:test:unit: cache miss/);
    const unrelated = "packages/frontend-contract-tests/test/client/websocket-url.test.ts";
    const unrelatedContent = readFileSync(resolve(root, unrelated), "utf8");
    put(unrelated, `${unrelatedContent}\n// unrelated cache probe\n`);
    const unaffected = run(...cacheArgs);
    expect(unaffected.exitCode, unaffected.stderr.toString()).toBe(0);
    expect(unaffected.stdout.toString()).toMatch(/@raceiq\/tooling-build:test:unit: cache hit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
