import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function emitParaglideDeclarations(clientRoot: string, outdir: string, signal?: AbortSignal): Promise<void> {
  const resolver = Bun.spawn(["bunx", "--no-install", "effect-tsgo", "get-exe-path"], {
    cwd: dirname(clientRoot), stdin: "ignore", stdout: "pipe", stderr: "inherit",
  });
  const executable = (await new Response(resolver.stdout).text()).trim();
  if (await resolver.exited !== 0 || !executable) throw new Error(`Could not resolve the native TypeScript compiler: ${executable}`);
  // A config file avoids exceeding Windows' command-line limit with message modules.
  const config = join(outdir, "tsconfig.declarations.json");
  await writeFile(config, JSON.stringify({
    compilerOptions: {
      allowJs: true, declaration: true, emitDeclarationOnly: true, skipLibCheck: true,
      target: "ESNext", module: "ESNext", moduleResolution: "bundler",
    },
    include: ["**/*.js"],
  }));
  const child = Bun.spawn([executable, "--project", config], {
    cwd: clientRoot, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const stop = () => child.kill();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    const status = await child.exited;
    if (status !== 0) throw new Error(`Paraglide declaration emission failed (${status})`);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    signal?.removeEventListener("abort", stop);
    await rm(config, { force: true });
  }
}
