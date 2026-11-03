import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const project = resolve(import.meta.dir, "../../..");

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
    "test:unit": { dependsOn: ["^transit"], inputs: ["test/**"] },
  } }));
  for (const name of ["leaf", "consumer", "unrelated"]) {
    put(`packages/${name}/package.json`, JSON.stringify({ name, version: "1.0.0", scripts: { "test:unit": "node -e \"console.log('suite executed')\"" }, ...(name === "consumer" ? { dependencies: { leaf: "*" } } : {}) }));
    put(`packages/${name}/src/index.js`, `export const name = '${name}';\n`);
    put(`packages/${name}/test/unit-files.txt`, "unit.test.js\n");
    put(`packages/${name}/test/unit.test.js`, `// ${name}\n`);
  }
  put("packages/leaf/test/shared-helper.js", "export const helper = true;\n");
  mkdirSync(resolve(root, "scripts/test"), { recursive: true });
  copyFileSync(resolve(project, "scripts/test/run-turbo.ts"), resolve(root, "scripts/test/run-turbo.ts"));
  copyFileSync(resolve(project, "scripts/test/owners.ts"), resolve(root, "scripts/test/owners.ts"));
  symlinkSync(resolve(project, "node_modules"), resolve(root, "node_modules"), "dir");
  const base = snapshot();
  git("update-ref", "refs/heads/main", base);
  put("packages/leaf/test/unit.test.js", "// changed leaf\n");
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
  return { root, put, git, base, head, run, selected, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

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
    f.put("packages/leaf/test/unit.test.js", "// modified\n");
    expect(f.selected().packages).toEqual(["leaf"]);
  } finally { f.cleanup(); }
});

test("native defaults select untracked working-tree leaf tests", () => {
  const f = fixture();
  try {
    f.git("update-ref", "refs/heads/main", f.head);
    f.put("packages/leaf/test/new.test.js", "// untracked\n");
    expect(f.selected().packages).toEqual(["leaf"]);
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
      expect(selection.packages).toEqual(["consumer", "leaf", "unrelated"]);
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
    expect(shallow.packages).toEqual(["consumer", "leaf", "unrelated"]);
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
    expect(tasks.filter((task) => task.task === "test:unit")).toHaveLength(3);
  } finally { f.cleanup(); }
});
