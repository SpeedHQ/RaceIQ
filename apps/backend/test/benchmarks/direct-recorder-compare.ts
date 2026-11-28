import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { workloads, type Result } from "./direct-recorder-workloads";

const [baseline, output, childMode, resultFile] = Bun.argv.slice(2);
const root = resolve(import.meta.dir, "../../../..");
if (childMode && resultFile) {
  await writeFile(resultFile, JSON.stringify(await workloads(childMode, dirname(resultFile))));
} else {
  if (!baseline || !output) throw Error("Usage: bun run bench:direct-compare <baseline-checkout> <output.json>");
  const files = ["direct-recorder-compare.ts", "direct-recorder-workloads.ts", "live-lossless-release.bench.ts"];
  const roots = [resolve(baseline), root];
  const reports = await Promise.all(roots.map(async cwd => {
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd });
    const rev = git("rev-parse", "HEAD"); assert.equal(rev.exitCode, 0);
    assert.equal(git("diff", "--quiet", "HEAD", "--", "server", "packages").exitCode, 0, `Uncommitted production changes in ${cwd}`);
    const hash = createHash("sha256");
    for (const file of files) hash.update(await readFile(join(cwd, "apps/backend/test/benchmarks", file)));
    return { revision: rev.stdout.toString().trim(), driver: hash.digest("hex"), runtime: Bun.version, platform: `${process.platform}/${process.arch}/${release()}`, cpu: cpus()[0]?.model, trials: [] as Result[][] };
  }));
  assert.equal(reports[0]!.driver, reports[1]!.driver, "Benchmark drivers differ");
  assert.notEqual(reports[0]!.revision, reports[1]!.revision, "Expected distinct revisions");
  const dir = await mkdtemp(join(tmpdir(), "raceiq-direct-compare-"));
  try {
    for (let trial = 0; trial < 2; trial++) {
      for (const side of trial ? [1, 0] : [0, 1]) {
        const rows: Result[] = [];
        for (const mode of ["burst", "paced", "partition-time", "publication-time", "partition-rss", "publication-rss"]) {
          const cwd = roots[side]!, path = join(dir, `${trial}-${side}-${mode}.json`);
          const child = Bun.spawn([process.execPath, join(cwd, "apps/backend/test/benchmarks", files[0]!), "child", "child", mode, path], { cwd, env: { ...process.env, DATA_DIR: join(dir, `db-${side}-${trial}-${mode}`), RACEIQ_TEST_MODE: "1" }, stdout: "inherit", stderr: "inherit" });
          assert.equal(await child.exited, 0, `${side}/${mode} failed`);
          rows.push(...JSON.parse(await readFile(path, "utf8")) as Result[]);
        }
        reports[side]!.trials.push(rows);
      }
    }
    const table = ["| Workload | Metric | Baseline | Current | Reduction |", "|---|---|---:|---:|---:|"];
    for (const ref of reports[0]!.trials[0]!) {
      const groups = reports.map(report => report.trials.map(trial => {
        const row = trial.find(r => r.workload === ref.workload);
        assert.ok(row); assert.deepEqual(row.controls, ref.controls); assert.deepEqual(Object.keys(row.samples), Object.keys(ref.samples));
        return row.samples;
      }));
      for (const key of Object.keys(ref.samples)) {
        const [a, b] = groups.map(group => {
          const values = group.flatMap(s => s[key]!).sort((x, y) => x - y);
          assert.ok(values.length && values.every(Number.isFinite));
          if (key === "startDelayMs") return values[Math.ceil(values.length * .95) - 1]!;
          if (["missed", "submitted", "committed"].includes(key)) return values.reduce((x, y) => x + y);
          return (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2;
        }) as [number, number];
        table.push(`| ${ref.workload} | ${key === "startDelayMs" ? "startDelayP95Ms" : key} | ${a.toFixed(3)} | ${b.toFixed(3)} | ${a && !["submitted", "committed"].includes(key) ? ((1 - b / a) * 100).toFixed(1) + "%" : "—"} |`);
      }
    }
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, JSON.stringify(reports, null, 2));
    await writeFile(`${output}.md`, table.join("\n") + "\n");
    console.log(table.join("\n"));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
