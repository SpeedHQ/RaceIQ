import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type BuildRecorderOptions = {
  release: boolean;
  target?: string;
  destinationDir?: string;
  prebuiltPath?: string;
};

const ROOT = resolve(import.meta.dirname, "../../../..");
const MANIFEST = join(ROOT, "native/recorder/Cargo.toml");


export async function buildRecorder(options: BuildRecorderOptions): Promise<string> {
  const name = options.target?.includes("windows") ? "raceiq-recorder.exe" : "raceiq-recorder";
  const destination = resolve(options.destinationDir ?? join(ROOT, "dist"));
  mkdirSync(destination, { recursive: true });
  const stagedPath = join(destination, name);

  if (options.prebuiltPath) {
    const source = resolve(options.prebuiltPath);
    if (!statSync(source).isFile()) throw new Error(`Recorder prebuilt artifact is not a file: ${source}`);
    copyFileSync(source, stagedPath);
  } else {
    const args = ["build", "--locked", "--manifest-path", MANIFEST];
    if (options.release) args.push("--release");
    if (options.target) args.push("--target", options.target);
    const cwd = join(ROOT, "native/recorder");
    const result = spawnSync("cargo", args, { cwd, stdio: "inherit" });
    if (result.error) throw new Error(`Could not build recorder with Cargo: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Recorder Cargo build failed (${result.status ?? "unknown"}); install Rust 1.90.0 and target toolchain`);
    const profile = options.release ? "release" : "debug";
    const cargoTargetDir = process.env.CARGO_TARGET_DIR
      ? resolve(cwd, process.env.CARGO_TARGET_DIR)
      : join(cwd, "target");
    const artifact = options.target
      ? join(cargoTargetDir, options.target, profile, name)
      : join(cargoTargetDir, profile, name);
    try {
      if (!statSync(artifact).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`Recorder build artifact missing: ${artifact}`);
    }
    copyFileSync(artifact, stagedPath);
  }

  if (process.platform !== "win32") chmodSync(stagedPath, 0o755);
  const isMacTarget = options.target
    ? options.target.includes("apple-darwin")
    : process.platform === "darwin";
  if (isMacTarget) {
    const sign = spawnSync("codesign", ["--force", "--sign", "-", stagedPath], { stdio: "inherit" });
    if (sign.error || sign.status !== 0) throw new Error(`Could not sign recorder executable: ${sign.error?.message ?? sign.status}`);
    const verify = spawnSync("codesign", ["--verify", stagedPath], { stdio: "inherit" });
    if (verify.error || verify.status !== 0) throw new Error(`Could not verify recorder executable: ${verify.error?.message ?? verify.status}`);
  }
  return stagedPath;
}
