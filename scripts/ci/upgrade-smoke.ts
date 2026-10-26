import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = Bun.argv.slice(2).filter((arg) => arg !== "--");
const replay = args.includes("--replay");
const playwrightArgs = args.filter((arg) => arg !== "--replay");
const artifacts = resolve(process.env.RACEIQ_UPGRADE_ARTIFACTS_DIR ?? join(root, "playwright/test-results/source-upgrade"));
mkdirSync(artifacts, { recursive: true });
const pkg = await Bun.file(join(root, "package.json")).json() as {
  packageManager: string;
  devDependencies: { "@playwright/test": string };
};
const playwrightVersion = pkg.devDependencies["@playwright/test"];
const bunVersion = pkg.packageManager.replace(/^bun@/, "");
if (!/^\d+\.\d+\.\d+$/.test(playwrightVersion) || !/^\d+\.\d+\.\d+$/.test(bunVersion)) {
  throw new Error("Upgrade smoke requires exact Playwright and Bun versions in package.json");
}
const origin = process.env.RACEIQ_UPGRADE_REPOSITORY ?? (() => {
  const result = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Cannot resolve Git origin; set RACEIQ_UPGRADE_REPOSITORY to an HTTPS clone URL");
  return result.stdout.toString().trim();
})();
const repository = origin.replace(/^git@github\.com:/, "https://github.com/").replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");
const repositoryURL = new URL(repository);
if (repositoryURL.protocol !== "https:" || repositoryURL.username || repositoryURL.password) {
  throw new Error("Docker upgrade smoke requires an HTTPS repository URL without embedded credentials; use GH_TOKEN for authentication");
}
const containerEnv: NodeJS.ProcessEnv = { ...process.env, RACEIQ_UPGRADE_REPOSITORY: repository };
if (replay) containerEnv.RACEIQ_UPGRADE_REPLAY = "1";
if (!containerEnv.GH_TOKEN && !containerEnv.GITHUB_TOKEN) {
  const auth = Bun.spawnSync(["gh", "auth", "token", "--hostname", "github.com"], { stdout: "pipe", stderr: "pipe" });
  if (auth.exitCode === 0) containerEnv.GH_TOKEN = auth.stdout.toString().trim();
}

async function docker(args: string[], logName: string, env = process.env, allowFailure = false) {
  const output = Bun.file(join(artifacts, logName)).writer();
  const child = Bun.spawn(["docker", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const drain = async (stream: ReadableStream<Uint8Array>, terminal: NodeJS.WriteStream) => {
    for await (const chunk of stream) {
      terminal.write(chunk);
      output.write(chunk);
    }
  };
  let code: number;
  try {
    await Promise.all([drain(child.stdout, process.stdout), drain(child.stderr, process.stderr)]);
    code = await child.exited;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    await output.end();
  }
  if (code !== 0 && !allowFailure) throw new Error(`Docker upgrade smoke failed (${code}); diagnostics: ${artifacts}`);
  return code;
}

await docker(["version", "--format", "{{.Server.Version}}"], "docker-version.log");
const imageIDPath = join(artifacts, `image-${process.pid}.id`);
await docker([
  "build", "--file", "playwright/support/upgrade/Dockerfile", "--iidfile", imageIDPath,
  "--build-arg", `PLAYWRIGHT_VERSION=${playwrightVersion}`, "--build-arg", `BUN_VERSION=${bunVersion}`, ".",
], "docker-build.log");
const image = readFileSync(imageIDPath, "utf8").trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Docker build did not produce a valid immutable image ID");
const forwarded = ["GH_TOKEN", "GITHUB_TOKEN", "GH_REPO", "RACEIQ_UPGRADE_PREVIOUS_TAG", "RACEIQ_UPGRADE_REPOSITORY", "RACEIQ_UPGRADE_REPLAY"];
const containerName = `raceiq-upgrade-smoke-${process.pid}`;
console.log(`Upgrade smoke container: ${containerName} (live progress in OrbStack Logs)`);
const runStartedAt = Date.now();
const testExitCode = await docker([
  "run", "--rm", "--init", "--name", containerName, "--shm-size=1g",
  "--mount", `type=bind,source=${artifacts},target=/artifacts`,
  ...forwarded.filter((name) => containerEnv[name]).flatMap((name) => ["--env", name]),
  image, ...playwrightArgs,
], "docker-run.log", containerEnv, true);
process.exitCode = testExitCode;
if (testExitCode !== 0) console.error(`Docker upgrade smoke failed (${testExitCode}); diagnostics: ${artifacts}`);

if (replay) {
  const browserDir = join(artifacts, "browser");
  const traces = existsSync(browserDir)
    ? Array.from(new Bun.Glob("**/trace.zip").scanSync({ cwd: browserDir, absolute: true }))
      .filter((path) => statSync(path).mtimeMs >= runStartedAt)
    : [];
  if (!traces.length) {
    console.error(`No recording produced by this run; cannot replay. Diagnostics: ${artifacts}`);
    process.exitCode ||= 1;
  } else {
    console.log(`Opening local Playwright Trace Viewer for ${traces.length} recording(s). Close the viewer, then press Ctrl+C to exit.`);
    console.log(`Recordings: ${traces.join(", ")}`);
    const viewer = Bun.spawn([
      process.execPath, Bun.resolveSync("@playwright/test/cli", root),
      "show-trace", "--host", "127.0.0.1", ...traces,
    ], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    let interrupted = false;
    const closeViewer = () => { interrupted = true; viewer.kill("SIGTERM"); };
    process.once("SIGINT", closeViewer);
    process.once("SIGTERM", closeViewer);
    try {
      const viewerExitCode = await viewer.exited;
      if (!interrupted && viewerExitCode !== 0) process.exitCode ||= viewerExitCode;
    } finally {
      process.removeListener("SIGINT", closeViewer);
      process.removeListener("SIGTERM", closeViewer);
    }
  }
}
