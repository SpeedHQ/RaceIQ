import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { LIVE_ENGINEER_AUDIO_PACKAGE } from "@raceiq/live-engineer/audio-package";
import { createLiveEngineerVoicePackService } from "../../src/runtime/live-engineer-voice-pack-service";
import { createLiveEngineerVoicePackRoutes } from "../../src/routes/live-engineer-voice-pack-routes";
async function status(root: string) {
  return createLiveEngineerVoicePackService({ root }).getStatus();
}

const directories: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-pack-status-"));
  directories.push(directory);
  const root = join(directory, "userdata", "voice-packs", "live-engineer", "qwen-v3");
  await mkdir(join(root, "chunks"), { recursive: true });
  const bytes = new Uint8Array([1]);
  await writeFile(join(root, "chunks/clip.flac"), bytes);
  await writeFile(join(root, "chunks/full-line.flac"), bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = { ...LIVE_ENGINEER_AUDIO_PACKAGE, clips: [{ path: "chunks/clip.flac", sha256 }], fullLines: [{ path: "chunks/full-line.flac", sha256 }] };
  return { root, manifest };
}

test("missing pack requires download, matching complete pack becomes ready on recheck", async () => {
  const { root, manifest } = await fixture();
  expect(await status(root)).toMatchObject({ state: "download-required", requiredVersion: LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion, requiredEngineVersion: LIVE_ENGINEER_AUDIO_PACKAGE.engineVersion, language: "en", installedVersion: null, downloadUrl: LIVE_ENGINEER_AUDIO_PACKAGE.downloadUrl });
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  expect(await status(root)).toMatchObject({ state: "ready", installedVersion: manifest.packageVersion, installedEngineVersion: manifest.engineVersion });
});

test("compatible newer recording revision remains ready", async () => {
  const { root, manifest } = await fixture();
  await writeFile(join(root, "manifest.json"), JSON.stringify({ ...manifest, packageVersion: "2.0.0" }));
  expect(await status(root)).toMatchObject({ state: "ready", installedVersion: "2.0.0" });
});

for (const patch of [
  { packageVersion: "0.9.0" }, { packageVersion: undefined },
  { engineVersion: 0 }, { engineVersion: 2 }, { language: "fr" },
  { catalogVersion: "live-engineer-qwen-v3" }, { catalogVersion: "2.0.0" },
  { clips: [{ path: "../outside.flac", sha256: "a".repeat(64) }] },
]) {
  test(`unsupported pack metadata requires update: ${JSON.stringify(patch)}`, async () => {
    const { root, manifest } = await fixture();
    await writeFile(join(root, "manifest.json"), JSON.stringify({ ...manifest, ...patch }));
    expect((await status(root)).state).toBe("update-required");
  });
}

test("corrupt manifest and missing referenced file require update rather than false readiness", async () => {
  const { root, manifest } = await fixture();
  await writeFile(join(root, "manifest.json"), "invalid json");
  expect((await status(root)).state).toBe("update-required");
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await rm(join(root, "chunks/clip.flac"));
  expect((await status(root)).state).toBe("update-required");
});
test("automatic schedule gates each remote lookup and uses startup cadence without import timers", async () => {
  const { root } = await fixture();
  let featureEnabled = true;
  let automaticEnabled = false;
  let startupCallback = () => {};
  let intervalCallback = () => {};
  const delays: number[] = [];
  let fetched = 0;
  const fetchedSignal = Promise.withResolvers<void>();
  let terminalSignal = Promise.withResolvers<void>();
  const service = createLiveEngineerVoicePackService({
    root,
    isFeatureEnabled: () => featureEnabled,
    isAutomaticCheckEnabled: () => automaticEnabled,
    fetchImpl: async () => {
      fetched += 1;
      fetchedSignal.resolve();
      return Response.json([]);
    },
    now: () => new Date("2026-10-22T12:00:00.000Z"),
    broadcast: () => terminalSignal.resolve(),
    timers: {
      setTimeout(callback, delay) { startupCallback = callback; delays.push(delay); return { unref() {} } as unknown as ReturnType<typeof setTimeout>; },
      setInterval(callback, delay) { intervalCallback = callback; delays.push(delay); return { unref() {} } as unknown as ReturnType<typeof setInterval>; },
      clearTimeout() {},
      clearInterval() {},
    },
  });
  const stop = service.startAutomaticChecks();
  startupCallback();
  await Promise.resolve();
  expect(fetched).toBe(0);
  featureEnabled = false;
  automaticEnabled = true;
  startupCallback();
  await Promise.resolve();
  expect(fetched).toBe(0);
  featureEnabled = true;
  startupCallback();
  await fetchedSignal.promise;
  await terminalSignal.promise;
  expect(await service.getStatus()).toMatchObject({ lastChecked: "2026-10-22T12:00:00.000Z" });
  automaticEnabled = false;
  intervalCallback();
  expect(fetched).toBe(1);
  automaticEnabled = true;
  terminalSignal = Promise.withResolvers<void>();
  intervalCallback();
  await terminalSignal.promise;
  expect(fetched).toBe(2);
  featureEnabled = false;
  intervalCallback();
  expect(fetched).toBe(2);
  stop();
  featureEnabled = true;
  startupCallback();
  intervalCallback();
  expect(fetched).toBe(2);
  expect(delays).toEqual([10_000, 4 * 60 * 60 * 1000]);
});

