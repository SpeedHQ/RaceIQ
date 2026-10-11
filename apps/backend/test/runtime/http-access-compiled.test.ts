import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("packaged access policy stays in production without runtime NODE_ENV", () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-compiled-access-"));
  try {
    const entry = join(directory, "entry.ts");
    const binary = join(directory, process.platform === "win32" ? "access.exe" : "access");
    const source = fileURLToPath(new URL("../../src/runtime/http-access.ts", import.meta.url));
    writeFileSync(entry, `
      import { httpAccess } from ${JSON.stringify(source)};
      const req = (origin) => new Request("http://localhost:3117/ws", { headers: { origin } });
      console.log(JSON.stringify({
        mode: process.env.NODE_ENV,
        hostname: httpAccess.hostname,
        unlisted: httpAccess.authorize(req("http://unrelated.localhost:1355"))?.status,
        local: httpAccess.authorize(req("http://localhost:3117"))?.status ?? 200,
      }));
    `);
    execFileSync(process.execPath, ["build", "--compile", "--define", 'process.env.NODE_ENV="production"', entry, "--outfile", binary], {
      cwd: directory, stdio: "pipe", timeout: 45_000,
    });
    const env = { ...process.env };
    for (const key of ["NODE_ENV", "SERVER_HOST", "SERVER_PASSWORD", "SERVER_ALLOWED_ORIGINS"]) delete env[key];
    for (const runtimeEnv of [env, { ...env, NODE_ENV: "development" }]) {
      const output = execFileSync(binary, [], { env: runtimeEnv, cwd: directory, encoding: "utf8", timeout: 5000 });
      expect(JSON.parse(output)).toEqual({ mode: "production", hostname: "0.0.0.0", unlisted: 403, local: 200 });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
