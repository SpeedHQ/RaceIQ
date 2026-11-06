import { Writable } from "node:stream";

/** Keep dump backend alive until its recorder has durably finalized. */
export async function runDumpProcesses(serverCommand: string[], clientCommand: string[]): Promise<number> {
  const ready = Promise.withResolvers<void>();
  const server = Bun.spawn(serverCommand, {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    // Windows console Ctrl+C must not terminate the backend before IPC shutdown finishes.
    detached: process.platform === "win32",
    ipc(message: unknown) {
      if (message && typeof message === "object" && "type" in message && message.type === "shutdown-ready") ready.resolve();
    },
  });
  const output = Promise.all([
    server.stdout.pipeTo(Writable.toWeb(process.stdout), { preventClose: true }),
    server.stderr.pipeTo(Writable.toWeb(process.stderr), { preventClose: true }),
  ]);
  const serverReady = Promise.race([ready.promise.then(() => true), server.exited.then(() => false)]);
  let client: Bun.Subprocess | null = null;
  let stopping: Promise<number> | null = null;
  const stop = (): Promise<number> => stopping ??= (async () => {
    if (await serverReady && server.exitCode === null) server.send({ type: "shutdown" });
    const code = await server.exited;
    await output;
    if (client && client.exitCode === null) client.kill("SIGTERM");
    await client?.exited;
    return code;
  })();
  const onSignal = () => { void stop().catch(error => { console.error("[Dump] Shutdown failed:", error); process.exitCode = 1; }); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    client = Bun.spawn(clientCommand, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const first = await Promise.race([
      server.exited.then(code => ({ server: true, code })),
      client.exited.then(code => ({ server: false, code })),
    ]);
    const code = await stop();
    return !first.server && first.code !== 0 ? first.code : code;
  } catch (error) {
    await stop();
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

if (import.meta.main) {
  const gameId = process.argv[2];
  if (!gameId) throw new Error("Usage: bun scripts/dev/dump.ts <game-id>");
  process.exit(await runDumpProcesses(
    ["bun", "--env-file=.env.development", "run", "apps/backend/src/index.ts", `--record=${gameId}`, "--dump-only"],
    ["bun", "--env-file=.env.development", "scripts/dev/client.ts"],
  ));
}
