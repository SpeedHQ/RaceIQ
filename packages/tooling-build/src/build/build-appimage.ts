import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const tools = [
  { name: "appimagetool", url: "https://api.github.com/repos/AppImage/appimagetool/releases/assets/610035789", sha256: "95cbe7cce9717fce90c484e34052ee7c7f1d7635b33c12525b4776826a7d29b6" },
  { name: "runtime", url: "https://api.github.com/repos/AppImage/type2-runtime/releases/assets/596078161", sha256: "156f4bdbde9c52d01814600013e0a273f0118dc2de98975f3c8c63427ec79074" },
];

async function main() {
  const [version, ...extra] = process.argv.slice(2);
  if (extra.length || !version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Usage: bun build-appimage.ts <MAJOR.MINOR.PATCH>");
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error(`AppImage build requires Linux x86_64; got ${process.platform}/${process.arch}`);
  const root = process.cwd();
  const dist = resolve(root, "dist");
  const required = ["raceiq", "public/index.html", "data", "node_modules/@libsql/linux-x64-gnu/index.node", "node_modules/@duckdb/node-bindings-linux-x64"];
  for (const item of required) if (!existsSync(join(dist, item))) throw new Error(`Missing required build output: ${join(dist, item)}`);
  const output = resolve(root, `RaceIQ-v${version}-linux-x86_64.AppImage`);
  if (existsSync(output)) throw new Error(`Refusing to overwrite existing artifact: ${output}`);
  const temp = mkdtempSync(join(tmpdir(), "raceiq-appimage-"));
  let success = false;
  try {
    const appDir = join(temp, "RaceIQ.AppDir");
    const payload = join(appDir, "usr/lib/raceiq");
    mkdirSync(payload, { recursive: true });
    await Bun.$`cp -a ${dist}/. ${payload}/`.quiet();
    writeFileSync(join(appDir, "AppRun"), `#!/bin/sh\nset -eu\nappdir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nif [ -z "${"{DATA_DIR:-}"}" ]; then DATA_DIR="${"${APPDATA:-$HOME}/RaceIQ"}"; fi\nexport DATA_DIR\nmkdir -p "$DATA_DIR"\nexec "$appdir/usr/lib/raceiq/raceiq" "$@"\n`);
    chmodSync(join(appDir, "AppRun"), 0o755);
    writeFileSync(join(appDir, "raceiq.desktop"), "[Desktop Entry]\nType=Application\nName=RaceIQ\nExec=AppRun\nIcon=raceiq\nTerminal=true\nCategories=Utility;\n");
    copyFileSync(join(root, "assets/raceiq-icon.png"), join(appDir, "raceiq.png"));
    copyFileSync(join(root, "assets/raceiq-icon.png"), join(appDir, ".DirIcon"));
    for (const tool of tools) {
      const response = await fetch(tool.url, { headers: { Accept: "application/octet-stream", "User-Agent": "RaceIQ-AppImage-build" } });
      if (!response.ok) throw new Error(`Download failed (${response.status}): ${tool.url}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== tool.sha256) throw new Error(`SHA-256 mismatch for ${tool.url}: ${digest}`);
      const path = join(temp, tool.name);
      writeFileSync(path, bytes, { mode: 0o755 });
      if (tool.name === "appimagetool") chmodSync(path, 0o755);
    }
    const toolPath = join(temp, "appimagetool");
    const runtimePath = join(temp, "runtime");
    const proc = Bun.spawn([toolPath, "--no-appstream", "--runtime-file", runtimePath, appDir, output], { cwd: root, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1", ARCH: "x86_64", VERSION: version }, stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) throw new Error("appimagetool failed");
    if (!existsSync(output)) throw new Error("appimagetool produced no output");
    chmodSync(output, 0o755);
    success = true;
    console.log(`Created ${basename(output)}`);
  } finally {
    if (!success) rmSync(output, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
