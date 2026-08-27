import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test } from "bun:test";
import { startHttpServer } from "../../server/runtime/http-server";

const servers: Array<{ stop(close?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("serves gzip static assets with content encoding", async () => {
  const staticDir = await mkdtemp(join(tmpdir(), "raceiq-http-server-"));
  await writeFile(join(staticDir, "demo-lap.json.gz"), gzipSync(JSON.stringify({ frames: [] })));
  const server = startHttpServer({
    app: { fetch: () => new Response("not found", { status: 404 }) },
    port: 0,
    staticDir,
    devPublicDir: null,
  });
  servers.push(server);

  const response = await fetch(`http://localhost:${server.port}/demo-lap.json.gz`);

  expect(response.headers.get("content-type")).toBe("application/gzip");
  expect(response.headers.get("content-encoding")).toBe("gzip");
});
