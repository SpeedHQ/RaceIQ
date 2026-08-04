import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import { releaseFeatureFlags } from "../shared/release-feature-flags";

const root = process.cwd();
const distDir = join(root, "dist");

async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(" ")}`);
  }
}

/**
 * Name of the `@libsql/<target>` package holding the native addon for the
 * host. Mirrors the target selection in `node_modules/libsql/index.js`.
 */
function libsqlTarget(): string {
  const { platform, arch } = process;
  if (platform === "win32") {
    return arch === "arm64" ? "win32-arm64-msvc" : "win32-x64-msvc";
  }
  if (platform === "darwin") {
    return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (platform === "linux") {
    // libsql treats Bun's musl report as glibc when glibc is actually present.
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    const libc = report?.header?.glibcVersionRuntime ? "gnu" : "musl";
    if (arch === "arm64") return `linux-arm64-${libc}`;
    if (arch === "arm") return `linux-arm-${libc === "gnu" ? "gnueabihf" : "musleabihf"}`;
    return `linux-x64-${libc}`;
  }
  throw new Error(`Unsupported platform for libsql native addon: ${platform}/${arch}`);
}

/**
 * Copy the libsql native addon next to the binary — native `.node` modules
 * can't be embedded in a Bun single-file executable (oven-sh/bun#18909), so
 * the compiled binary resolves `@libsql/<target>` from `node_modules` beside
 * itself at runtime (hence the binary is launched with cwd = dist/).
 *
 * Resolved via `Bun.resolveSync` rather than a hardcoded
 * `node_modules/@libsql/...` path so this also works with Bun's isolated
 * node_modules layout, where the package only exists under `node_modules/.bun`.
 */
function copyLibsqlAddon() {
  const target = libsqlTarget();
  // Resolve from the `libsql` package first: the platform packages are its
  // optional deps, so under an isolated layout they only sit next to it.
  const from: string[] = [root];
  try {
    from.unshift(dirname(Bun.resolveSync("libsql/package.json", root)));
  } catch {}
  let pkgDir: string | undefined;
  for (const dir of from) {
    try {
      pkgDir = dirname(Bun.resolveSync(`@libsql/${target}/package.json`, dir));
      break;
    } catch {}
  }
  if (!pkgDir) {
    throw new Error(
      `Could not resolve @libsql/${target} — install it before building ` +
        `(the compiled binary needs the native addon copied into dist/node_modules).`,
    );
  }
  const destDir = join(distDir, "node_modules", "@libsql", target);
  mkdirSync(destDir, { recursive: true });
  cpSync(join(pkgDir, "index.node"), join(destDir, "index.node"));
  cpSync(join(pkgDir, "package.json"), join(destDir, "package.json"));
  console.log(`→ Copied libsql native addon (@libsql/${target})`);
}

async function main() {
  releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER,
  });
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  await run(["bun", "run", "build"], { cwd: join(root, "client") });
  await run(["bun", "scripts/build/copy-shared-data.ts"]);
  await run(["bun", "scripts/build/copy-client-dist.ts"]);

  const compileArgs = [
    "bun",
    "build",
    "--compile",
    "--define",
    'process.env.NODE_ENV="production"',
  ];
  compileArgs.push(
    "--define",
    `process.env.RACEIQ_FEATURE_F1_EXPERIMENTS=${JSON.stringify(process.env.RACEIQ_FEATURE_F1_EXPERIMENTS)}`,
    "--define",
    `process.env.RACEIQ_FEATURE_IRACING_ADAPTER=${JSON.stringify(process.env.RACEIQ_FEATURE_IRACING_ADAPTER)}`,
  );

  if (process.platform === "win32") {
    const iconPath = join(root, "assets", "raceiq.ico");
    if (existsSync(iconPath)) {
      compileArgs.push(`--windows-icon=${iconPath}`);
    }
    compileArgs.push(
      "--windows-title=RaceIQ",
      "--windows-publisher=SpeedHQ",
      '--windows-description=RaceIQ',
    );
  }

  compileArgs.push("server/bootstrap.ts", "--outfile", join(distDir, "raceiq"));

  await run(compileArgs, { env: { NODE_ENV: "production" } });

  copyLibsqlAddon();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