test("real HTTP release mirror discovers and atomically installs compatible package", async () => {
  const { root } = await fixture();
  const version = "2.0.0";
  const entries = {
    "live-engineer/qwen-v3/manifest.json": new TextEncoder().encode(JSON.stringify({
      ...LIVE_ENGINEER_AUDIO_PACKAGE,
      packageVersion: version,
      clips: [{ path: "chunks/clip.flac", sha256: createHash("sha256").update(new Uint8Array([2])).digest("hex") }],
      fullLines: [{ path: "chunks/full-line.flac", sha256: createHash("sha256").update(new Uint8Array([3])).digest("hex") }],
    })),
    "live-engineer/qwen-v3/chunks/clip.flac": new Uint8Array([2]),
    "live-engineer/qwen-v3/chunks/full-line.flac": new Uint8Array([3]),
  };
  const archive = zipSync(entries);
  const digest = createHash("sha256").update(archive).digest("hex");
  const tag = "voice-pack-en-v2.0.0";
  const metadata = { ...LIVE_ENGINEER_AUDIO_PACKAGE, packageVersion: version, sha256: digest };
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const downloadStarted = started.promise;
  const downloadGate = gate.promise;
  const mirror = Bun.serve({ port: 0, async fetch(request) {
    const target = new URL(request.url).searchParams.get("target") ?? "";
    if (target.includes("/releases?")) return Response.json([
      { tag_name: tag, draft: false, prerelease: false },
      { tag_name: "voice-pack-en-v3.0.0", draft: false, prerelease: false },
      { tag_name: "voice-pack-fr-v9.0.0", draft: false, prerelease: false },
      { tag_name: "voice-pack-en-v5.0.0", draft: true, prerelease: false },
      { tag_name: "voice-pack-en-v6.0.0", draft: false, prerelease: true },
    ]);
    if (target.endsWith(".json")) {
      if (target.includes("voice-pack-en-v3.0.0")) return new Response("{");
      return Response.json(metadata);
    }
    if (target.endsWith(".zip")) {
      started.resolve();
      await downloadGate;
      return new Response(archive);
    }
    return new Response("not found", { status: 404 });
  } });
  servers.push(mirror);
  const mirrorUrl = `http://127.0.0.1:${mirror.port}/?target=`;
  const service = createLiveEngineerVoicePackService({
    root,
    isFeatureEnabled: () => true,
    isAutomaticCheckEnabled: () => true,
    fetchImpl: (input, init) => fetch(`${mirrorUrl}${encodeURIComponent(String(input))}`, init),
    now: () => new Date("2026-10-22T12:00:00.000Z"),
  });
  const routes = createLiveEngineerVoicePackRoutes(service);
  const api = Bun.serve({ port: 0, fetch: routes.fetch });
  servers.push(api);
  const apiUrl = `http://127.0.0.1:${api.port}/api/live-engineer/voice-pack`;
  const checked = await fetch(`${apiUrl}/check`, { method: "POST" });
  expect(checked.status).toBe(200);
  expect(await checked.json()).toMatchObject({ latestVersion: version, updateAvailable: true, updateError: null });
  const installRequest = fetch(`${apiUrl}/install`, { method: "POST" });
  await downloadStarted;
  const duplicateInstall = await fetch(`${apiUrl}/install`, { method: "POST" });
  expect(duplicateInstall.status).toBe(409);
  gate.resolve();
  const installed = await installRequest;
  expect(installed.status).toBe(200);
  expect(await installed.json()).toMatchObject({ state: "ready", installedVersion: version, installing: false });
  expect(await status(root)).toMatchObject({ state: "ready", installedVersion: version });
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ ...manifest, packageVersion: "9.0.0" }));
  expect(await (await fetch(apiUrl)).json()).toMatchObject({ state: "ready", installedVersion: "9.0.0", updateAvailable: false });
  const unchanged = await fetch(`${apiUrl}/install`, { method: "POST" });
  expect(await unchanged.json()).toMatchObject({ state: "ready", installedVersion: "9.0.0" });
  await writeFile(join(root, "manifest.json"), JSON.stringify({ ...manifest, packageVersion: "9.0.0", catalogVersion: "2.0.0" }));
  expect(await (await fetch(apiUrl)).json()).toMatchObject({
    state: "update-required", installedVersion: "9.0.0", latestVersion: version, updateAvailable: true,
  });
  const repaired = await fetch(`${apiUrl}/install`, { method: "POST" });
  expect(repaired.status).toBe(200);
  expect(await repaired.json()).toMatchObject({ state: "ready", installedVersion: version, installing: false });
});
