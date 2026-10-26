import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const data = await mkdtemp(join(tmpdir(), "raceiq-online-journeys-"));
let child: Bun.Subprocess | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { child?.kill(signal); });
try {
  const fixture = Bun.spawn([process.execPath, "--no-env-file", "apps/backend/test/fixtures/online-user-journeys-smoke.ts"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: "test", RACEIQ_TEST_MODE: "1", DATA_DIR: data },
    stdout: "pipe", stderr: "pipe",
  });
  child = fixture;
  const deadline = setTimeout(() => { console.error("Desktop journey fixture exceeded 30 seconds"); fixture.kill("SIGKILL"); }, 30_000);
  const output = async () => {
    let pending = "", all = "";
    const decoder = new TextDecoder();
    for await (const chunk of fixture.stdout) {
      const text = decoder.decode(chunk, { stream: true }); all += text; pending += text;
      const lines = pending.split("\n"); pending = lines.pop()!;
      for (const line of lines) if (line.startsWith("PASS ")) console.log(line);
    }
    return all;
  };
  const [code, stdout, stderr] = await Promise.all([fixture.exited, output(), new Response(fixture.stderr).text()]);
  clearTimeout(deadline);
  if (code !== 0) { console.error(stderr || stdout); process.exitCode = code || 1; }
  else {
    const replay = Bun.spawn([process.execPath, "test", "packages/online/test/server/cloud-lap-import-controller.test.ts", "--test-name-pattern", "GET preserves completion until matching ack; ack advances queued work|one denied entitlement blocks start, retry, reads and URL activation"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    child = replay;
    const [replayCode, replayOut, replayError] = await Promise.all([replay.exited, new Response(replay.stdout).text(), new Response(replay.stderr).text()]);
    if (replayCode !== 0) { console.error(replayOut + replayError); process.exitCode = replayCode || 1; }
    else console.log("PASS D10 happy\nPASS D10 fail\nDesktop journey and cloud-import checks passed.");
  }
} finally { await rm(data, { recursive: true, force: true }); }
