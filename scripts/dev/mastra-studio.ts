// Wrapper so portless can set PORT without shell-quoting issues (Windows-safe).
const port = process.env.PORT ?? "4111";

const proc = Bun.spawn(
  [
    "bunx",
    "mastra@1.19.0",
    "studio",
    "--port",
    port,
    "--server-host",
    "localhost",
    "--server-port",
    "3117",
    "--server-protocol",
    "http",
    "--server-api-prefix",
    "/studio-api",
  ],
  { stdio: ["inherit", "inherit", "inherit"] },
);

process.exit(await proc.exited);

export {};
