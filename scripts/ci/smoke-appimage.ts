import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const image = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun smoke-appimage.ts <APPIMAGE_PATH>");
const ports = [13117, 15317];
for (const port of ports) {
  const check = spawnSync("bash", ["-lc", `! (echo >/dev/tcp/127.0.0.1/${port}) 2>/dev/null`]);
  if (check.status !== 0) throw new Error(`Smoke port ${port} is occupied`);
}
const work = mkdtempSync(join(tmpdir(), "raceiq AppImage smoke "));
const home = join(work, "home");
const cwd = join(work, "empty cwd");
const bin = join(work, "bin");
const dataOverride = join(work, "explicit data");
mkdirSync(home); mkdirSync(cwd); mkdirSync(bin);
writeFileSync(join(bin, "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const copied = join(work, "RaceIQ image.AppImage");
copyFileSync(image, copied); chmodSync(copied, statSync(copied).mode | 0o111);
let child: ChildProcess | undefined;
let group: number | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function stop() {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-(group ?? child.pid!), "SIGTERM"); } catch {}
  await Promise.race([new Promise<void>((r) => child!.once("exit", () => r())), sleep(10000)]);
  if (child.exitCode === null) { try { process.kill(-(group ?? child.pid!), "SIGKILL"); } catch {} }
}
async function launch(dataDir?: string) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, APPIMAGE_EXTRACT_AND_RUN: "1", NODE_ENV: "production", PORT: String(ports[0]), UDP_PORT: String(ports[1]), PATH: `${bin}:/usr/bin:/bin` };
  delete env.APPDATA; delete env.DATA_DIR;
  if (dataDir) env.DATA_DIR = dataDir;
  child = spawn(copied, [], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  group = child.pid;
  let log = "";
  child.stdout!.on("data", (x) => { log = (log + x.toString()).slice(-6000); });
  child.stderr!.on("data", (x) => { log = (log + x.toString()).slice(-6000); });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`AppImage exited ${child.exitCode}: ${log}`);
    try {
      const response = await fetch(`http://127.0.0.1:${ports[0]}/`);
      if (response.status === 200 && (await response.text()).includes("<html")) return log;
    } catch {}
    await sleep(500);
  }
  throw new Error(`AppImage startup timed out: ${log}`);
}
async function verify() {
  const page = await fetch(`http://127.0.0.1:${ports[0]}/`);
  const html = await page.text();
  const asset = html.match(/(?:src|href)="([^"]+\.js(?:\?[^"]*)?)"/i)?.[1];
  if (!asset) throw new Error("No local JS asset referenced by application HTML");
  const js = await fetch(new URL(asset, `http://127.0.0.1:${ports[0]}/`));
  if (js.status !== 200 || !(await js.text()).trim()) throw new Error(`JS asset request failed: ${js.status}`);
}
try {
  await launch(); await verify();
  const settings = join(home, "RaceIQ", "settings.json");
  const db = join(home, "RaceIQ", "app.db");
  if (!existsSync(settings) || !existsSync(db)) throw new Error("Default user data missing app.db/settings.json");
  const current = JSON.parse(readFileSync(settings, "utf8"));
  current.driverName = "AppImagePersistenceSmoke";
  writeFileSync(settings, JSON.stringify(current));
  await stop(); child = undefined;
  await launch(); await verify();
  if (JSON.parse(readFileSync(settings, "utf8")).driverName !== "AppImagePersistenceSmoke") throw new Error("Settings did not persist across restart");
  await stop(); child = undefined;
  await launch(dataOverride); await verify();
  if (!existsSync(join(dataOverride, "app.db")) || !existsSync(join(dataOverride, "settings.json"))) throw new Error("Explicit DATA_DIR was not used");
  await stop(); child = undefined;
  console.log("AppImage startup, assets, native DB, persistence, and DATA_DIR override passed");
} finally {
  await stop();
  rmSync(work, { recursive: true, force: true });
}
