import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("authentication resumes without consent, uploads require explicit choices, and cancelled callbacks stay signed out", async () => {
  // SDK and keystore mocks stay in a child process so they cannot contaminate other suites.
  const fixture = fileURLToPath(new URL("../fixtures/online-auth-smoke.ts", import.meta.url));
  const process = Bun.spawn([Bun.which("bun") ?? "bun", fixture], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(exitCode, [stdout, stderr].join("\n")).toBe(0);
});
