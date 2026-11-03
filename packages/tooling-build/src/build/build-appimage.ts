import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const tools = [
  { name: "appimagetool", url: "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage", sha256: "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0" },
  { name: "runtime", url: "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64", sha256: "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d" },
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
  const updateInfo = "gh-releases-zsync|SpeedHQ|RaceIQ|latest|RaceIQ-v*-linux-x86_64.AppImage.zsync";
  const zsyncOutput = `${output}.zsync`;
  if (existsSync(output) || existsSync(zsyncOutput)) throw new Error(`Refusing to overwrite existing AppImage output: ${output}`);
  const temp = mkdtempSync(join(tmpdir(), "raceiq-appimage-"));
  let success = false;
  try {
    const appDir = join(temp, "RaceIQ.AppDir");
    const payload = join(appDir, "usr/lib/raceiq");
    mkdirSync(payload, { recursive: true });
    await Bun.$`cp -a ${dist}/. ${payload}/`.quiet();
    writeFileSync(join(appDir, "AppRun"), `#!/bin/sh\nset -eu\nappdir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nif [ -z "\${DATA_DIR:-}" ]; then DATA_DIR="\${APPDATA:-$HOME}/RaceIQ"; fi\nexport DATA_DIR\nmkdir -p "$DATA_DIR"\nexec "$appdir/usr/lib/raceiq/raceiq" "$@"\n`);
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
    const proc = Bun.spawn([toolPath, "--no-appstream", "--updateinformation", updateInfo, "--runtime-file", runtimePath, appDir, output], { cwd: root, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1", ARCH: "x86_64", VERSION: version }, stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) throw new Error("appimagetool failed");
    if (!existsSync(output) || !existsSync(zsyncOutput)) throw new Error("appimagetool must produce both AppImage and zsync metadata");
    chmodSync(output, 0o755);
    success = true;
    console.log(`Created ${basename(output)}`);
  } finally {
    if (!success) {
      rmSync(output, { force: true });
      rmSync(zsyncOutput, { force: true });
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
